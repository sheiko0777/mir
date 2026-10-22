import copy
import unittest
from depth_quote import quote


class DepthQuoteTests(unittest.TestCase):
    def setUp(self):
        self.book = {'coin': 'BTC', 'time': 1000, 'levels': [
            [{'px': '99', 'sz': '2'}, {'px': '98', 'sz': '3'}],
            [{'px': '101', 'sz': '1'}, {'px': '102', 'sz': '2'}]]}

    def test_size_weighted_and_partial(self):
        result = quote(self.book, 'BTC', 1100, '2', 'buy')
        self.assertEqual(result['averagePrice'], '101.5')
        self.assertEqual(quote(self.book, 'BTC', 1100, '3', 'sell')['quoteNotional'], '296')
        partial = quote(self.book, 'BTC', 1100, '4', 'buy')
        self.assertEqual(partial['unfilledBase'], '1')
        self.assertIsNone(partial['averagePrice'])
        self.assertFalse(partial['qualified'])

    def test_reject_bad_evidence(self):
        for coin, time in [('ETH', 1100), ('BTC', 999), ('BTC', 6001)]:
            with self.assertRaises(ValueError): quote(self.book, coin, time, '1', 'buy')
        for value in ['NaN', 'Infinity', '-1', '0', 'invalid', '1e-999999']:
            with self.assertRaises(ValueError): quote(self.book, 'BTC', 1100, value, 'buy')
        bad = copy.deepcopy(self.book)
        bad['levels'][1].reverse()
        with self.assertRaises(ValueError): quote(bad, 'BTC', 1100, '1', 'buy')


if __name__ == '__main__': unittest.main()
