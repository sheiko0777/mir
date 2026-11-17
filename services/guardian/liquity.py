"""Turns a saved Liquity V2 WETH position screen into Guardian assessments.

Input is the JSON document produced by tools/research/liquity_screen.py
(kind 'liquity-weth-position-screen'). This module only reads that document;
it makes no network calls and does not import the screen, so the service layer
has no third-party dependencies.

The screen samples the sorted active-trove list (at most 128 troves, ordered
by interest rate, zombies excluded). It is not every position in the branch.
"""

from __future__ import annotations

import argparse
import json
import os
import time
from collections import Counter
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from services.common.report import Provenance, build_report, write_report
from services.guardian.risk import (
    LEVEL_UNKNOWN, SEVERITY, Thresholds, assess_collateral_ratio, price_drop_percent, worst,
)

SERVICE = "guardian-liquity-weth"
TITLE = "Position Guardian: Liquity V2 WETH"
SCREEN_KIND = "liquity-weth-position-screen"
STALE_AFTER_SECONDS = 900


class InvalidScreen(ValueError):
    pass


def _uint(value: Any, name: str) -> int:
    if not isinstance(value, str) or not value.isdigit():
        raise InvalidScreen(f"{name} is not a decimal integer string")
    return int(value)


def assess_screen(screen: Dict[str, Any], thresholds: Thresholds = Thresholds(),
                  now: Optional[int] = None, watch: Optional[List[str]] = None) -> Dict[str, Any]:
    """Returns the Guardian payload for a screen document.
    `now` (unix seconds) enables the stale-data check; `watch` limits output to trove IDs."""
    if not isinstance(screen, dict) or screen.get("kind") != SCREEN_KIND or screen.get("schemaVersion") != 1:
        raise InvalidScreen("not a liquity-weth-position-screen v1 document")
    if screen.get("executionEnabled") is not False:
        raise InvalidScreen("screen must have executionEnabled false")
    block_ms = screen.get("blockTimestampMs")
    if not isinstance(block_ms, int) or isinstance(block_ms, bool) or block_ms <= 0:
        raise InvalidScreen("blockTimestampMs missing")
    observed_at = block_ms // 1000
    mcr = _uint(screen.get("mcrAtomic"), "mcrAtomic")

    base = {
        "protocol": "liquity-v2", "branch": "WETH", "chainId": screen.get("chainId"),
        "blockNumber": screen.get("blockNumber"), "blockHash": screen.get("blockHash"),
        "observedAtSeconds": observed_at, "mcrAtomic": str(mcr),
        "thresholdsBps": {"watch": thresholds.watch_bps, "danger": thresholds.danger_bps,
                          "critical": thresholds.critical_bps},
    }
    if screen.get("status") == "branch-shutdown":
        # After shutdown the normal liquidation rule no longer describes the risk.
        return {**base, "status": "branch-shutdown", "priceAtomic": None, "positions": [],
                "levelCounts": {}, "worstLevel": None, "positionsAssessed": 0, "coverage": screen.get("coverage")}

    oracle = screen.get("oracle") or {}
    price = _uint(oracle["priceAtomic"], "oracle.priceAtomic") if oracle.get("valid") and oracle.get("priceAtomic") else None
    wanted = set(watch) if watch else None
    rows = []
    for position in screen.get("positions") or []:
        trove_id = position.get("troveId")
        if wanted is not None and trove_id not in wanted:
            continue
        a = assess_collateral_ratio(
            _uint(position.get("entireCollAtomic"), "entireCollAtomic"),
            _uint(position.get("entireDebtAtomic"), "entireDebtAtomic"),
            price, mcr, thresholds, observed_at=observed_at, now=now)
        rows.append({
            "troveId": trove_id, "level": a.level, "distanceBps": a.distance_bps,
            "priceDropPercent": price_drop_percent(a),
            "liquidationPriceAtomic": None if a.liquidation_price is None else str(a.liquidation_price),
            "reasons": list(a.reasons),
        })
    missing = sorted(wanted - {r["troveId"] for r in rows}) if wanted else []
    rows.sort(key=lambda r: (r["level"] == LEVEL_UNKNOWN, -SEVERITY.get(r["level"], 0),
                             r["distanceBps"] if r["distanceBps"] is not None else 10 ** 9))
    return {
        **base, "status": "assessed" if price is not None else "oracle-invalid",
        "priceAtomic": None if price is None else str(price),
        "oracleReasons": list(oracle.get("reasons") or []),
        "positions": rows, "positionsAssessed": len(rows),
        "levelCounts": dict(Counter(r["level"] for r in rows)),
        "worstLevel": worst([r["level"] for r in rows]),
        "watchNotInSample": missing,
        "coverage": screen.get("coverage"),
    }


CAVEATS = [
    "Informational only. Not financial advice and not a guarantee that an alert precedes a liquidation.",
    "Prices can gap between observations; the oracle may move before the next reading.",
    "Covers a sample of the sorted active-trove list (at most 128), not every position; zombie troves are excluded.",
    "A trove ID missing from the sample is reported as not in sample. That is not the same as safe.",
    "Redemptions can also reduce a trove's collateral and are not modelled here.",
]


def envelope(payload: Dict[str, Any], provenance: Provenance) -> Dict[str, Any]:
    counts = payload["levelCounts"]
    summary = {
        "positions": payload["positionsAssessed"], "worstLevel": payload["worstLevel"],
        "liquidatable": counts.get("LIQUIDATABLE", 0), "critical": counts.get("CRITICAL", 0),
        "danger": counts.get("DANGER", 0), "watch": counts.get("WATCH", 0),
        "unknown": counts.get("UNKNOWN", 0),
    }
    observed = datetime.fromtimestamp(payload["observedAtSeconds"], timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    status = "ok" if payload["status"] == "assessed" else "incomplete"
    # generatedAt is the block time of the observation, so staleness tracks the data's age.
    return build_report(SERVICE, TITLE, provenance, STALE_AFTER_SECONDS, payload,
                        summary=summary, caveats=CAVEATS, status=status, generated_at=observed)


def main(argv: Optional[List[str]] = None) -> int:
    p = argparse.ArgumentParser(description="Position Guardian for a saved Liquity V2 WETH screen (read-only)")
    p.add_argument("--screen", required=True, help="JSON written by tools/research/liquity_screen.py")
    p.add_argument("--watch", help="Comma-separated trove IDs to report; default is every sampled trove")
    p.add_argument("--now", type=int, help="Unix seconds for the stale-data check; default is the current time")
    p.add_argument("--out-dir", default=os.path.join("data", "services"))
    a = p.parse_args(argv)
    with open(a.screen, encoding="utf-8") as f:
        document = json.load(f)
    screen = document.get("result", document) if isinstance(document, dict) else document
    now = a.now if a.now is not None else int(time.time())
    try:
        payload = assess_screen(screen, now=now, watch=a.watch.split(",") if a.watch else None)
    except InvalidScreen as e:
        print(f"INVALID_SCREEN: {e}")
        return 2
    path = write_report(envelope(payload, Provenance.PINNED_FIXTURE), a.out_dir)
    print(f"{payload['status']} {payload['levelCounts']} -> {path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
