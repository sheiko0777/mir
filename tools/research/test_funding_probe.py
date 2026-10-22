import unittest
import json
from unittest.mock import patch
from funding_probe import summarize, collect_history, HOUR


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

    def test_pagination_advances_past_actual_timestamp_and_preserves_all_rows(self):
        rows = [{'coin': 'BTC', 'time': i * HOUR + 7, 'fundingRate': '0.001'} for i in range(3)]
        pages = [rows[:2], rows[2:]]
        cursors = []
        class Response:
            def __init__(self, page): self.page = page
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, limit): return json.dumps(self.page).encode()
        def request(req, timeout):
            cursors.append(json.loads(req.data)['startTime'])
            return Response(pages.pop(0))
        with patch('funding_probe.urllib.request.urlopen', side_effect=request):
            result = collect_history('BTC', 0, 3 * HOUR)
        self.assertEqual(result, rows)
        self.assertEqual(cursors, [0, HOUR + 8])
        self.assertEqual(summarize(result, 'BTC', 0, 3 * HOUR)['intervals'], 3)


if __name__ == '__main__':
    unittest.main()
