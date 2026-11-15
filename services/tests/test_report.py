"""Tests for the common service report envelope."""

import json
import os
import tempfile
import unittest

from services.common.report import (
    Provenance, build_report, is_stale, parse_timestamp, validate_report, write_report,
)

FIXTURES = os.path.join(os.path.dirname(__file__), "..", "..", "test", "fixtures", "service-reports.json")


def _fixtures():
    with open(FIXTURES, encoding="utf-8") as f:
        return json.load(f)


class TestSharedFixtures(unittest.TestCase):
    def test_valid_examples_pass(self):
        for report in _fixtures()["valid"]:
            self.assertEqual(validate_report(report), [])

    def test_invalid_examples_fail(self):
        for case in _fixtures()["invalid"]:
            with self.subTest(case["reason"]):
                self.assertNotEqual(validate_report(case["report"]), [])


class TestEnvelope(unittest.TestCase):
    def _build(self, **kw):
        args = dict(service="demo", title="Demo", provenance=Provenance.ASSUMED_INPUT,
                    stale_after_seconds=60, data={})
        args.update(kw)
        return build_report(**args)

    def test_build_is_valid_and_never_enables_execution(self):
        rep = self._build()
        self.assertEqual(validate_report(rep), [])
        self.assertIs(rep["executionEnabled"], False)

    def test_build_rejects_bad_input(self):
        with self.assertRaises(ValueError):
            self._build(service="Not Valid")
        with self.assertRaises(ValueError):
            self._build(status="great")

    def test_non_object_is_invalid(self):
        self.assertNotEqual(validate_report([]), [])
        self.assertNotEqual(validate_report(None), [])

    def test_staleness(self):
        rep = self._build(generated_at="2026-11-15T12:00:00Z")
        t0 = parse_timestamp("2026-11-15T12:00:00Z")
        self.assertFalse(is_stale(rep, t0 + 60))
        self.assertTrue(is_stale(rep, t0 + 61))
        # a report dated in the future is not trusted as fresh
        self.assertTrue(is_stale(rep, t0 - 3600))

    def test_write_is_atomic_and_refuses_invalid(self):
        with tempfile.TemporaryDirectory() as d:
            path = write_report(self._build(), d)
            self.assertTrue(path.endswith(os.path.join("demo", "latest.json")))
            self.assertEqual(os.listdir(os.path.dirname(path)), ["latest.json"])
            bad = self._build()
            bad["executionEnabled"] = True
            with self.assertRaises(ValueError):
                write_report(bad, d)
            with open(path, encoding="utf-8") as f:
                self.assertEqual(validate_report(json.load(f)), [])


if __name__ == "__main__":
    unittest.main()
