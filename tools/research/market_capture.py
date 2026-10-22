"""CCXT public-data adapter. Never exposes an exchange instance to the agent."""
import json
import time
from pathlib import Path
import ccxt
from public_market_guard import validate_request


class PublicHyperliquid(ccxt.hyperliquid):
    def __init__(self):
        super().__init__({'enableRateLimit': True, 'timeout': 20000,
                          'options': {'fetchMarkets': {'types': ['spot', 'swap']}}})
        self.evidence = []
        self.request_count = 0
        self.session.max_redirects = 0
        self.started = time.monotonic()

    def fetch(self, url, method='GET', headers=None, body=None):
        request = validate_request(url, method, body)
        if self.request_count >= 20 or time.monotonic() - self.started > 180:
            raise ValueError('Public capture budget exhausted')
        self.request_count += 1
        began = int(time.time() * 1000)
        record = {'request': request, 'requestedAtMs': began}
        try:
            result = super().fetch(url, method, headers, body)
            record['response'] = result
            return result
        except Exception as error:
            record['error'] = str(error)
            raise
        finally:
            record['capturedAtMs'] = int(time.time() * 1000)
            self.evidence.append(record)


def capture():
    if ccxt.__version__ != '4.5.89':
        raise ValueError('CCXT version differs from reviewed version')
    exchange = PublicHyperliquid()
    report = {'schemaVersion': 1, 'kind': 'public-market-capture', 'adapter': f'ccxt/{ccxt.__version__}',
              'markets': [], 'books': [], 'qualified': False,
              'limitations': ['Spot representations may differ from perp underlying; no automatic hedge equivalence.',
                              'Sequential requests are not simultaneous; source/capture timestamps must be checked.',
                              'Top 20 levels are a snapshot, not guaranteed fills or historical depth.',
                              'USD/USDC equivalence, fees, collateral and token backing remain unverified.']}
    try:
        markets = exchange.load_markets()
        # Discover candidate representations but never equate wrapped assets by symbol.
        names = {'BTC', 'ETH', 'SOL', 'UBTC', 'UETH', 'USOL'}
        chosen = [m for m in markets.values() if m.get('base') in names and m.get('quote') == 'USDC'
                  and (m.get('spot') or m.get('swap'))]
        for market in sorted(chosen, key=lambda m: m['symbol'])[:8]:
            report['markets'].append({k: market.get(k) for k in
                                      ('id', 'symbol', 'base', 'quote', 'spot', 'swap', 'linear', 'settle', 'baseId', 'quoteId', 'info')})
            book = exchange.fetch_order_book(market['symbol'])
            report['books'].append(book)
        report['status'] = 'captured' if report['books'] else 'no-supported-market'
    except Exception as error:
        report['status'] = 'unavailable'
        report['reason'] = str(error)
    report['evidence'] = exchange.evidence
    report['capturedAtMs'] = int(time.time() * 1000)
    root = Path('data/market-capture'); root.mkdir(parents=True, exist_ok=True)
    target = root / f"{report['capturedAtMs']}.json"
    with target.open('x', encoding='utf-8') as output:
        json.dump(report, output, indent=2)
    print(json.dumps({'file': str(target.resolve()), 'status': report['status'], 'reason': report.get('reason'),
                      'symbols': [m['symbol'] for m in report['markets']], 'calls': len(exchange.evidence)}))


if __name__ == '__main__': capture()
