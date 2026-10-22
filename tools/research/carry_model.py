"""Fixed-quantity spot-long/perp-short scenario. No execution or inferred fills.

Quotes must be synchronized, size-aware executable-side scenarios supplied by the
caller. This function does not infer order-book depth from candles.
"""
from decimal import Decimal, localcontext


def number(value, nonnegative=False):
    if not isinstance(value, str):
        raise ValueError('Amounts must be decimal strings')
    result = Decimal(value)
    if not result.is_finite() or abs(result) > Decimal('1e30') or nonnegative and result < 0:
        raise ValueError('Invalid decimal amount')
    return result


def replay(capital_usd, observations, policy):
    with localcontext() as context:
        context.prec = 50
        return _replay(capital_usd, observations, policy)


def _replay(capital_usd, observations, policy):
    capital = number(capital_usd, True)
    if capital_usd not in ('500', '5000', '50000') or not 2 <= len(observations) <= 10000:
        raise ValueError('Invalid scenario size')
    required = ('spotFeeBps', 'perpFeeBps', 'maintenanceMarginBps')
    if any(policy.get(field) is None for field in required):
        return {'decision': 'insufficient-evidence', 'netUsd': None, 'qualified': False,
                'reason': 'COST_OR_MARGIN_POLICY_MISSING'}
    spot_fee, perp_fee, maintenance = [number(policy[field], True) / 10000 for field in required]
    if spot_fee >= 1 or perp_fee >= 1 or not 0 < maintenance < 1:
        raise ValueError('Invalid fee or margin assumption')
    parsed, previous = [], None
    for row in observations:
        if type(row.get('timeMs')) is not int or row['timeMs'] < 0 or previous is not None and row['timeMs'] <= previous:
            raise ValueError('Times must be strictly increasing')
        previous = row['timeMs']
        if any(row.get(k) is None for k in ('spotBid', 'spotAsk', 'perpBid', 'perpAsk', 'oracle', 'mark', 'fundingRate', 'otherCostUsd')):
            return {'decision': 'insufficient-evidence', 'netUsd': None, 'qualified': False, 'reason': 'MISSING_OBSERVATION'}
        values = {k: number(row[k], k != 'fundingRate') for k in
                  ('spotBid', 'spotAsk', 'perpBid', 'perpAsk', 'oracle', 'mark', 'fundingRate', 'otherCostUsd')}
        if any(values[k] <= 0 for k in ('spotBid', 'spotAsk', 'perpBid', 'perpAsk', 'oracle', 'mark')) or \
                values['spotBid'] > values['spotAsk'] or values['perpBid'] > values['perpAsk'] or abs(values['fundingRate']) > Decimal('.04'):
            raise ValueError('Invalid market observation')
        parsed.append((row['timeMs'], values))
    first = parsed[0][1]
    # Fixed allocation: 50% spot including entry fee, 30% isolated margin, 20% reserve.
    quantity = capital * Decimal('.5') / (first['spotAsk'] * (1 + spot_fee))
    margin = capital * Decimal('.3')
    entry_fees = quantity * (first['spotAsk'] * spot_fee + first['perpBid'] * perp_fee)
    funding, other, high, maximum_drawdown = Decimal(0), Decimal(0), capital, Decimal(0)
    ledger = []
    status = 'completed-scenario'
    for index, (stamp, row) in enumerate(parsed):
        # Entry is immediately after this timestamp's settlement; don't collect past funding.
        payment = Decimal(0) if index == 0 else quantity * row['oracle'] * row['fundingRate']
        funding += payment
        other += row['otherCostUsd']
        spot_pnl = quantity * (row['spotBid'] - first['spotAsk'])
        perp_pnl = quantity * (first['perpBid'] - row['perpAsk'])
        exit_fees = quantity * (row['spotBid'] * spot_fee + row['perpAsk'] * perp_fee)
        net = spot_pnl + perp_pnl + funding - entry_fees - exit_fees - other
        equity = capital + net
        high = max(high, equity)
        drawdown = max(Decimal(0), (high - equity) / high)
        maximum_drawdown = max(maximum_drawdown, drawdown)
        margin_equity = margin + quantity * (first['perpBid'] - row['mark']) + funding - quantity * first['perpBid'] * perp_fee - other
        breached = margin_equity <= quantity * row['mark'] * maintenance
        ledger.append({'timeMs': stamp, 'spotPnlUsd': str(spot_pnl), 'perpPnlUsd': str(perp_pnl),
                       'fundingPaymentUsd': str(payment), 'cumulativeFundingUsd': str(funding),
                       'feesUsd': str(entry_fees + exit_fees), 'otherCostsUsd': str(other),
                       'scenarioNetUsd': str(net), 'equityUsd': str(equity), 'drawdown': str(drawdown)})
        if breached:
            status = 'margin-breach-unmodeled-liquidation'; break
        if drawdown >= Decimal('.05'):
            status = 'stopped-at-drawdown-limit'; break
    return {'model': 'fixed-quantity-carry-v1', 'decision': 'insufficient-evidence', 'status': status,
            'capitalUsd': capital_usd, 'quantity': str(quantity), 'marginUsd': str(margin),
            'netUsd': None, 'scenarioNetUsd': None if breached else ledger[-1]['scenarioNetUsd'],
            'scenarioReturnOnCapital': None if breached else str(net / capital),
            'maximumDrawdown': str(maximum_drawdown), 'ledger': ledger, 'qualified': False,
            'limitations': ['Scenario quotes must include depth and slippage; no actual fills.',
                            'Mark checks only at observations; intrainterval liquidation is unmodeled.',
                            'Margin policy is an explicit assumption, not a venue liquidation engine.',
                            'No holdout or forward validation established by this calculation.']}
