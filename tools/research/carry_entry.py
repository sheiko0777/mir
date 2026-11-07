"""HYPE native metadata + four-side depth: conditional carry entry cost, not profit."""
import argparse
from decimal import Decimal, ROUND_DOWN, ROUND_CEILING, localcontext
import hashlib
import json
from pathlib import Path
import time

from depth_quote import positive, quote

CAPITALS = ('500', '5000', '50000')
SPEC_SOURCE = 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/contract-specifications'
FEE_SOURCE = 'https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees'


def only(rows, predicate):
    selected = [row for row in rows if predicate(row)]
    if len(selected) != 1:
        raise ValueError('Missing or ambiguous native identity/evidence')
    return selected[0]


def identify(document):
    if document.get('kind') != 'public-market-capture' or document.get('schemaVersion') != 1:
        raise ValueError('Expected public market capture')
    evidence = document.get('evidence')
    if not isinstance(evidence, list) or len(evidence) > 20:
        raise ValueError('Evidence budget exceeded')
    def read(request):
        record = only(evidence, lambda row: row.get('request') == request)
        if record.get('error') or 'response' not in record or \
                type(record.get('requestedAtMs')) is not int or type(record.get('capturedAtMs')) is not int or \
                not 0 <= record['requestedAtMs'] <= record['capturedAtMs']:
            raise ValueError('Failed or invalid capture interval')
        return record
    spot_meta_record = read({'type': 'spotMeta'})
    spot_meta = spot_meta_record['response']
    token = only(spot_meta['tokens'], lambda row: row.get('name') == 'HYPE' and type(row.get('index')) is int)
    usdc = only(spot_meta['tokens'], lambda row: row.get('name') == 'USDC' and type(row.get('index')) is int)
    pair = only(spot_meta['universe'], lambda row: row.get('tokens') == [token['index'], usdc['index']])
    if type(pair.get('index')) is not int or pair['index'] < 0 or pair.get('name') != '@' + str(pair['index']):
        raise ValueError('Native spot ID mismatch')
    context_record = read({'type': 'metaAndAssetCtxs'})
    meta, contexts = context_record['response']
    if len(meta['universe']) != len(contexts):
        raise ValueError('Perp context alignment mismatch')
    native = only(list(enumerate(meta['universe'])), lambda item: item[1].get('name') == 'HYPE')
    if native[1].get('isDelisted'):
        raise ValueError('Delisted perpetual')
    ctx = contexts[native[0]]
    oracle, funding = positive(ctx['oraclePx']), Decimal(ctx['funding'])
    if not isinstance(ctx['funding'], str) or not funding.is_finite() or abs(funding) > Decimal('.04'):
        raise ValueError('Invalid funding context')
    precision = [token.get('szDecimals'), native[1].get('szDecimals')]
    if any(type(value) is not int or not 0 <= value <= 12 for value in precision):
        raise ValueError('Invalid size precision')
    spot, perp = read({'type': 'l2Book', 'coin': pair['name']}), read({'type': 'l2Book', 'coin': 'HYPE'})
    for record, coin in ((spot, pair['name']), (perp, 'HYPE')):
        quote(record['response'], coin, record['capturedAtMs'], '1', 'buy')
    skew = abs(spot['response']['time'] - perp['response']['time'])
    if skew > 1000:
        raise ValueError('Spot/perp source skew exceeds 1000 ms')
    books_at = max(spot['response']['time'], perp['response']['time'])
    # Context has a request interval, not an oracle source timestamp. Never label it atomic.
    if not 0 <= books_at - context_record['requestedAtMs'] <= 10000 or context_record['capturedAtMs'] > books_at + 5000:
        raise ValueError('Context request interval too far from books')
    if not 0 <= books_at - spot_meta_record['requestedAtMs'] <= 180000:
        raise ValueError('Spot metadata request too far from books')
    return spot, perp, oracle, funding, min(precision), {
        'asset': 'HYPE', 'spotCoin': pair['name'], 'spotTokenIndex': token['index'],
        'quoteTokenIndex': usdc['index'], 'perpUniverseIndex': native[0],
        'sourceTimeSkewMs': skew, 'bookTimeMs': books_at,
        'latestCaptureAtMs': max(row['capturedAtMs'] for row in (spot, perp, context_record, spot_meta_record)),
        'contextRequestedAtMs': context_record['requestedAtMs'],
        'contextCapturedAtMs': context_record['capturedAtMs'], 'specificationSource': SPEC_SOURCE,
        'identityStatus': 'native-metadata-matched-not-economic-certification'}


def size_for_budget(book, budget, fee, precision):
    remaining, quantity = budget / (1 + fee), Decimal(0)
    for row in book['levels'][1]:
        price, size = positive(row['px']), positive(row['sz'])
        taken = min(size, remaining / price)
        quantity += taken; remaining -= taken * price
        if remaining <= Decimal('1e-50'):
            break
    if remaining > Decimal('1e-50'):
        raise ValueError('Spot budget exceeds captured ask depth')
    quantity = quantity.quantize(Decimal(1).scaleb(-precision), rounding=ROUND_DOWN)
    if quantity <= 0:
        raise ValueError('Budget below common size increment')
    return quantity


def estimate(spot, perp, oracle, funding, precision, capital, multiplier):
    with localcontext() as context:
        context.prec = 80
        capital = Decimal(capital)
        # Published base-tier taker rates are explicit assumptions, not user-specific fees.
        spot_fee, perp_fee = Decimal('0.0007') * multiplier, Decimal('0.00045') * multiplier
        quantity = size_for_budget(spot['response'], capital * Decimal('.5'), spot_fee, precision)
        quotes = {}
        for leg, record in (('spot', spot), ('perp', perp)):
            for side in ('buy', 'sell'):
                result = quote(record['response'], record['request']['coin'], record['capturedAtMs'], str(quantity), side)
                if not result['completeDepth']:
                    raise ValueError(leg + ' ' + side + ': insufficient depth')
                quotes[leg + side] = result
        notionals = {key: Decimal(row['quoteNotional']) for key, row in quotes.items()}
        fees = (notionals['spotbuy'] + notionals['spotsell']) * spot_fee + \
               (notionals['perpbuy'] + notionals['perpsell']) * perp_fee
        crossing = notionals['spotbuy'] - notionals['spotsell'] + notionals['perpbuy'] - notionals['perpsell']
        hurdle = fees + crossing
        notional = quantity * oracle
        hourly = notional * funding
        spot_committed = notionals['spotbuy'] * (1 + spot_fee)
        entry_perp_fee = notionals['perpsell'] * perp_fee
        return {'quantityBase': str(quantity), 'commonSizeDecimals': precision, 'quotes': quotes,
                'spotEntryWithFeeUsdc': str(spot_committed), 'marginBudgetUsdc': str(capital * Decimal('.3')),
                'reserveAfterEntryPerpFeeUsdc': str(capital - spot_committed - capital * Decimal('.3') - entry_perp_fee),
                'assumedFeesUsdc': str(fees), 'snapshotCrossingDragUsdc': str(crossing),
                'knownCostHurdleUsdc': str(hurdle), 'oracleNotionalUsdc': str(notional),
                'requiredCumulativeFundingRateAtUnchangedBooks': str(hurdle / notional),
                'currentContextFundingRate': str(funding), 'constantRateScenarioIncomePerHourUsdc': str(hourly),
                'constantRateHoursToCoverKnownCosts': str((hurdle / hourly).to_integral_value(rounding=ROUND_CEILING)) if hourly > 0 else None,
                'unmodeledOtherCostsUsdc': None, 'fullCostHurdleUsdc': None, 'netUsdc': None,
                'qualified': False, 'actualFills': 0}


def analyze(document, now_ms=None):
    spot, perp, oracle, funding, precision, identity = identify(document)
    now_ms = int(time.time() * 1000) if now_ms is None else now_ms
    if type(now_ms) is not int or now_ms < identity['latestCaptureAtMs']:
        raise ValueError('Future capture')
    cases = []
    for capital in CAPITALS:
        for multiplier in (1, 2):
            item = {'capitalBudgetUsdc': capital, 'feeMultiplier': multiplier}
            try:
                item.update(status='estimated-snapshot-costs', result=estimate(spot, perp, oracle, funding, precision, capital, multiplier))
            except ValueError as error:
                item.update(status='insufficient-evidence', reason=str(error), netUsdc=None, qualified=False)
            cases.append(item)
    return {'schemaVersion': 1, 'kind': 'carry-entry-cost-diagnostic', 'identity': identity, 'cases': cases,
            'historicalSnapshot': now_ms - identity['bookTimeMs'] > 30000, 'evaluatedAtMs': now_ms,
            'feeAssumptions': {'spotTakerBps': '7', 'perpTakerBps': '4.5', 'source': FEE_SOURCE, 'reviewDate': '2026-10-30'},
            'qualified': False, 'netUsdc': None, 'netUsd': None, 'decision': 'insufficient-evidence',
            'limitations': ['USDC budgets are not USD capital experiments; conversion is not assumed.',
                            'Context funding is not a settled payment or a future-rate forecast.',
                            'Unchanged-book crossing is a sensitivity assumption, not future closing liquidity.',
                            'Same-ms books are not an atomic state; oracle context has no source timestamp.',
                            'Native identity match does not certify oracle tracking, hedge behavior or margin safety.',
                            'Transfers, borrow, collateral opportunity cost, rebalancing and unmodeled charges remain unknown.',
                            'No execution, actual fills, PnL, holdout or forward-return claim.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    if args.input.stat().st_size > 8 * 1024 * 1024:
        raise ValueError('Capture exceeds 8 MiB budget')
    raw = args.input.read_bytes()
    if len(raw) > 8 * 1024 * 1024:
        raise ValueError('Capture exceeds 8 MiB budget')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate JSON key')
            result[key] = value
        return result
    report = analyze(json.loads(raw, object_pairs_hook=unique))
    report['sourceSha256'] = hashlib.sha256(raw).hexdigest()
    report['engineSourcesSha256'] = {name: hashlib.sha256(Path(__file__).with_name(name).read_bytes()).hexdigest()
                                     for name in ('carry_entry.py', 'depth_quote.py')}
    encoded = json.dumps(report, sort_keys=True, allow_nan=False).encode()
    root = Path(__file__).resolve().parents[2] / 'data' / 'carry-entry'
    root.mkdir(parents=True, exist_ok=True)
    target = root / (hashlib.sha256(encoded).hexdigest() + '.json')
    with target.open('xb') as output:
        output.write(encoded)
    print(json.dumps({'file': str(target), 'identity': report['identity'], 'decision': report['decision'],
                      'cases': [{**{k: v for k, v in item.items() if k != 'result'},
                                 'summary': {key: item.get('result', {}).get(key) for key in
                                             ('quantityBase', 'knownCostHurdleUsdc', 'constantRateHoursToCoverKnownCosts')}} for item in report['cases']]}))


if __name__ == '__main__':
    main()
