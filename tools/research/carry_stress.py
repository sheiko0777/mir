"""Deterministic sensitivity screening of supplied carry scenarios; no market IO."""
import argparse
from copy import deepcopy
from decimal import Decimal, localcontext
import hashlib
import json
from pathlib import Path

from carry_model import number, replay

CAPITALS = ('500', '5000', '50000')
CASES = ('baseline', 'double-costs', 'double-quote-penalty',
         'double-costs-and-quote-penalty', 'adverse-funding')
MAX_INPUT_BYTES = 4 * 1024 * 1024


def encode(value):
    return json.dumps(value, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def sha(value):
    return hashlib.sha256(value).hexdigest()


def transform(observations, policy, case):
    """Double quote distances from each midpoint, not observed or inferred fills."""
    rows, changed_policy = deepcopy(observations), deepcopy(policy)
    with localcontext() as context:
        context.prec = 50
        if case in ('double-costs', 'double-costs-and-quote-penalty'):
            for field in ('spotFeeBps', 'perpFeeBps'):
                if changed_policy.get(field) is not None:
                    changed_policy[field] = str(number(changed_policy[field], True) * 2)
            for row in rows:
                if row.get('otherCostUsd') is not None:
                    row['otherCostUsd'] = str(number(row['otherCostUsd'], True) * 2)
        if case in ('double-quote-penalty', 'double-costs-and-quote-penalty'):
            for row in rows:
                for leg in ('spot', 'perp'):
                    if row.get(leg + 'Bid') is None or row.get(leg + 'Ask') is None:
                        continue
                    bid, ask = number(row[leg + 'Bid'], True), number(row[leg + 'Ask'], True)
                    midpoint = (bid + ask) / 2
                    stressed_bid = midpoint - (ask - bid)
                    if stressed_bid <= 0:
                        # No feasible executable-side quote. Do not invent a zero-price fill.
                        row[leg + 'Bid'] = None
                    else:
                        row[leg + 'Bid'] = str(stressed_bid)
                    row[leg + 'Ask'] = str(midpoint + (ask - bid))
        if case == 'adverse-funding':
            for row in rows:
                if row.get('fundingRate') is not None:
                    # Positive funding flips; already adverse funding remains adverse.
                    row['fundingRate'] = str(-abs(number(row['fundingRate'])))
    return rows, changed_policy


def evaluate(document):
    if not isinstance(document, dict) or document.get('schemaVersion') != 1 or \
            document.get('kind') != 'carry-scenario' or document.get('evidenceKind') not in ('illustrative', 'supplied-scenario'):
        raise ValueError('Explicit carry-scenario evidence label required')
    rows, policy = document.get('observations'), document.get('policy')
    if not isinstance(rows, list) or not 2 <= len(rows) <= 2161 or \
            not all(isinstance(row, dict) for row in rows) or not isinstance(policy, dict):
        raise ValueError('Expected 2..2161 observations and a policy')
    # Check original inputs before stress transforms; unknowns remain fail-closed.
    replay('500', rows, policy)
    results = []
    for capital in CAPITALS:
        for case in CASES:
            altered_rows, altered_policy = transform(rows, policy, case)
            result = replay(capital, altered_rows, altered_policy)
            results.append({'capitalUsd': capital, 'case': case, 'result': result})
    screens = []
    for capital in CAPITALS:
        group = [item for item in results if item['capitalUsd'] == capital]
        reasons, incomplete, stress_findings = [], [], []
        for item in group:
            result, case = item['result'], item['case']
            required = case in ('baseline', 'double-costs-and-quote-penalty')
            if result.get('scenarioNetUsd') is None and required:
                incomplete.append(case)
            if result.get('status') in ('stopped-at-drawdown-limit', 'margin-breach-unmodeled-liquidation'):
                (reasons if required else stress_findings).append(case + ':risk-stop')
            elif result.get('scenarioNetUsd') is not None and Decimal(result['scenarioNetUsd']) <= 0:
                (reasons if required else stress_findings).append(case + ':nonpositive-scenario-net')
        screens.append({'capitalUsd': capital,
                        'status': 'rejected-scenario' if reasons else 'incomplete' if incomplete else 'survived-scenario-screen',
                        'reasons': reasons, 'incompleteCases': incomplete, 'stressFindings': stress_findings})
    return {'schemaVersion': 1, 'model': 'carry-stress-v1', 'evidenceKind': document['evidenceKind'],
            'inputSemanticSha256': sha(encode(document)), 'decision': 'insufficient-evidence',
            'qualified': False, 'netUsd': None, 'screens': screens, 'cases': results,
            'limitations': ['All PnL is conditional scenario PnL, never verified market profit.',
                            'Original inputs are not certified for hedge identity, depth, time alignment or complete costs.',
                            'Each case recomputes quantity using the same capital allocation rule and its stressed entry fee/quote.',
                            'Quote stress doubles bid/ask distances from midpoint; it is not a depth-dependent slippage model.',
                            'Adverse funding is -abs(rate); cases keep their original timestamps and do not predict future rates.',
                            'Screen gates require positive baseline and combined-cost scenario; other stresses are retained as risk findings.',
                            'No source-outage or missing-liquidity fills are inferred; missing inputs remain unknown.',
                            'No independent 60/30 holdout, intrainterval liquidation or forward validation is established.']}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('input', type=Path)
    args = parser.parse_args()
    if args.input.stat().st_size > MAX_INPUT_BYTES:
        raise ValueError('Input exceeds 4 MiB budget')
    raw = args.input.read_bytes()
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError('Input exceeds 4 MiB budget')
    def unique(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError('Duplicate JSON key')
            result[key] = value
        return result
    report = evaluate(json.loads(raw, object_pairs_hook=unique))
    report['inputRawSha256'] = sha(raw)
    here = Path(__file__).resolve().parent
    report['engineSourcesSha256'] = {name: sha((here / name).read_bytes())
                                     for name in ('carry_stress.py', 'carry_model.py')}
    payload = encode(report)
    if len(payload) > 32 * 1024 * 1024:
        raise ValueError('Report exceeds 32 MiB storage budget')
    folder = here.parents[1] / 'data' / 'carry-stress'
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / (sha(payload) + '.json')
    try:
        with target.open('xb') as output:
            output.write(payload)
    except FileExistsError:
        if target.read_bytes() != payload:
            raise ValueError('Existing immutable report integrity mismatch')
    print(json.dumps({'report': str(target), 'decision': report['decision'],
                      'qualified': False, 'netUsd': None, 'screens': report['screens']}))


if __name__ == '__main__':
    main()
