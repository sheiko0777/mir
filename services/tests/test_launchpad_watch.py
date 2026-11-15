"""
Tests for the read-only Launchpad threshold watcher.
All logs here are SYNTHETIC, built in-test from the real event ABIs; they are
not chain observations.
"""

import json
import os
import tempfile
import unittest

from services import launchpad_watch as lw
from services.common.keccak import event_topic, keccak256
from services.common.networks import LAUNCHPAD as LAUNCHPAD_CONFIG
from services.common.report import Provenance, validate_report

RECIPIENT = LAUNCHPAD_CONFIG["ARC"]["recipient"].lower()
TOKEN = "0x" + "ab" * 20
DAY = 86_400
T0 = 1_760_000_000
WEI = 10 ** 18


def _w(v: int) -> str:
    return f"{v:064x}"


def _topic_id(token_id: int) -> str:
    return "0x" + _w(token_id)


def rpc_log(topic0, token_id, data_words, block, idx, ts, extra_topics=(), address=RECIPIENT, tx=None):
    return {
        "address": address,
        "topics": [topic0, _topic_id(token_id), *extra_topics],
        "data": "0x" + "".join(_w(x) for x in data_words),
        "blockNumber": hex(block),
        "transactionHash": tx or "0x" + _w(block * 1000 + idx),
        "logIndex": hex(idx),
        "blockTimestamp": hex(ts),
    }


def received(token_id, native, tokens, block, ts, idx=0):
    return rpc_log(lw.TOPIC_AMOUNTS_RECEIVED, token_id, [native, tokens], block, idx, ts)


def claimed(token_id, native, tokens, block, ts, idx=1, tx=None):
    pool_key = [0, int(TOKEN, 16), 10_000, 200, 0]
    return rpc_log(lw.TOPIC_CLAIMED, token_id, [native, tokens, *pool_key], block, idx, ts, tx=tx)


def burned(token_id, block, ts, idx=2, tx=None):
    return rpc_log(lw.TOPIC_TOKENS_BURNED, token_id, [500_000 * WEI], block, idx, ts,
                   extra_topics=("0x" + _w(int(TOKEN, 16)),), tx=tx)


class TestKeccak(unittest.TestCase):
    def test_known_vectors(self):
        self.assertEqual(keccak256(b"").hex(),
                         "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        self.assertEqual(event_topic("Transfer(address,address,uint256)"),
                         "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef")

    def test_rate_boundary_lengths_do_not_crash(self):
        for n in (134, 135, 136, 137, 272):
            self.assertEqual(len(keccak256(b"x" * n)), 32)


class TestReplay(unittest.TestCase):
    def test_attributed_balances_and_ignored_noise(self):
        logs = [
            received(7, 2 * WEI, 300_000 * WEI, 10, T0),
            received(7, 1 * WEI, 100_000 * WEI, 11, T0 + DAY),
            # same log delivered twice must not double count
            received(7, 1 * WEI, 100_000 * WEI, 11, T0 + DAY),
            # other contract emitting the same topic is ignored
            rpc_log(lw.TOPIC_AMOUNTS_RECEIVED, 7, [9 * WEI, 9 * WEI], 12, 0, T0, address="0x" + "11" * 20),
        ]
        positions, claims = lw.replay([lw.normalize_log(l) for l in logs], RECIPIENT)
        p = positions[7]
        self.assertEqual(p.attributed0, 3 * WEI)
        self.assertEqual(p.attributed1, 400_000 * WEI)
        self.assertEqual(claims, [])

    def test_claim_resets_and_captures_token(self):
        logs = [received(5, WEI, 600_000 * WEI, 10, T0), claimed(5, WEI, 600_000 * WEI, 20, T0 + DAY),
                burned(5, 20, T0 + DAY)]
        positions, claims = lw.replay([lw.normalize_log(l) for l in logs], RECIPIENT)
        self.assertEqual(positions[5].attributed1, 0)
        self.assertEqual(positions[5].claims, 1)
        self.assertEqual(positions[5].burns, 1)
        self.assertEqual(positions[5].currency1, TOKEN)
        self.assertEqual(len(claims), 1)

    def test_incomplete_window_is_rejected(self):
        logs = [claimed(5, WEI, 10 * WEI, 20, T0)]
        with self.assertRaises(ValueError):
            lw.replay([lw.normalize_log(l) for l in logs], RECIPIENT)

    def test_blockscout_format(self):
        item = {
            "address": {"hash": RECIPIENT},
            "topics": [lw.TOPIC_AMOUNTS_RECEIVED, _topic_id(3), None, None],
            "data": "0x" + _w(WEI) + _w(50 * WEI),
            "block_number": 42, "transaction_hash": "0x" + "cd" * 32, "index": 4,
        }
        log = lw.normalize_log(item)
        self.assertEqual(log.block_number, 42)
        self.assertEqual(log.timestamp, None)
        positions, _ = lw.replay([log], RECIPIENT)
        self.assertEqual(positions[3].attributed1, 50 * WEI)


class TestClassification(unittest.TestCase):
    def _report(self, logs, **kw):
        return lw.analyze(logs, "ARC", Provenance.PINNED_FIXTURE, "synthetic", **kw)

    def test_statuses(self):
        now = T0 + 14 * DAY
        logs = [
            # READY: already over threshold
            received(1, WEI, 520_000 * WEI, 10, now - DAY),
            # APPROACHING: 400k + 140k/14d = 10k/day, shortfall 100k -> 10 days... use 30k/day
            received(2, WEI, 80_000 * WEI, 11, now - 20 * DAY),
            received(2, WEI, 420_000 * WEI - 80_000 * WEI, 12, now - 13 * DAY),  # 340k in window
            # DORMANT: only old accrual
            received(3, WEI, 100_000 * WEI, 13, now - 30 * DAY),
            # ACCRUING slowly
            received(4, WEI, 14_000 * WEI, 14, now - 2 * DAY),
        ]
        rep = self._report(logs, now_ts=now)
        by_id = {r["token_id"]: r for r in rep["positions"]}
        self.assertEqual(by_id[1]["status"], lw.STATUS_READY)
        self.assertEqual(by_id[1]["shortfall_token_wei"], "0")
        # token 2: attributed 420k, shortfall 80k, rate 340k/14 ≈ 24.3k/day -> ETA ≈ 3.29 days
        self.assertEqual(by_id[2]["status"], lw.STATUS_APPROACHING)
        self.assertEqual(by_id[2]["eta_days"], "3.29")
        self.assertEqual(by_id[3]["status"], lw.STATUS_DORMANT)
        # token 4: 1k/day, shortfall 486k -> 486 days
        self.assertEqual(by_id[4]["status"], lw.STATUS_ACCRUING)
        self.assertEqual(by_id[4]["eta_days"], "486.00")
        self.assertEqual(rep["positions"][0]["token_id"], 1)  # READY sorts first

    def test_missing_timestamps_give_unknown_rate_not_zero(self):
        item = {
            "address": {"hash": RECIPIENT},
            "topics": [lw.TOPIC_AMOUNTS_RECEIVED, _topic_id(9)],
            "data": "0x" + _w(WEI) + _w(10 * WEI),
            "block_number": 1, "transaction_hash": "0x" + "ee" * 32, "index": 0,
        }
        rep = self._report([item], now_ts=T0)
        row = rep["positions"][0]
        self.assertEqual(row["status"], lw.STATUS_RATE_UNKNOWN)
        self.assertIsNone(row["eta_days"])
        self.assertIsNone(row["accrual_token_wei_per_day"])


class TestCompetitionCensus(unittest.TestCase):
    def test_concentration(self):
        logs = [received(i, WEI, 500_000 * WEI, 10 + i, T0) for i in range(1, 6)]
        txs = []
        for i in range(1, 6):
            tx = "0x" + _w(9000 + i)
            txs.append(tx)
            logs.append(claimed(i, WEI, 500_000 * WEI, 100 + i, T0 + DAY, tx=tx))
        meta = {txs[i]: {"from": "0x" + "a1" * 20, "to": "0x" + "e1" * 20} for i in range(4)}
        rep = lw.analyze(logs, "ARC", Provenance.PINNED_FIXTURE, "synthetic", tx_meta=meta, now_ts=T0 + DAY)
        c = rep["competition"]
        self.assertEqual(c["claims_total"], 5)
        self.assertEqual(c["claims_with_tx_meta"], 4)
        self.assertEqual(c["claims_unattributed"], 1)
        self.assertEqual(c["distinct_executors"], 1)
        self.assertEqual(c["top_executor_share_pct"], "100.0")

    def test_no_meta_means_unknown_share(self):
        rep = lw.analyze([received(1, WEI, WEI, 1, T0)], "ARC", Provenance.PINNED_FIXTURE, "synthetic")
        self.assertIsNone(rep["competition"]["top_executor_share_pct"])


class TestCli(unittest.TestCase):
    def test_file_replay_writes_valid_envelope_tagged_fixture(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "logs.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump([received(1, WEI, 250_000 * WEI, 10, T0)], f)
            out = os.path.join(d, "services")
            self.assertEqual(lw.main(["--logs", path, "--out-dir", out]), 0)
            with open(os.path.join(out, "launchpad-watch-arc", "latest.json"), encoding="utf-8") as f:
                rep = json.load(f)
            with open(os.path.join(out, "launchpad-watch-arc", "latest.md"), encoding="utf-8") as f:
                md = f.read()
        self.assertEqual(validate_report(rep), [])
        self.assertEqual(rep["service"], "launchpad-watch-arc")
        self.assertEqual(rep["provenance"], "PINNED_FIXTURE")
        self.assertIs(rep["executionEnabled"], False)
        self.assertEqual(rep["summary"]["positions"], 1)
        self.assertEqual(rep["data"]["positions"][0]["progress_pct"], "50.00")
        self.assertIn("Competition census", md)

    def test_unavailable_source_records_attempt_and_keeps_last_good_report(self):
        orig = lw.fetch_blockscout_logs

        def boom(*_a, **_k):
            raise lw.SourceUnavailable("https://rpc.example/v2/SECRETKEY: HTTP 403")
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "logs.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump([received(1, WEI, 250_000 * WEI, 10, T0)], f)
            self.assertEqual(lw.main(["--logs", path, "--out-dir", d]), 0)
            good = os.path.join(d, "launchpad-watch-arc", "latest.json")
            with open(good, encoding="utf-8") as f:
                before = f.read()
            lw.fetch_blockscout_logs = boom
            try:
                self.assertEqual(lw.main(["--blockscout", "--out-dir", d]), 2)
            finally:
                lw.fetch_blockscout_logs = orig
            with open(good, encoding="utf-8") as f:
                self.assertEqual(f.read(), before)
            with open(os.path.join(d, "launchpad-watch-arc", "last-attempt.json"), encoding="utf-8") as f:
                raw = f.read()
        attempt = json.loads(raw)
        self.assertEqual(validate_report(attempt), [])
        self.assertEqual(attempt["status"], "source-unavailable")
        self.assertNotIn("SECRETKEY", raw)

    def test_non_json_response_is_unavailable(self):
        class Resp:
            def __enter__(self): return self
            def __exit__(self, *a): return False
            def read(self, *_): return b"<!DOCTYPE html><title>Just a moment...</title>"
        orig = lw.urllib.request.urlopen
        lw.urllib.request.urlopen = lambda *a, **k: Resp()
        try:
            with self.assertRaises(lw.SourceUnavailable):
                lw._get_json("https://example.invalid/x")
        finally:
            lw.urllib.request.urlopen = orig


if __name__ == "__main__":
    unittest.main()
