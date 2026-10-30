import unittest
from copy import deepcopy
from decimal import Decimal
from carry_stress import evaluate, transform


def fixture():
    return {'schemaVersion': 1, 'kind': 'carry-scenario', 'evidenceKind': 'illustrative',
            'policy': {'spotFeeBps': '1', 'perpFeeBps': '1', 'maintenanceMarginBps': '500'},
            'observations': [dict(timeMs=i * 3600000, spotBid='100', spotAsk='100',
                                  perpBid='100', perpAsk='100', oracle='100', mark='100',
                                  fundingRate='0.001', otherCostUsd='0') for i in range(3)]}


class StressTests(unittest.TestCase):
    def test_reconciliation_and_adverse_result_are_retained_for_all_capitals(self):
        document = fixture(); saved = deepcopy(document)
        result = evaluate(document)
        self.assertEqual(document, saved)
        self.assertEqual(len(result['cases']), 15)
        baseline = result['cases'][0]['result']
        doubled = result['cases'][1]['result']
        # Independently: q=250/(100*1.0001), funding=q*.2, roundtrip fees=q*.04.
        self.assertAlmostEqual(Decimal(baseline['scenarioNetUsd']), Decimal(250) / Decimal('100.01') * Decimal('.16'), places=25)
        self.assertLess(Decimal(doubled['scenarioNetUsd']), Decimal(baseline['scenarioNetUsd']))
        adverse = result['cases'][4]['result']
        self.assertLess(Decimal(adverse['scenarioNetUsd']), 0)
        self.assertEqual(len(adverse['ledger']), 3)
        self.assertTrue(all(s['status'] == 'survived-scenario-screen' for s in result['screens']))
        self.assertIn('adverse-funding:nonpositive-scenario-net', result['screens'][0]['stressFindings'])
        self.assertIsNone(result['netUsd']); self.assertFalse(result['qualified'])

    def test_quote_penalty_and_negative_funding_do_not_become_favorable(self):
        document = fixture(); row = document['observations'][0]
        row.update(spotBid='99', spotAsk='101', fundingRate='-0.001')
        rows, _ = transform(document['observations'], document['policy'], 'double-quote-penalty')
        self.assertEqual(Decimal(rows[0]['spotBid']), Decimal('98'))
        self.assertEqual(Decimal(rows[0]['spotAsk']), Decimal('102'))
        rows, _ = transform(document['observations'], document['policy'], 'adverse-funding')
        self.assertEqual(rows[0]['fundingRate'], '-0.001')

    def test_missing_cost_and_impossible_stressed_liquidity_remain_unknown(self):
        document = fixture(); document['policy']['perpFeeBps'] = None
        result = evaluate(document)
        self.assertTrue(all(s['status'] == 'incomplete' for s in result['screens']))
        self.assertTrue(all(c['result']['netUsd'] is None for c in result['cases']))
        document = fixture()
        for row in document['observations']:
            row.update(spotBid='1', spotAsk='100')
        result = evaluate(document)
        stressed = result['cases'][2]['result']
        self.assertEqual(stressed['reason'], 'MISSING_OBSERVATION')
        self.assertIsNone(stressed['netUsd'])

    def test_risk_stop_and_margin_loss_are_not_discarded(self):
        document = fixture(); document['observations'][1].update(spotBid='80', spotAsk='80')
        result = evaluate(document)
        self.assertEqual(result['cases'][0]['result']['status'], 'stopped-at-drawdown-limit')
        self.assertIn('baseline:risk-stop', result['screens'][0]['reasons'])
        document = fixture(); document['observations'][1].update(perpBid='200', perpAsk='200', mark='200')
        result = evaluate(document)
        self.assertIsNone(result['cases'][0]['result']['scenarioNetUsd'])
        self.assertLess(Decimal(result['cases'][0]['result']['ledger'][-1]['scenarioNetUsd']), 0)

    def test_evidence_and_digest_do_not_accept_saved_winners(self):
        document = fixture(); before = evaluate(document)
        document['qualified'] = True; document['netUsd'] = '1000000'
        after = evaluate(document)
        self.assertFalse(after['qualified']); self.assertIsNone(after['netUsd'])
        self.assertNotEqual(before['inputSemanticSha256'], after['inputSemanticSha256'])
        self.assertEqual(before['cases'], after['cases'])
        document['evidenceKind'] = 'verified-live-profit'
        with self.assertRaises(ValueError): evaluate(document)

    def test_positive_baseline_is_rejected_when_doubled_costs_erase_it(self):
        document = fixture()
        document['policy'].update(spotFeeBps='4', perpFeeBps='4')
        result = evaluate(document)
        self.assertGreater(Decimal(result['cases'][0]['result']['scenarioNetUsd']), 0)
        self.assertLess(Decimal(result['cases'][3]['result']['scenarioNetUsd']), 0)
        self.assertEqual(result['screens'][0]['status'], 'rejected-scenario')
        document = fixture(); document['observations'][1]['timeMs'] = 0
        with self.assertRaises(ValueError): evaluate(document)


if __name__ == '__main__':
    unittest.main()
