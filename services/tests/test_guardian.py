"""Tests for the Position Guardian risk model, alert policy and Liquity adapter.
All positions here are synthetic."""

import json
import os
import tempfile
import unittest

from services.common.report import validate_report
from services.guardian import liquity
from services.guardian.risk import (
    ALERT_DATA_RESTORED, ALERT_DATA_UNAVAILABLE, ALERT_ESCALATED, ALERT_RECOVERED, ALERT_REMINDER,
    LEVEL_CRITICAL, LEVEL_DANGER, LEVEL_LIQUIDATABLE, LEVEL_NO_DEBT, LEVEL_SAFE, LEVEL_UNKNOWN,
    LEVEL_WATCH, REASON_DATA_STALE, REASON_INVALID_INPUT, REASON_PRICE_UNKNOWN, REASON_ZERO_COLLATERAL,
    SCALE, AlertState, Assessment, Thresholds, assess_collateral_ratio, assess_health_factor,
    decide_alert, price_drop_percent, worst,
)

MCR = 11 * SCALE // 10          # 110%, Liquity V2 WETH branch
PRICE = 3000 * SCALE             # 3000 BOLD per ETH
ETH = SCALE


def debt_for_distance(distance_bps, coll=10 * ETH, price=PRICE, mcr=MCR):
    """Debt that puts the liquidation price `distance_bps` below `price`."""
    liq_price = price * (10_000 - distance_bps) // 10_000
    return coll * liq_price // mcr


class TestCollateralRatio(unittest.TestCase):
    def test_exact_boundary_matches_protocol_rule(self):
        # ICR == MCR exactly is not liquidatable; one wei more debt is.
        coll, price = 11 * ETH, 1000 * SCALE
        debt = coll * price // MCR      # 10_000 BOLD: ICR exactly 110%
        a = assess_collateral_ratio(coll, debt, price, MCR)
        self.assertNotEqual(a.level, LEVEL_LIQUIDATABLE)
        self.assertEqual(a.distance_bps, 0)
        b = assess_collateral_ratio(coll, debt + 1, price, MCR)
        self.assertEqual(b.level, LEVEL_LIQUIDATABLE)

    def test_levels_follow_distance(self):
        cases = [(4000, LEVEL_SAFE), (2000, LEVEL_WATCH), (800, LEVEL_DANGER), (200, LEVEL_CRITICAL)]
        for distance, level in cases:
            with self.subTest(distance=distance):
                a = assess_collateral_ratio(10 * ETH, debt_for_distance(distance), PRICE, MCR)
                self.assertEqual(a.level, level)
                self.assertAlmostEqual(a.distance_bps, distance, delta=1)
                self.assertLess(a.liquidation_price, PRICE)

    def test_liquidation_price_is_the_highest_still_liquidatable_price(self):
        coll, debt = 10 * ETH, 20_000 * SCALE
        a = assess_collateral_ratio(coll, debt, PRICE, MCR)
        lp = a.liquidation_price
        self.assertLess(coll * lp // debt, MCR)
        self.assertGreaterEqual(coll * (lp + 1) // debt, MCR)

    def test_no_debt(self):
        a = assess_collateral_ratio(10 * ETH, 0, None, MCR)
        self.assertEqual(a.level, LEVEL_NO_DEBT)

    def test_unknown_price_is_never_safe(self):
        a = assess_collateral_ratio(10 * ETH, 1000 * SCALE, None, MCR)
        self.assertEqual(a.level, LEVEL_UNKNOWN)
        self.assertEqual(a.reasons, (REASON_PRICE_UNKNOWN,))
        self.assertIsNone(a.distance_bps)
        self.assertIsNone(price_drop_percent(a))

    def test_stale_and_future_data_are_unknown(self):
        t = Thresholds()
        debt = debt_for_distance(5000)
        old = assess_collateral_ratio(10 * ETH, debt, PRICE, MCR, observed_at=1000, now=1000 + t.max_data_age_seconds + 1)
        self.assertEqual((old.level, old.reasons), (LEVEL_UNKNOWN, (REASON_DATA_STALE,)))
        future = assess_collateral_ratio(10 * ETH, debt, PRICE, MCR, observed_at=2000, now=1000)
        self.assertEqual(future.level, LEVEL_UNKNOWN)
        fresh = assess_collateral_ratio(10 * ETH, debt, PRICE, MCR, observed_at=1000, now=1000 + t.max_data_age_seconds)
        self.assertEqual(fresh.level, LEVEL_SAFE)

    def test_zero_collateral_with_debt_is_liquidatable_not_hidden(self):
        a = assess_collateral_ratio(0, 1000 * SCALE, PRICE, MCR)
        self.assertEqual(a.level, LEVEL_LIQUIDATABLE)
        self.assertIn(REASON_ZERO_COLLATERAL, a.reasons)

    def test_invalid_inputs(self):
        for args in [(-1, 1, PRICE, MCR), (1, 1, PRICE, SCALE), (1, 1, 0, MCR), (True, 1, PRICE, MCR), (1, 1, -5, MCR)]:
            with self.subTest(args=args):
                self.assertEqual(assess_collateral_ratio(*args).reasons, (REASON_INVALID_INPUT,))


class TestHysteresis(unittest.TestCase):
    def test_escalation_is_immediate_and_deescalation_needs_margin(self):
        t = Thresholds(hysteresis_bps=100)
        # just above the danger boundary (1000 bps) after being in DANGER: stays DANGER
        a = assess_collateral_ratio(10 * ETH, debt_for_distance(1050), PRICE, MCR, t, previous_level=LEVEL_DANGER)
        self.assertEqual(a.level, LEVEL_DANGER)
        # clears the margin: steps down to WATCH
        b = assess_collateral_ratio(10 * ETH, debt_for_distance(1150), PRICE, MCR, t, previous_level=LEVEL_DANGER)
        self.assertEqual(b.level, LEVEL_WATCH)
        # same distance without history: WATCH
        c = assess_collateral_ratio(10 * ETH, debt_for_distance(1050), PRICE, MCR, t)
        self.assertEqual(c.level, LEVEL_WATCH)
        # escalation from SAFE to CRITICAL is not delayed
        d = assess_collateral_ratio(10 * ETH, debt_for_distance(200), PRICE, MCR, t, previous_level=LEVEL_SAFE)
        self.assertEqual(d.level, LEVEL_CRITICAL)

    def test_leaving_liquidatable_has_no_hysteresis(self):
        a = assess_collateral_ratio(10 * ETH, debt_for_distance(50), PRICE, MCR, previous_level=LEVEL_LIQUIDATABLE)
        self.assertEqual(a.level, LEVEL_CRITICAL)

    def test_threshold_validation(self):
        for kwargs in [dict(critical_bps=1000, danger_bps=1000), dict(watch_bps=10_000), dict(hysteresis_bps=300),
                       dict(critical_bps=0), dict(max_data_age_seconds=0), dict(watch_bps=2500.0)]:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ValueError):
                    Thresholds(**kwargs)


class TestHealthFactor(unittest.TestCase):
    def test_health_factor_levels(self):
        # HF 1.25 -> 1 - 1/1.25 = 20% distance -> WATCH
        self.assertEqual(assess_health_factor(125 * SCALE // 100).level, LEVEL_WATCH)
        self.assertEqual(assess_health_factor(125 * SCALE // 100).distance_bps, 2000)
        self.assertEqual(assess_health_factor(2 * SCALE).level, LEVEL_SAFE)
        self.assertEqual(assess_health_factor(SCALE).distance_bps, 0)
        self.assertNotEqual(assess_health_factor(SCALE).level, LEVEL_LIQUIDATABLE)
        self.assertEqual(assess_health_factor(SCALE - 1).level, LEVEL_LIQUIDATABLE)
        self.assertEqual(assess_health_factor(None).level, LEVEL_UNKNOWN)
        self.assertEqual(assess_health_factor(SCALE, has_debt=False).level, LEVEL_NO_DEBT)
        self.assertIsNone(assess_health_factor(2 * SCALE).liquidation_price)


def _a(level):
    return Assessment(level, None if level == LEVEL_UNKNOWN else 500, None)


class TestAlertPolicy(unittest.TestCase):
    def test_first_reading(self):
        self.assertIsNone(decide_alert(AlertState(), _a(LEVEL_SAFE), 0).alert)
        self.assertEqual(decide_alert(AlertState(), _a(LEVEL_DANGER), 0).alert, ALERT_ESCALATED)

    def test_escalate_remind_recover(self):
        s = decide_alert(AlertState(), _a(LEVEL_WATCH), 0).state
        d = decide_alert(s, _a(LEVEL_DANGER), 10)
        self.assertEqual(d.alert, ALERT_ESCALATED)
        # no repeat inside the reminder interval
        self.assertIsNone(decide_alert(d.state, _a(LEVEL_DANGER), 10 + 3600).alert)
        r = decide_alert(d.state, _a(LEVEL_DANGER), 10 + 6 * 3600)
        self.assertEqual(r.alert, ALERT_REMINDER)
        # partial de-escalation is silent; full recovery is announced once
        w = decide_alert(r.state, _a(LEVEL_WATCH), 10 + 7 * 3600)
        self.assertIsNone(w.alert)
        self.assertEqual(w.state.level, LEVEL_WATCH)
        rec = decide_alert(w.state, _a(LEVEL_SAFE), 10 + 8 * 3600)
        self.assertEqual(rec.alert, ALERT_RECOVERED)
        self.assertIsNone(decide_alert(rec.state, _a(LEVEL_SAFE), 10 + 9 * 3600).alert)

    def test_watch_level_has_no_reminders(self):
        s = decide_alert(AlertState(), _a(LEVEL_WATCH), 0).state
        self.assertIsNone(decide_alert(s, _a(LEVEL_WATCH), 10 * 86400).alert)

    def test_unknown_is_announced_once_and_keeps_last_known_level(self):
        s = decide_alert(AlertState(), _a(LEVEL_DANGER), 0).state
        u = decide_alert(s, _a(LEVEL_UNKNOWN), 100)
        self.assertEqual(u.alert, ALERT_DATA_UNAVAILABLE)
        self.assertEqual(u.state.level, LEVEL_DANGER)
        self.assertIsNone(decide_alert(u.state, _a(LEVEL_UNKNOWN), 200).alert)
        # data comes back worse: escalation, not a silent restore
        self.assertEqual(decide_alert(u.state, _a(LEVEL_CRITICAL), 300).alert, ALERT_ESCALATED)
        # data comes back unchanged: restored notice
        self.assertEqual(decide_alert(u.state, _a(LEVEL_DANGER), 300).alert, ALERT_DATA_RESTORED)
        # data comes back safe: recovered
        self.assertEqual(decide_alert(u.state, _a(LEVEL_SAFE), 300).alert, ALERT_RECOVERED)

    def test_unknown_on_first_reading_then_safe(self):
        u = decide_alert(AlertState(), _a(LEVEL_UNKNOWN), 0)
        self.assertEqual(u.alert, ALERT_DATA_UNAVAILABLE)
        self.assertEqual(decide_alert(u.state, _a(LEVEL_SAFE), 10).alert, ALERT_DATA_RESTORED)

    def test_worst_and_percent(self):
        self.assertEqual(worst([LEVEL_SAFE, LEVEL_UNKNOWN, LEVEL_DANGER]), LEVEL_DANGER)
        self.assertIsNone(worst([LEVEL_UNKNOWN]))
        self.assertEqual(price_drop_percent(Assessment(LEVEL_WATCH, 1234, None)), "12.34")
        self.assertEqual(price_drop_percent(Assessment(LEVEL_CRITICAL, 5, None)), "0.05")


def screen(positions, valid_oracle=True, status="no-below-mcr-in-sorted-sample", block_seconds=1_763_200_000):
    return {
        "schemaVersion": 1, "kind": "liquity-weth-position-screen", "executionEnabled": False,
        "chainId": 1, "blockNumber": 23_000_000, "blockHash": "0x" + "ab" * 32,
        "blockTimestampMs": block_seconds * 1000, "mcrAtomic": str(MCR), "status": status,
        "oracle": {"valid": valid_oracle, "priceAtomic": str(PRICE) if valid_oracle else None,
                   "reasons": [] if valid_oracle else ["STALE_ORACLE"]},
        "coverage": {"sortedCount": str(len(positions)), "positionsScanned": len(positions)},
        "positions": [{"troveId": str(i + 1), "entireCollAtomic": str(c), "entireDebtAtomic": str(d)}
                      for i, (c, d) in enumerate(positions)],
    }


SAMPLE = [(10 * ETH, debt_for_distance(4000)), (10 * ETH, debt_for_distance(200)),
          (10 * ETH, debt_for_distance(800)), (10 * ETH, 0)]


class TestLiquityAdapter(unittest.TestCase):
    def test_assess_screen_orders_worst_first(self):
        p = liquity.assess_screen(screen(SAMPLE), now=1_763_200_010)
        self.assertEqual(p["status"], "assessed")
        self.assertEqual([r["level"] for r in p["positions"]],
                         [LEVEL_CRITICAL, LEVEL_DANGER, LEVEL_SAFE, LEVEL_NO_DEBT])
        self.assertEqual(p["worstLevel"], LEVEL_CRITICAL)
        self.assertEqual(p["levelCounts"][LEVEL_SAFE], 1)
        self.assertEqual(p["positions"][0]["troveId"], "2")

    def test_invalid_oracle_makes_every_position_unknown(self):
        p = liquity.assess_screen(screen(SAMPLE[:3], valid_oracle=False), now=1_763_200_010)
        self.assertEqual(p["status"], "oracle-invalid")
        self.assertEqual(set(p["levelCounts"]), {LEVEL_UNKNOWN})
        self.assertIsNone(p["worstLevel"])
        self.assertEqual(p["oracleReasons"], ["STALE_ORACLE"])

    def test_old_screen_is_unknown_not_safe(self):
        p = liquity.assess_screen(screen(SAMPLE[:1]), now=1_763_200_000 + 10_000)
        self.assertEqual(p["positions"][0]["level"], LEVEL_UNKNOWN)
        self.assertEqual(p["positions"][0]["reasons"], [REASON_DATA_STALE])

    def test_watch_list_reports_ids_missing_from_sample(self):
        p = liquity.assess_screen(screen(SAMPLE), now=1_763_200_010, watch=["3", "999"])
        self.assertEqual([r["troveId"] for r in p["positions"]], ["3"])
        self.assertEqual(p["watchNotInSample"], ["999"])

    def test_branch_shutdown(self):
        p = liquity.assess_screen(screen([], status="branch-shutdown"))
        self.assertEqual(p["status"], "branch-shutdown")
        self.assertEqual(p["positions"], [])

    def test_rejects_wrong_documents(self):
        good = screen(SAMPLE)
        bad_kind = dict(good, kind="something-else")
        enabled = dict(good, executionEnabled=True)
        bad_number = screen([(10 * ETH, 1)])
        bad_number["positions"][0]["entireDebtAtomic"] = "1e18"
        for doc in (bad_kind, enabled, bad_number, [], dict(good, blockTimestampMs=None)):
            with self.assertRaises(liquity.InvalidScreen):
                liquity.assess_screen(doc)

    def test_cli_writes_valid_envelope_dated_at_block_time(self):
        with tempfile.TemporaryDirectory() as d:
            path = os.path.join(d, "screen.json")
            with open(path, "w", encoding="utf-8") as f:
                json.dump({"kind": "liquity-screen-capture", "result": screen(SAMPLE)}, f)
            self.assertEqual(liquity.main(["--screen", path, "--now", "1763200010", "--out-dir", d]), 0)
            with open(os.path.join(d, "guardian-liquity-weth", "latest.json"), encoding="utf-8") as f:
                rep = json.load(f)
            bad = os.path.join(d, "bad.json")
            with open(bad, "w", encoding="utf-8") as f:
                json.dump({"kind": "nope"}, f)
            self.assertEqual(liquity.main(["--screen", bad, "--out-dir", d]), 2)
        self.assertEqual(validate_report(rep), [])
        self.assertEqual(rep["generatedAt"], "2025-11-15T09:46:40Z")
        self.assertEqual(rep["summary"]["critical"], 1)
        self.assertEqual(rep["summary"]["worstLevel"], LEVEL_CRITICAL)
        self.assertIs(rep["executionEnabled"], False)
        self.assertTrue(any("Not financial advice" in c for c in rep["caveats"]))


if __name__ == "__main__":
    unittest.main()
