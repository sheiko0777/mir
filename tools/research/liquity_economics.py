"""Offline conditional economics for a replay-verified Liquity WETH screen; never a profit certificate."""
import argparse
import hashlib
import json
from math import gcd
from pathlib import Path

from liquity_screen import replay_capture

ROOT = Path(__file__).resolve().parents[2]
FIXED_REWARD = 37500000000000000
COLLATERAL_DIVISOR = 200
COLLATERAL_CAP = 2 * 10 ** 18
COSTS = ('gasPriceWei', 'successGasUnits', 'failedGasUnits', 'successOtherWei',
         'failedOtherWei', 'settlementWei', 'sharedPerAttemptWei')


def amount(value):
    if not isinstance(value, str) or not value.isascii() or not value.isdecimal() or len(value) > 78 or str(int(value)) != value:
        raise ValueError('Amounts must be canonical unsigned decimal strings')
    n = int(value)
    if n >= 2 ** 256: raise ValueError('Amount outside uint256')
    return n


def validate_policy(policy):
    if not isinstance(policy, dict) or set(policy) != {'schemaVersion', 'origin', 'costs', 'winProbability'} or type(policy['schemaVersion']) is not int or policy['schemaVersion'] != 1 or policy['origin'] != 'assumed-scenario':
        raise ValueError('Explicit assumed-scenario policy required')
    if not isinstance(policy['costs'], dict) or set(policy['costs']) != set(COSTS): raise ValueError('Incomplete cost policy schema')
    for key, value in policy['costs'].items():
        if value is not None:
            n = amount(value)
            if key.endswith('GasUnits') and not 21000 <= n <= 10000000: raise ValueError('Gas scenario outside policy bounds')
    probability = policy['winProbability']
    if probability is not None:
        if not isinstance(probability, dict) or set(probability) != {'numerator', 'denominator'}: raise ValueError('Invalid probability schema')
        n, d = amount(probability['numerator']), amount(probability['denominator'])
        if not 0 <= n <= d or not 0 < d <= 10 ** 9: raise ValueError('Invalid win probability')
    return policy


def evaluate(collateral_atomic, policy):
    validate_policy(policy)
    collateral = amount(collateral_atomic)
    gross = FIXED_REWARD + min(collateral // COLLATERAL_DIVISOR, COLLATERAL_CAP)
    result = dict(modelVersion='liquity-weth-conditional-returns-v1',
                  unit='WETH-atomic-equivalent-native-wei', grossConditionalRewardAtomic=str(gross),
                  rewardBasis='source-formula-only-if-full-liquidation-succeeds',
                  conditionalNetAtomic=None, doubledCostConditionalNetAtomic=None,
                  probabilityWeightedScenarioNetAtomic=None, doubledCostProbabilityWeightedScenarioNetAtomic=None,
                  minimumWinProbabilityExclusive=None, qualified=False, verifiedNetAtomic=None,
                  reasons=['COSTS_AND_PROBABILITY_ARE_ASSUMPTIONS', 'NO_EXECUTION_OR_CASH_RECEIPT_PROOF'])
    missing = [key for key in COSTS if policy['costs'][key] is None]
    if missing:
        result['reasons'].append('MISSING_COST_INPUTS'); result['missingCostInputs'] = missing; return result
    costs = {key: amount(value) for key, value in policy['costs'].items()}
    success = costs['successGasUnits'] * costs['gasPriceWei'] + costs['successOtherWei'] + costs['settlementWei']
    failure = costs['failedGasUnits'] * costs['gasPriceWei'] + costs['failedOtherWei']
    shared = costs['sharedPerAttemptWei']
    result.update(successSpecificCostAtomic=str(success), failureSpecificCostAtomic=str(failure), sharedCostAtomic=str(shared),
                  conditionalNetAtomic=str(gross - success - shared), doubledCostConditionalNetAtomic=str(gross - 2 * (success + shared)))
    denominator, numerator = gross - success + failure, failure + shared
    if denominator > numerator and denominator > 0:
        divisor = gcd(numerator, denominator)
        result['minimumWinProbabilityExclusive'] = {'numerator': str(numerator // divisor), 'denominator': str(denominator // divisor)}
    else:
        result['reasons'].append('NO_FEASIBLE_POSITIVE_WIN_PROBABILITY_UNDER_POLICY')
    probability = policy['winProbability']
    if probability is None:
        result['reasons'].append('WIN_PROBABILITY_UNKNOWN'); return result
    n, d = amount(probability['numerator']), amount(probability['denominator'])
    weighted = n * (gross - success) - (d - n) * failure - d * shared
    stressed = n * (gross - 2 * success) - (d - n) * 2 * failure - d * 2 * shared
    result['probabilityWeightedScenarioNetAtomic'] = str(weighted // d)
    result['doubledCostProbabilityWeightedScenarioNetAtomic'] = str(stressed // d)
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--capture', required=True, type=Path)
    parser.add_argument('--policy', type=Path, default=ROOT / 'config/liquity-economics-policy.json')
    args = parser.parse_args()
    if args.policy.stat().st_size > 65536: raise ValueError('Policy exceeds size budget')
    policy_raw = args.policy.read_bytes(); policy = validate_policy(json.loads(policy_raw))
    screen = replay_capture(args.capture)
    cases = None if screen.get('candidates') is None else [dict(troveId=row['troveId'],
             economics=evaluate(row['entireCollAtomic'], policy)) for row in screen['candidates']]
    report = dict(schemaVersion=1, kind='liquity-economic-scenarios', sourceCaptureSha256=args.capture.stem,
                  sourceBlockHash=screen['blockHash'], policySha256=hashlib.sha256(policy_raw).hexdigest(), policy=policy,
                  screenStatus=screen['status'], cases=cases, qualified=False, verifiedNetAtomic=None,
                  limitations=['Conditional formula, not executed cash flow', 'WETH/native unit equivalence assumes redemption; settlement cost is explicit',
                               'No full-risk, independent-holdout or forward-profit proof'])
    payload = json.dumps(report, sort_keys=True, allow_nan=False).encode(); identity = hashlib.sha256(payload).hexdigest()
    folder = ROOT / 'data/liquity-economics'; folder.mkdir(parents=True, exist_ok=True)
    target = folder / (identity + '.json')
    if target.exists():
        if target.read_bytes() != payload: raise ValueError('Existing report content mismatch')
    else:
        temporary = folder / ('.' + identity + '.pending')
        with temporary.open('xb') as stream: stream.write(payload)
        temporary.replace(target)
    print(json.dumps({'id': identity, 'cases': len(cases) if cases is not None else None, 'qualified': False, 'verifiedNetAtomic': None}))


if __name__ == '__main__': main()
