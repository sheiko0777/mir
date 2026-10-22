import json
import tempfile
import unittest
from pathlib import Path
from inspect_capture import inspect


class CaptureComparisonTests(unittest.TestCase):
    def test_parallel_response_order_uses_explicit_market_symbol(self):
        records, books = [], []
        for coin in ('BTC', 'ETH'):
            symbol = f'{coin}/USDC:USDC'
            books.append({'symbol': symbol, 'timestamp': 10000, 'bids': [[99, 2]], 'asks': [[101, 2]]})
            records.append({'marketSymbol': symbol, 'request': {'type': 'l2Book', 'coin': coin},
                            'requestedAtMs': 10000, 'capturedAtMs': 11000,
                            'response': {'coin': coin, 'time': 10000, 'levels': [
                                [{'px': '99', 'sz': '2'}], [{'px': '101', 'sz': '2'}]]}})
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'capture.json'
            path.write_text(json.dumps({'books': books, 'evidence': list(reversed(records))}), encoding='utf-8')
            self.assertTrue(all(row['normalizedParserMatches'] for row in inspect(path)['books']))

    def test_stale_record_does_not_shift_next_comparison(self):
        native = {'coin': 'BTC', 'time': 10000, 'levels': [
            [{'px': '99', 'sz': '2'}], [{'px': '101', 'sz': '2'}]]}
        parsed = {'timestamp': 10000, 'bids': [[99.0, 2.0]], 'asks': [[101.0, 2.0]]}
        report = {'books': [parsed, parsed], 'evidence': [
            {'request': {'type': 'l2Book', 'coin': 'BTC'}, 'requestedAtMs': 15000,
             'capturedAtMs': 16000, 'response': native},
            {'request': {'type': 'l2Book', 'coin': 'BTC'}, 'requestedAtMs': 10000,
             'capturedAtMs': 11000, 'response': native}]}
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / 'capture.json'
            path.write_text(json.dumps(report), encoding='utf-8')
            result = inspect(path)
            self.assertEqual(result['books'][0]['status'], 'rejected')
            self.assertTrue(result['books'][1]['normalizedParserMatches'])
            report['books'][1]['asks'][0][0] = 999
            path.write_text(json.dumps(report), encoding='utf-8')
            self.assertEqual(inspect(path)['books'][1]['status'], 'rejected')


if __name__ == '__main__': unittest.main()
