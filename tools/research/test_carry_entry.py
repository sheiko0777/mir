from copy import deepcopy
from decimal import Decimal
import unittest

from carry_entry import analyze


def fixture():
    def record(request, response):
        return {'request': request, 'response': response, 'requestedAtMs': 1000, 'capturedAtMs': 2100}
    def book(coin, bid, ask):
        return {'coin': coin, 'time': 2000, 'levels': [[{'px': bid, 'sz': '100000'}], [{'px': ask, 'sz': '100000'}]]}
    return {'schemaVersion': 1, 'kind': 'public-market-capture', 'evidence': [
        record({'type': 'spotMeta'}, {'tokens': [{'index': 150, 'name': 'HYPE', 'szDecimals': 2},
                                               {'index': 0, 'name': 'USDC', 'szDecimals': 8}],
                                     'universe': [{'name': '@107', 'index': 107, 'tokens': [150, 0]}]}),
        record({'type': 'metaAndAssetCtxs'}, [{'universe': [{'name': 'HYPE', 'szDecimals': 2}]},
                                            [{'oraclePx': '100', 'funding': '0.001'}]]),
        record({'type': 'l2Book', 'coin': '@107'}, book('@107', '99', '101')),
        record({'type': 'l2Book', 'coin': 'HYPE'}, book('HYPE', '100', '102'))]}


class EntryTests(unittest.TestCase):
    def test_exact_four_side_cost_hurdle_and_capital_conservation(self):
        document = fixture(); saved = deepcopy(document)
        result = analyze(document, 3000)
        row = result['cases'][0]['result']
        self.assertEqual(len(result['cases']), 6)
        self.assertEqual(row['quantityBase'], '2.47')
        q = Decimal('2.47')
        # Two spot fees on 99+101, two perp fees on 100+102, and two spreads of 2.
        self.assertEqual(Decimal(row['knownCostHurdleUsdc']), q * Decimal('4.2309'))
        self.assertEqual(Decimal(row['requiredCumulativeFundingRateAtUnchangedBooks']), Decimal('.042309'))
        self.assertEqual(row['constantRateHoursToCoverKnownCosts'], '43')
        self.assertLessEqual(Decimal(row['spotEntryWithFeeUsdc']), Decimal('250'))
        self.assertEqual(Decimal(row['spotEntryWithFeeUsdc']) + Decimal(row['marginBudgetUsdc']) +
                         Decimal(row['reserveAfterEntryPerpFeeUsdc']) + q * 100 * Decimal('.00045'), Decimal('500'))
        self.assertIsNone(row['netUsdc']); self.assertIsNone(row['fullCostHurdleUsdc'])
        self.assertFalse(result['qualified']); self.assertEqual(document, saved)

    def test_negative_funding_has_no_fabricated_payback(self):
        document = fixture(); document['evidence'][1]['response'][1][0]['funding'] = '-0.001'
        result = analyze(document, 3000)
        self.assertIsNone(result['cases'][0]['result']['constantRateHoursToCoverKnownCosts'])
        self.assertLess(Decimal(result['cases'][0]['result']['constantRateScenarioIncomePerHourUsdc']), 0)

    def test_size_uses_depth_and_retains_failed_sizes(self):
        document = fixture()
        document['evidence'][2]['response']['levels'][1][0]['sz'] = '3'
        result = analyze(document, 3000)
        self.assertEqual(result['cases'][0]['status'], 'estimated-snapshot-costs')
        self.assertEqual(result['cases'][2]['status'], 'insufficient-evidence')
        self.assertIn('depth', result['cases'][2]['reason'])

    def test_all_four_sides_need_full_depth(self):
        document = fixture(); document['evidence'][3]['response']['levels'][1][0]['sz'] = '1'
        result = analyze(document, 3000)
        self.assertEqual(result['cases'][0]['status'], 'insufficient-evidence')
        self.assertIn('perp buy', result['cases'][0]['reason'])

    def test_native_identity_not_display_symbols_and_no_ambiguous_evidence(self):
        document = fixture(); document['markets'] = [{'base': 'BTC'}]; document['qualified'] = True
        self.assertEqual(analyze(document, 3000)['identity']['asset'], 'HYPE')
        document['evidence'][0]['response']['universe'][0]['tokens'] = [151, 0]
        with self.assertRaises(ValueError): analyze(document, 3000)
        document = fixture(); document['evidence'].append(deepcopy(document['evidence'][2]))
        with self.assertRaises(ValueError): analyze(document, 3000)

    def test_time_skew_failed_requests_and_historical_label(self):
        self.assertTrue(analyze(fixture(), 40000)['historicalSnapshot'])
        with self.assertRaises(ValueError): analyze(fixture(), 1000)
        document = fixture(); document['evidence'][3]['response']['time'] = 999
        with self.assertRaises(ValueError): analyze(document, 3000)
        document = fixture(); document['evidence'][3]['error'] = 'unavailable'
        with self.assertRaises(ValueError): analyze(document, 3000)

    def test_doubled_fees_raise_cost_per_notional_without_claiming_profit(self):
        result = analyze(fixture(), 3000)
        base, doubled = [row['result'] for row in result['cases'][:2]]
        self.assertGreater(Decimal(doubled['requiredCumulativeFundingRateAtUnchangedBooks']),
                           Decimal(base['requiredCumulativeFundingRateAtUnchangedBooks']))
        self.assertFalse(doubled['qualified']); self.assertEqual(doubled['actualFills'], 0)


if __name__ == '__main__':
    unittest.main()
