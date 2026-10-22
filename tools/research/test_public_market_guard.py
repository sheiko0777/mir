import json
import unittest
from public_market_guard import validate_request


class PublicGuardTests(unittest.TestCase):
    def test_metadata_and_books_only(self):
        for request in ({'type': 'spotMeta'}, {'type': 'metaAndAssetCtxs'}, {'type': 'l2Book', 'coin': '@142'}):
            self.assertEqual(validate_request('https://api.hyperliquid.xyz/info', 'POST', json.dumps(request)), request)

    def test_rejects_trades_user_data_and_endpoint_changes(self):
        for url, method, request in [
            ('https://api.hyperliquid.xyz/exchange', 'POST', {'action': {'type': 'order'}}),
            ('https://api.hyperliquid.xyz/info', 'POST', {'type': 'userFills', 'user': '0xabc'}),
            ('https://api.hyperliquid.xyz/info', 'POST', {'type': 'l2Book', 'coin': 'BTC', 'action': {}}),
            ('https://other.example/info', 'POST', {'type': 'meta'}),
            ('https://api.hyperliquid.xyz/info', 'GET', {'type': 'meta'})]:
            with self.assertRaises(ValueError): validate_request(url, method, json.dumps(request))


if __name__ == '__main__': unittest.main()
