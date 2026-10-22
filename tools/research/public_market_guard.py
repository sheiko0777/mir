"""Reject anything except bounded public Hyperliquid market-data requests."""
import json
import re


def validate_request(url, method, body):
    if url != 'https://api.hyperliquid.xyz/info' or method != 'POST' or not isinstance(body, str) or len(body) > 2000:
        raise ValueError('Public market endpoint only')
    request = json.loads(body)
    if request in ({'type': 'meta'}, {'type': 'spotMeta'}, {'type': 'metaAndAssetCtxs'}, {'type': 'spotMetaAndAssetCtxs'}):
        return request
    if isinstance(request, dict) and set(request) == {'type', 'coin'} and request['type'] == 'l2Book' and \
            isinstance(request['coin'], str) and re.fullmatch(r'(?:[A-Z0-9]{1,20}|@[0-9]{1,6}|PURR/USDC)', request['coin']):
        return request
    raise ValueError('Request is outside public market allowlist')
