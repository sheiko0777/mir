"""
Read-only threshold watcher for Uniswap Liquidity Launchpad buyback-and-burn.

Mechanism (BaseClaimRecipient / BuybackAndBurnClaimRecipient, Uniswap/liquidity-launcher):
  * FeeSplitter forwards LP fees and calls onAmountsReceived(tokenId, c0, c1).
  * claim(tokenId, ...) pays the caller the attributed currency0 (native) and
    currency1 (position token), then pulls `minCurrency1BurnAmount` currency1
    from the caller and sends it to 0xdead.
  So a caller needs no token inventory once attributed currency1 >= threshold.

This module answers, per tokenId, from event logs only:
  * attributed native / token balances (AmountsReceived - Claimed),
  * token accrual rate and estimated time until the threshold is reached,
  * who has been winning claims (competition census).

It never signs, sends, or simulates transactions. Attributed balances exclude
fees still inside the v4 position (uncollected), so the shortfall is an upper
bound. A READY status still requires a fork simulation before any decision.
"""

from __future__ import annotations

import argparse
import json
import os
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal
from typing import Any, Dict, Iterable, List, Optional

from services.common.keccak import event_topic
from services.common.networks import LAUNCHPAD as LAUNCHPAD_CONFIG, NETWORKS
from services.common.report import Provenance, build_report, write_report

SIG_AMOUNTS_RECEIVED = "AmountsReceived(uint256,uint256,uint256)"
SIG_CLAIMED = "Claimed(uint256,uint256,uint256,(address,address,uint24,int24,address))"
SIG_TOKENS_BURNED = "TokensBurned(uint256,address,uint256)"

TOPIC_AMOUNTS_RECEIVED = event_topic(SIG_AMOUNTS_RECEIVED)
TOPIC_CLAIMED = event_topic(SIG_CLAIMED)
TOPIC_TOKENS_BURNED = event_topic(SIG_TOKENS_BURNED)

WEI = 10 ** 18
DEFAULT_THRESHOLD_WEI = 500_000 * WEI  # minCurrency1BurnAmount; verify per deployment
SECONDS_PER_DAY = 86_400

STATUS_READY = "READY_NO_INVENTORY"      # attributed token >= threshold now
STATUS_APPROACHING = "APPROACHING"        # ETA within horizon at observed rate
STATUS_ACCRUING = "ACCRUING"              # accruing, ETA beyond horizon
STATUS_DORMANT = "DORMANT"                # no token accrual in the lookback window
STATUS_RATE_UNKNOWN = "RATE_UNKNOWN"      # accrual seen but no usable timestamps


class SourceUnavailable(Exception):
    """Raised when a data source refuses or challenges the request."""


# --------------------------------------------------------------------------- logs

@dataclass(frozen=True)
class Log:
    address: str
    topics: tuple
    data: str
    block_number: int
    tx_hash: str
    log_index: int
    timestamp: Optional[int] = None  # unix seconds, if the source provides it


def _hex_int(v: Any) -> int:
    if isinstance(v, int):
        return v
    s = str(v)
    return int(s, 16) if s.startswith("0x") else int(s)


def _parse_ts(v: Any) -> Optional[int]:
    if v is None:
        return None
    if isinstance(v, int):
        return v
    s = str(v)
    if s.startswith("0x"):
        return int(s, 16)
    if s.isdigit():
        return int(s)
    try:
        return int(datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp())
    except ValueError:
        return None


def normalize_log(raw: Dict[str, Any]) -> Log:
    """Accepts JSON-RPC eth_getLogs entries or Blockscout v2 /logs items."""
    if "blockNumber" in raw:  # JSON-RPC
        return Log(
            address=raw["address"].lower(),
            topics=tuple(t.lower() for t in raw["topics"] if t),
            data=raw.get("data", "0x"),
            block_number=_hex_int(raw["blockNumber"]),
            tx_hash=raw["transactionHash"].lower(),
            log_index=_hex_int(raw["logIndex"]),
            timestamp=_parse_ts(raw.get("blockTimestamp")),
        )
    address = raw["address"]["hash"] if isinstance(raw.get("address"), dict) else raw["address"]
    return Log(  # Blockscout v2
        address=address.lower(),
        topics=tuple(t.lower() for t in raw["topics"] if t),
        data=raw.get("data", "0x"),
        block_number=int(raw["block_number"]),
        tx_hash=raw["transaction_hash"].lower(),
        log_index=int(raw.get("index", raw.get("log_index", 0))),
        timestamp=_parse_ts(raw.get("block_timestamp") or raw.get("timestamp")),
    )


def _words(data: str) -> List[int]:
    h = data[2:] if data.startswith("0x") else data
    if len(h) % 64:
        raise ValueError("ABI data is not 32-byte aligned")
    return [int(h[i:i + 64], 16) for i in range(0, len(h), 64)]


def _addr(word: int) -> str:
    return "0x" + f"{word:064x}"[-40:]


# ------------------------------------------------------------------------- state

@dataclass
class PositionState:
    token_id: int
    received0: int = 0
    received1: int = 0
    claimed0: int = 0
    claimed1: int = 0
    burns: int = 0
    claims: int = 0
    currency1: Optional[str] = None
    accruals: List[tuple] = field(default_factory=list)  # (block, ts, amount1)
    last_block: int = 0

    @property
    def attributed0(self) -> int:
        return self.received0 - self.claimed0

    @property
    def attributed1(self) -> int:
        return self.received1 - self.claimed1


@dataclass
class ClaimEvent:
    token_id: int
    block_number: int
    tx_hash: str
    native_paid: int
    token_paid: int
    timestamp: Optional[int]


def replay(logs: Iterable[Log], recipient: str) -> tuple:
    """Replays recipient logs in chain order. Ignores other addresses/topics."""
    recipient = recipient.lower()
    positions: Dict[int, PositionState] = {}
    claims: List[ClaimEvent] = []
    seen = set()
    ordered = sorted(logs, key=lambda l: (l.block_number, l.log_index))
    for log in ordered:
        key = (log.tx_hash, log.log_index)
        if key in seen or log.address != recipient or not log.topics:
            continue
        seen.add(key)
        topic0 = log.topics[0]
        if topic0 not in (TOPIC_AMOUNTS_RECEIVED, TOPIC_CLAIMED, TOPIC_TOKENS_BURNED):
            continue
        token_id = int(log.topics[1], 16)
        pos = positions.setdefault(token_id, PositionState(token_id))
        pos.last_block = max(pos.last_block, log.block_number)
        w = _words(log.data)
        if topic0 == TOPIC_AMOUNTS_RECEIVED:
            pos.received0 += w[0]
            pos.received1 += w[1]
            if w[1]:
                pos.accruals.append((log.block_number, log.timestamp, w[1]))
        elif topic0 == TOPIC_CLAIMED:
            pos.claimed0 += w[0]
            pos.claimed1 += w[1]
            pos.claims += 1
            if len(w) >= 4:
                pos.currency1 = _addr(w[3])
            claims.append(ClaimEvent(token_id, log.block_number, log.tx_hash, w[0], w[1], log.timestamp))
        else:
            pos.burns += 1
            if len(log.topics) > 2:
                pos.currency1 = _addr(int(log.topics[2], 16))
    for pos in positions.values():
        if pos.attributed0 < 0 or pos.attributed1 < 0:
            raise ValueError(f"tokenId {pos.token_id}: claimed exceeds received; log window incomplete")
    return positions, claims


# ---------------------------------------------------------------------- analysis

def accrual_rate_per_day(pos: PositionState, now_ts: int, lookback_days: int) -> Optional[Decimal]:
    """Token wei per day over the lookback window; None if timestamps are missing."""
    start = now_ts - lookback_days * SECONDS_PER_DAY
    window = [(ts, amt) for _, ts, amt in pos.accruals if ts is None or ts >= start]
    if any(ts is None for ts, _ in window):
        return None
    total = sum(amt for _, amt in window)
    return Decimal(total) / Decimal(lookback_days)


def classify(pos: PositionState, threshold: int, now_ts: Optional[int],
             lookback_days: int, horizon_days: int) -> Dict[str, Any]:
    shortfall = max(0, threshold - pos.attributed1)
    rate = None if now_ts is None else accrual_rate_per_day(pos, now_ts, lookback_days)
    eta_days: Optional[Decimal] = None
    if shortfall == 0:
        status = STATUS_READY
        eta_days = Decimal(0)
    elif rate is None:
        status = STATUS_RATE_UNKNOWN
    elif rate == 0:
        status = STATUS_DORMANT
    else:
        eta_days = Decimal(shortfall) / rate
        status = STATUS_APPROACHING if eta_days <= horizon_days else STATUS_ACCRUING
    return {
        "token_id": pos.token_id,
        "currency1": pos.currency1,
        "status": status,
        "attributed_native_wei": str(pos.attributed0),
        "attributed_token_wei": str(pos.attributed1),
        "threshold_wei": str(threshold),
        "shortfall_token_wei": str(shortfall),
        "progress_pct": f"{min(Decimal(100), Decimal(pos.attributed1) * 100 / threshold):.2f}",
        "accrual_token_wei_per_day": None if rate is None else str(rate.quantize(Decimal(1))),
        "eta_days": None if eta_days is None else f"{eta_days:.2f}",
        "claims": pos.claims,
        "burns": pos.burns,
        "last_block": pos.last_block,
    }


def competition_census(claims: List[ClaimEvent], tx_meta: Dict[str, Dict[str, str]]) -> Dict[str, Any]:
    """Who wins claims. `tx_meta` maps tx_hash -> {"from":..., "to":...}.
    The executor is the tx `to` (claim requires a contract caller); `from` is the EOA."""
    executors: Counter = Counter()
    senders: Counter = Counter()
    unknown = 0
    native_by_executor: Dict[str, int] = defaultdict(int)
    for c in claims:
        meta = tx_meta.get(c.tx_hash)
        if not meta:
            unknown += 1
            continue
        ex = (meta.get("to") or "unknown").lower()
        executors[ex] += 1
        senders[(meta.get("from") or "unknown").lower()] += 1
        native_by_executor[ex] += c.native_paid
    known = sum(executors.values())
    top_share = None
    if known:
        top_share = f"{Decimal(executors.most_common(1)[0][1]) * 100 / known:.1f}"
    return {
        "claims_total": len(claims),
        "claims_with_tx_meta": known,
        "claims_unattributed": unknown,
        "distinct_executors": len(executors),
        "distinct_senders": len(senders),
        "top_executor_share_pct": top_share,
        "executors": [
            {"executor": ex, "claims": n, "native_received_wei": str(native_by_executor[ex])}
            for ex, n in executors.most_common()
        ],
    }


def analyze(raw_logs: List[Dict[str, Any]], network: str, provenance: Provenance,
                 source: str, tx_meta: Optional[Dict[str, Dict[str, str]]] = None,
                 now_ts: Optional[int] = None, threshold_wei: int = DEFAULT_THRESHOLD_WEI,
                 lookback_days: int = 14, horizon_days: int = 7) -> Dict[str, Any]:
    cfg = LAUNCHPAD_CONFIG[network]
    logs = [normalize_log(r) for r in raw_logs]
    positions, claims = replay(logs, cfg["recipient"])
    if now_ts is None:
        stamped = [l.timestamp for l in logs if l.timestamp is not None]
        now_ts = max(stamped) if stamped else None
    rows = [classify(p, threshold_wei, now_ts, lookback_days, horizon_days) for p in positions.values()]
    order = {STATUS_READY: 0, STATUS_APPROACHING: 1, STATUS_ACCRUING: 2, STATUS_RATE_UNKNOWN: 3, STATUS_DORMANT: 4}
    rows.sort(key=lambda r: (order[r["status"]], -int(r["attributed_token_wei"])))
    blocks = [l.block_number for l in logs]
    return {
        "network": network,
        "chain_id": NETWORKS[network].chain_id,
        "recipient": cfg["recipient"],
        "source": source,
        "as_of_ts": now_ts,
        "block_range": [min(blocks), max(blocks)] if blocks else None,
        "logs_used": len(logs),
        "threshold_wei": str(threshold_wei),
        "lookback_days": lookback_days,
        "horizon_days": horizon_days,
        "status_counts": dict(Counter(r["status"] for r in rows)),
        "positions": rows,
        "competition": competition_census(claims, tx_meta or {}),
        "caveats": [
            "Attributed balances exclude fees still inside the v4 position; shortfall is an upper bound.",
            "READY means no token inventory is needed at the attributed balance; it is not a profit "
            "claim. Gas, competition and a fork simulation of collectFees + claim are still required.",
            "ETA assumes the lookback accrual rate continues; launch-token fee flow is bursty.",
            "threshold_wei assumes minCurrency1BurnAmount = 500,000 * 1e18; read it from the "
            "deployed contract before relying on it.",
        ],
    }


def render_markdown(report: Dict[str, Any], limit: int = 25) -> str:
    def tok(w: str) -> str:
        return f"{Decimal(w) / WEI:,.0f}"

    c = report["competition"]
    lines = [
        f"# Launchpad threshold watch — {report['network']}",
        "",
        f"- Source: {report['source']}; block range: {report['block_range']}; logs: {report['logs_used']}",
        f"- Threshold: {tok(report['threshold_wei'])} tokens; lookback {report['lookback_days']}d; "
        f"horizon {report['horizon_days']}d",
        f"- Status counts: {report['status_counts']}",
        "",
        "## Positions closest to the no-inventory threshold",
        "| tokenId | Status | Attributed tokens | Progress | Shortfall | Tokens/day | ETA days | Attributed native | Claims |",
        "| :--- | :--- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ]
    for r in report["positions"][:limit]:
        rate = r["accrual_token_wei_per_day"]
        lines.append(
            f"| {r['token_id']} | `{r['status']}` | {tok(r['attributed_token_wei'])} | {r['progress_pct']}% | "
            f"{tok(r['shortfall_token_wei'])} | {'UNKNOWN' if rate is None else tok(rate)} | "
            f"{r['eta_days'] or 'UNKNOWN'} | {Decimal(r['attributed_native_wei']) / WEI:.6f} | {r['claims']} |"
        )
    lines += [
        "",
        "## Competition census",
        f"- Claims: {c['claims_total']} (with tx sender data: {c['claims_with_tx_meta']}, "
        f"unattributed: {c['claims_unattributed']})",
        f"- Distinct executors: {c['distinct_executors']}; distinct senders: {c['distinct_senders']}; "
        f"top executor share: {c['top_executor_share_pct'] or 'UNKNOWN'}%",
        "",
        "## Caveats",
    ] + [f"- {x}" for x in report["caveats"]]
    return "\n".join(lines) + "\n"


# ----------------------------------------------------------------------- fetching

def _get_json(url: str, body: Optional[bytes] = None, timeout: int = 20) -> Any:
    req = urllib.request.Request(
        url, data=body,
        headers={"User-Agent": "opportunity-radar/0.1", "Content-Type": "application/json",
                 "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read(4 * 1024 * 1024)
    except urllib.error.HTTPError as e:
        raise SourceUnavailable(f"{url}: HTTP {e.code}") from e
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        raise SourceUnavailable(f"{url}: {e}") from e
    try:
        return json.loads(raw)
    except ValueError as e:
        # e.g. a bot-challenge HTML page. Do not try to bypass it.
        raise SourceUnavailable(f"{url}: non-JSON response (challenge or error page)") from e


def fetch_blockscout_logs(network: str, max_pages: int = 50) -> List[Dict[str, Any]]:
    base = NETWORKS[network].explorer_api_url
    recipient = LAUNCHPAD_CONFIG[network]["recipient"]
    items: List[Dict[str, Any]] = []
    params = ""
    for _ in range(max_pages):
        page = _get_json(f"{base}/addresses/{recipient}/logs{params}")
        items.extend(page.get("items", []))
        nxt = page.get("next_page_params")
        if not nxt:
            return items
        params = "?" + "&".join(f"{k}={v}" for k, v in nxt.items())
    raise SourceUnavailable(f"more than {max_pages} pages; window incomplete")


def fetch_rpc_logs(rpc_url: str, network: str, from_block: int, to_block: int,
                   chunk: int = 10_000) -> List[Dict[str, Any]]:
    recipient = LAUNCHPAD_CONFIG[network]["recipient"]
    chain = _get_json(rpc_url, json.dumps({"jsonrpc": "2.0", "id": 1, "method": "eth_chainId", "params": []}).encode())
    if _hex_int(chain.get("result", "0x0")) != NETWORKS[network].chain_id:
        raise SourceUnavailable(f"RPC chain id {chain.get('result')} != expected {NETWORKS[network].chain_id}")
    out: List[Dict[str, Any]] = []
    topics = [[TOPIC_AMOUNTS_RECEIVED, TOPIC_CLAIMED, TOPIC_TOKENS_BURNED]]
    for start in range(from_block, to_block + 1, chunk):
        end = min(to_block, start + chunk - 1)
        body = {"jsonrpc": "2.0", "id": 1, "method": "eth_getLogs",
                "params": [{"address": recipient, "fromBlock": hex(start), "toBlock": hex(end), "topics": topics}]}
        resp = _get_json(rpc_url, json.dumps(body).encode())
        if "error" in resp:
            raise SourceUnavailable(f"eth_getLogs {start}-{end}: {resp['error']}")
        out.extend(resp["result"])
    return out


# ---------------------------------------------------------------------------- CLI

STALE_AFTER_SECONDS = 6 * 3600
TITLE = "Launchpad buyback-and-burn threshold watch"


def service_id(network: str) -> str:
    return f"launchpad-watch-{network.lower()}"


def envelope(payload: Dict[str, Any], network: str, provenance: Provenance) -> Dict[str, Any]:
    counts = payload["status_counts"]
    comp = payload["competition"]
    summary = {
        "positions": len(payload["positions"]),
        "ready": counts.get(STATUS_READY, 0),
        "approaching": counts.get(STATUS_APPROACHING, 0),
        "claims": comp["claims_total"],
        "topExecutorSharePct": comp["top_executor_share_pct"],
    }
    return build_report(service_id(network), f"{TITLE} ({network})", provenance,
                        STALE_AFTER_SECONDS, payload, summary=summary, caveats=payload["caveats"])


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Read-only Launchpad threshold watcher")
    p.add_argument("--network", default="ARC", choices=sorted(LAUNCHPAD_CONFIG))
    src = p.add_mutually_exclusive_group(required=True)
    src.add_argument("--logs", help="Saved logs JSON (list, or {'items': [...]}); replayed as PINNED_FIXTURE")
    src.add_argument("--blockscout", action="store_true", help="Fetch recipient logs from the Blockscout v2 API")
    src.add_argument("--rpc-url", help="JSON-RPC endpoint (never commit a URL that embeds a key)")
    p.add_argument("--from-block", type=int)
    p.add_argument("--to-block", type=int)
    p.add_argument("--tx-meta", help="JSON map tx_hash -> {from, to} for the competition census")
    p.add_argument("--lookback-days", type=int, default=14)
    p.add_argument("--horizon-days", type=int, default=7)
    p.add_argument("--out-dir", default=os.path.join("data", "services"))
    a = p.parse_args(argv)

    try:
        if a.logs:
            with open(a.logs, encoding="utf-8") as f:
                loaded = json.load(f)
            raw = loaded["items"] if isinstance(loaded, dict) else loaded
            prov, source = Provenance.PINNED_FIXTURE, f"file:{os.path.basename(a.logs)}"
        elif a.blockscout:
            raw = fetch_blockscout_logs(a.network)
            prov, source = Provenance.CHAIN_OBSERVED, "blockscout-v2"
        else:
            if a.from_block is None or a.to_block is None:
                p.error("--rpc-url needs --from-block and --to-block")
            raw = fetch_rpc_logs(a.rpc_url, a.network, a.from_block, a.to_block)
            prov, source = Provenance.CHAIN_OBSERVED, "json-rpc"
    except SourceUnavailable as e:
        # Record the failed attempt separately; never overwrite the last good report
        # and never write a report that looks like data. The reason is not stored
        # verbatim because an RPC URL may embed a key.
        failed = build_report(service_id(a.network), f"{TITLE} ({a.network})", Provenance.CHAIN_OBSERVED,
                              STALE_AFTER_SECONDS, {"reason": "source refused, challenged or unreachable"},
                              status="source-unavailable")
        write_report(failed, a.out_dir, "last-attempt.json")
        print(f"SOURCE_UNAVAILABLE: {type(e).__name__}")
        return 2

    tx_meta = None
    if a.tx_meta:
        with open(a.tx_meta, encoding="utf-8") as f:
            tx_meta = {k.lower(): v for k, v in json.load(f).items()}

    payload = analyze(raw, a.network, prov, source, tx_meta=tx_meta,
                      lookback_days=a.lookback_days, horizon_days=a.horizon_days)
    path = write_report(envelope(payload, a.network, prov), a.out_dir)
    with open(os.path.join(os.path.dirname(path), "latest.md"), "w", encoding="utf-8") as f:
        f.write(render_markdown(payload))
    print(f"{payload['status_counts']} -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
