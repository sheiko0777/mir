"""CCXT public-data adapter. Never exposes an exchange instance to the agent."""
import json
import time
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import ccxt
from public_market_guard import validate_request
from capture_budget import CaptureBudget


class PublicHyperliquid(ccxt.hyperliquid):
    def __init__(self, budget=None):
        super().__init__({'enableRateLimit': True, 'timeout': 20000,
                          'options': {'fetchMarkets': {'types': ['spot', 'swap']}}})
        self.budget = budget or CaptureBudget()
        self.market_symbol = None
        self.session.max_redirects = 0

    def fetch(self, url, method='GET', headers=None, body=None):
        request = validate_request(url, method, body)
        self.budget.admit()
        began = int(time.time() * 1000)
        record = {'request': request, 'requestedAtMs': began}
        if self.market_symbol:
            record['marketSymbol'] = self.market_symbol
        try:
            result = super().fetch(url, method, headers, body)
            record['response'] = result
            return result
        except Exception as error:
            record['error'] = str(error)
            raise
        finally:
            record['capturedAtMs'] = int(time.time() * 1000)
            self.budget.record(record)


def capture():
    if ccxt.__version__ != '4.5.89':
        raise ValueError('CCXT version differs from reviewed version')
    exchange = PublicHyperliquid()
    report = {'schemaVersion': 1, 'kind': 'public-market-capture', 'adapter': f'ccxt/{ccxt.__version__}',
              'markets': [], 'books': [], 'qualified': False, 'captureMode': 'parallel-2',
              'limitations': ['Spot representations may differ from perp underlying; no automatic hedge equivalence.',
                              'Two concurrent workers do not guarantee synchronized source timestamps.',
                              'Top 20 levels are a snapshot, not guaranteed fills or historical depth.',
                              'USD/USDC equivalence, fees, collateral and token backing remain unverified.']}
    try:
        markets = exchange.load_markets()
        # Discover candidate representations but never equate wrapped assets by symbol.
        names = {'BTC', 'ETH', 'SOL', 'UBTC', 'UETH', 'USOL'}
        chosen = [m for m in markets.values() if m.get('base') in names and m.get('quote') == 'USDC'
                  and (m.get('spot') or m.get('swap'))]
        selected = sorted(chosen, key=lambda m: m['symbol'])[:8]
        for market in selected:
            report['markets'].append({k: market.get(k) for k in
                                      ('id', 'symbol', 'base', 'baseName', 'quote', 'spot', 'swap', 'linear', 'settle', 'baseId', 'quoteId', 'info')})
        def fetch_book(market):
            worker = PublicHyperliquid(exchange.budget)
            try:
                # Isolated sessions per worker; market metadata was already collected once.
                worker.set_markets(markets, exchange.currencies)
                worker.market_symbol = market['symbol']
                return {'book': worker.fetch_order_book(market['symbol'])}
            except Exception as error:
                return {'symbol': market['symbol'], 'error': str(error)}
            finally:
                worker.session.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(fetch_book, selected))
        report['books'] = [row['book'] for row in outcomes if 'book' in row]
        report['failures'] = [row for row in outcomes if 'error' in row]
        report['status'] = 'partial' if report['failures'] else 'captured' if report['books'] else 'no-supported-market'
    except Exception as error:
        report['status'] = 'unavailable'
        report['reason'] = str(error)
    finally:
        exchange.session.close()
    report['evidence'] = exchange.budget.evidence
    report['capturedAtMs'] = int(time.time() * 1000)
    root = Path('data/market-capture'); root.mkdir(parents=True, exist_ok=True)
    target = root / f"{report['capturedAtMs']}.json"
    with target.open('x', encoding='utf-8') as output:
        json.dump(report, output, indent=2)
    print(json.dumps({'file': str(target.resolve()), 'status': report['status'], 'reason': report.get('reason'),
                      'symbols': [m['symbol'] for m in report['markets']], 'calls': exchange.budget.requests}))


if __name__ == '__main__': capture()
