"""Deterministic snapshot depth estimates, never execution/fill claims."""
from decimal import Decimal, localcontext
import re


def positive(value):
    if not isinstance(value, str) or not re.fullmatch(r'\d{1,30}(?:\.\d{1,30})?', value):
        raise ValueError('Expected bounded decimal string')
    number = Decimal(value)
    if not number.is_finite() or number <= 0 or number > Decimal('1e30') or number.adjusted() < -30:
        raise ValueError('Invalid positive value')
    return number


def quote(book, coin, captured_at_ms, quantity, side, max_age_ms=5000):
    if side not in ('buy', 'sell') or book.get('coin') != coin:
        raise ValueError('Market identity or side mismatch')
    timestamp = book.get('time')
    if type(timestamp) is not int or type(captured_at_ms) is not int or not 0 <= captured_at_ms - timestamp <= max_age_ms:
        raise ValueError('Stale or future book')
    levels = book.get('levels')
    if not isinstance(levels, list) or len(levels) != 2:
        raise ValueError('Invalid book')
    parsed = []
    for index, rows in enumerate(levels):
        if not isinstance(rows, list) or not 1 <= len(rows) <= 20:
            raise ValueError('Empty or oversized side')
        values = [(positive(row['px']), positive(row['sz'])) for row in rows]
        for previous, current in zip(values, values[1:]):
            if (index == 0 and previous[0] <= current[0]) or (index == 1 and previous[0] >= current[0]):
                raise ValueError('Unsorted or duplicate price levels')
        parsed.append(values)
    if parsed[0][0][0] >= parsed[1][0][0]:
        raise ValueError('Crossed book')
    with localcontext() as context:
        context.prec = 80
        requested = positive(quantity)
        remaining, notional = requested, Decimal(0)
        for price, size in parsed[1 if side == 'buy' else 0]:
            taken = min(size, remaining)
            notional += price * taken
            remaining -= taken
            if remaining == 0:
                break
        return {'requestedBase': str(requested), 'availableBase': str(requested - remaining),
                'unfilledBase': str(remaining), 'quoteNotional': str(notional),
                'averagePrice': str(notional / requested) if remaining == 0 else None,
                'completeDepth': remaining == 0, 'qualified': False, 'actualFills': 0}
