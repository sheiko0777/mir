"""Public funding-only diagnostic, not a strategy backtest or execution tool."""
import json
import argparse
import time
import urllib.request
from decimal import Decimal
from pathlib import Path

HOUR = 3600000
COINS = ('BTC', 'ETH', 'SOL')
ENDPOINT = 'https://api.hyperliquid.xyz/info'


def summarize(rows, coin, start, end):
    if not isinstance(rows, list) or len(rows) > 366 * 24:
        raise ValueError('Invalid or oversized funding history')
    selected = {}
    for row in rows:
        if row.get('coin') != coin or type(row.get('time')) is not int:
            raise ValueError('Wrong funding identity')
        stamp = row['time']
        if not start <= stamp < end:
            continue
        bucket = stamp // HOUR * HOUR
        if bucket in selected:
            raise ValueError('Duplicate funding interval')
        rate = Decimal(row['fundingRate'])
        if not rate.is_finite() or abs(rate) > Decimal('0.04'):
            raise ValueError('Invalid funding rate')
        selected[bucket] = rate
    expected = list(range(start, end, HOUR))
    if sorted(selected) != expected:
        raise ValueError('Missing or misaligned funding intervals')
    rates = [selected[t] for t in expected]
    total_bps = sum(rates, Decimal(0)) * 10000
    half = len(rates) // 2
    return {'coin': coin, 'intervals': len(rates), 'positiveIntervals': sum(r > 0 for r in rates),
            'negativeIntervals': sum(r < 0 for r in rates), 'shortFundingBps': str(total_bps),
            'firstHalfBps': str(sum(rates[:half], Decimal(0)) * 10000),
            'secondHalfBps': str(sum(rates[half:], Decimal(0)) * 10000),
            'costSensitivityBps': {str(cost): str(total_bps - cost) for cost in (10, 25, 50)},
            'netProfit': None, 'qualified': False}


def collect_history(coin, start, end):
    rows, cursor = [], start
    for _ in range(24):
        body = json.dumps({'type': 'fundingHistory', 'coin': coin, 'startTime': cursor, 'endTime': end}).encode()
        request = urllib.request.Request(ENDPOINT, body, {'Content-Type': 'application/json'})
        with urllib.request.urlopen(request, timeout=25) as response:
            payload = response.read(1000001)
        if len(payload) > 1000000:
            raise ValueError('Response too large')
        page = json.loads(payload)
        if not isinstance(page, list) or len(page) > 500:
            raise ValueError('Invalid funding page')
        if not page:
            break
        if any(type(r.get('time')) is not int or r['time'] < cursor or r['coin'] != coin for r in page):
            raise ValueError('Invalid pagination identity or time')
        last = max(r['time'] for r in page)
        rows.extend(r for r in page if r['time'] < end)
        if last >= end - HOUR:
            break
        cursor = last + 1
    return rows


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--days', type=int, default=7, choices=range(1, 367))
    args = parser.parse_args()
    end = int(time.time() * 1000) // HOUR * HOUR
    start = end - args.days * 24 * HOUR
    report = {'schemaVersion': 1, 'mode': 'funding-only-diagnostic', 'source': ENDPOINT,
              'startInclusiveMs': start, 'endExclusiveMs': end, 'assets': [],
              'assumptions': ['Constant USD notional short, normalized funding income only.',
                              '10/25/50 bps total cost scenarios are assumptions, not venue fee quotes.',
                              'No spot/perp basis P&L, borrow, liquidation, collateral or rehedging model.',
                              'No annualization, compounding, fills or realized profit.'],
              'qualifiedOpportunities': 0}
    for coin in COINS:
        try:
            rows = collect_history(coin, start, end)
            try:
                analysis = summarize(rows, coin, start, end)
                report['assets'].append({'raw': rows, 'analysis': analysis})
            except ValueError as error:
                report['assets'].append({'raw': rows, 'coin': coin, 'status': 'unavailable', 'reason': str(error)})
        except Exception as error:
            report['assets'].append({'coin': coin, 'status': 'unavailable', 'reason': str(error)})
    report['capturedAtMs'] = int(time.time() * 1000)
    directory = Path('data/funding-research')
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{report['capturedAtMs']}.json"
    with target.open('x', encoding='utf-8') as output:
        json.dump(report, output, indent=2)
    print(json.dumps({'file': str(target.resolve()), 'assets': [
        {k: v for k, v in a.items() if k != 'raw'} for a in report['assets']]}))


if __name__ == '__main__':
    main()
