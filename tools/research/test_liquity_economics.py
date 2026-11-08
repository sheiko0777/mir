import unittest
from liquity_economics import evaluate, validate_policy, FIXED_REWARD, COLLATERAL_CAP


def policy():
    return {'schemaVersion': 1, 'origin': 'assumed-scenario', 'costs': {
        'gasPriceWei': '20000000000', 'successGasUnits': '300000', 'failedGasUnits': '300000',
        'successOtherWei': '0', 'failedOtherWei': '0', 'settlementWei': '100000000000000',
        'sharedPerAttemptWei': '0'}, 'winProbability': None}


class LiquidationEconomicsTests(unittest.TestCase):
    def test_reward_rounding_and_cap_follow_source_constants(self):
        p = policy()
        self.assertEqual(evaluate('199', p)['grossConditionalRewardAtomic'], str(FIXED_REWARD))
        self.assertEqual(evaluate('200', p)['grossConditionalRewardAtomic'], str(FIXED_REWARD + 1))
        self.assertEqual(evaluate(str(1000 * 10 ** 18), p)['grossConditionalRewardAtomic'], str(FIXED_REWARD + COLLATERAL_CAP))

    def test_missing_cost_is_unknown_and_missing_probability_is_not_one(self):
        p = policy(); p['costs']['sharedPerAttemptWei'] = None
        result = evaluate(str(2 * 10 ** 18), p)
        self.assertIsNone(result['conditionalNetAtomic']); self.assertIn('sharedPerAttemptWei', result['missingCostInputs'])
        result = evaluate(str(2 * 10 ** 18), policy())
        self.assertEqual(result['conditionalNetAtomic'], '41400000000000000')
        self.assertEqual(result['doubledCostConditionalNetAtomic'], '35300000000000000')
        self.assertIsNone(result['probabilityWeightedScenarioNetAtomic'])
        self.assertIn('WIN_PROBABILITY_UNKNOWN', result['reasons'])

    def test_positive_success_case_can_be_negative_when_competition_is_accounted_for(self):
        p = policy(); p['winProbability'] = {'numerator': '1', 'denominator': '20'}
        result = evaluate(str(2 * 10 ** 18), p)
        self.assertGreater(int(result['conditionalNetAtomic']), 0)
        self.assertEqual(result['probabilityWeightedScenarioNetAtomic'], '-3630000000000000')
        self.assertEqual(result['doubledCostProbabilityWeightedScenarioNetAtomic'], '-9635000000000000')
        self.assertFalse(result['qualified']); self.assertIsNone(result['verifiedNetAtomic'])

    def test_probability_endpoints_match_success_and_failure_ledgers(self):
        p = policy(); p['costs']['sharedPerAttemptWei'] = '7'
        p['winProbability'] = {'numerator': '1', 'denominator': '1'}
        result = evaluate(str(2 * 10 ** 18), p)
        self.assertEqual(result['probabilityWeightedScenarioNetAtomic'], result['conditionalNetAtomic'])
        p['winProbability'] = {'numerator': '0', 'denominator': '1'}
        result = evaluate(str(2 * 10 ** 18), p)
        self.assertEqual(result['probabilityWeightedScenarioNetAtomic'], '-6000000000000007')

    def test_break_even_probability_is_strict_and_uses_exact_rational_arithmetic(self):
        p = policy()
        result = evaluate(str(2 * 10 ** 18), p)
        self.assertEqual(result['minimumWinProbabilityExclusive'], {'numerator': '10', 'denominator': '79'})
        for numerator, sign in [('9', -1), ('10', 0), ('11', 1)]:
            p['winProbability'] = {'numerator': numerator, 'denominator': '79'}
            net = int(evaluate(str(2 * 10 ** 18), p)['probabilityWeightedScenarioNetAtomic'])
            self.assertEqual((net > 0) - (net < 0), sign)
        p['costs']['gasPriceWei'] = '1000000000000'
        self.assertIsNone(evaluate(str(2 * 10 ** 18), p)['minimumWinProbabilityExclusive'])

    def test_invalid_probability_float_secret_fields_and_unknown_cost_schema_are_rejected(self):
        for change in [{'numerator': '2', 'denominator': '1'}, {'numerator': '0', 'denominator': '0'}, 0.5]:
            p = policy(); p['winProbability'] = change
            with self.assertRaises(ValueError): validate_policy(p)
        p = policy(); p['wallet'] = 'not-accepted'
        with self.assertRaises(ValueError): validate_policy(p)
        p = policy(); p['costs']['gasPriceWei'] = '1e9'
        with self.assertRaises(ValueError): validate_policy(p)
        p = policy(); p['origin'] = 'measured'
        with self.assertRaises(ValueError): validate_policy(p)


if __name__ == '__main__': unittest.main()
