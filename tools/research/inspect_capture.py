"""Recompute depth quality from preserved native responses, not CCXT floats."""
import hashlib
import json
import sys
from pathlib import Path
from depth_quote import quote


def inspect(path):
    raw = Path(path).read_bytes()
    report = json.loads(raw)
    results = []
    normalized = iter(report['books'])
    by_symbol = {book['symbol']: book for book in report['books'] if 'symbol' in book}
    for item in report['evidence']:
        if item['request']['type'] != 'l2Book':
            continue
        coin = item['request']['coin']
        row = {'coin': coin, 'latencyMs': item['capturedAtMs'] - item['requestedAtMs']}
        parsed = (by_symbol.get(item['marketSymbol']) if 'marketSymbol' in item
                  else next(normalized, None)) if 'response' in item else None
        try:
            # A unit probe validates ordering/precision; it is not a capital allocation.
            row['unitBuy'] = quote(item['response'], coin, item['capturedAtMs'], '1', 'buy')
            row['unitSell'] = quote(item['response'], coin, item['capturedAtMs'], '1', 'sell')
            source = item['response']
            if parsed is None:
                raise ValueError('Normalized book missing')
            row['normalizedParserMatches'] = parsed.get('timestamp') == source['time'] and all(
                parsed[side] == [[float(level['px']), float(level['sz'])] for level in source['levels'][index]]
                for index, side in enumerate(('bids', 'asks')))
            if not row['normalizedParserMatches']:
                raise ValueError('Normalized CCXT book differs from native response')
            row['status'] = 'validated-snapshot'
        except (ValueError, KeyError, TypeError, StopIteration) as error:
            row.pop('unitBuy', None)
            row.pop('unitSell', None)
            row['status'], row['reason'] = 'rejected', str(error)
        results.append(row)
    return {'sourceSha256': hashlib.sha256(raw).hexdigest(), 'books': results,
            'qualified': False, 'netUsd': None,
            'reason': 'Snapshot estimates only; hedge identity, costs and temporal evidence remain incomplete.'}


if __name__ == '__main__':
    print(json.dumps(inspect(sys.argv[1]), indent=2))
