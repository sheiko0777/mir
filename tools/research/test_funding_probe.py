import unittest
from funding_probe import summarize, HOUR


class FundingTests(unittest.TestCase):
    def test_signed_rates_and_costs(self):
        rows = [{'coin': 'BTC', 'time': i * HOUR, 'fundingRate': rate}
                for i, rate in enumerate(['0.001', '-0.002', '0.003', '-0.001'])]
        result = summarize(rows, 'BTC', 0, 4 * HOUR)
        self.assertEqual(result['shortFundingBps'], '10.000')
        self.assertEqual(result['costSensitivityBps']['25'], '-15.000')
        self.assertEqual(result['negativeIntervals'], 2)
        self.assertIsNone(result['netProfit'])

    def test_rejects_gaps_duplicates_and_bad_identity(self):
        row = {'coin': 'BTC', 'time': 0, 'fundingRate': '0.001'}
        for rows in ([], [row, row], [{**row, 'coin': 'ETH'}],
                     [{**row, 'fundingRate': 'NaN'}], [{**row, 'time': HOUR}]):
            with self.assertRaises(ValueError):
                summarize(rows, 'BTC', 0, HOUR)

    def test_settlement_timestamp_jitter_keeps_one_observation_per_hour(self):
        rows = [{'coin': 'BTC', 'time': 15, 'fundingRate': '0.001'},
                {'coin': 'BTC', 'time': HOUR + 7, 'fundingRate': '-0.001'}]
        self.assertEqual(summarize(rows, 'BTC', 0, 2 * HOUR)['shortFundingBps'], '0.000')


if __name__ == '__main__':
    unittest.main()
