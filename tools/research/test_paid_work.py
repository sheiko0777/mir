import json
from copy import deepcopy
from pathlib import Path
import unittest
from paid_work import analyze


class PaidWorkTests(unittest.TestCase):
    def setUp(self):
        self.doc = json.loads(Path(__file__).with_name('fixtures').joinpath('paid-work-illustrative.json').read_text())

    def test_shared_receipt_fee_once_and_failed_costs_preserved(self):
        result = analyze(self.doc)
        self.assertEqual(result['observedRewardAtomic'],'30')
        self.assertEqual(result['knownTransactionFeesAtomic'],'25')
        self.assertEqual(result['failedTransactions'],1)
        self.assertEqual(result['conditionalNetAtomic'],'0')
        self.assertEqual(result['doubledCostConditionalNetAtomic'],'-30')
        self.assertIsNone(result['mirRevenueReceived']); self.assertFalse(result['qualified'])

    def test_missing_costs_or_conversion_never_defaults_to_zero(self):
        for mutate in (lambda d:d['receipts'][0].update(totalFeeAtomic=None),
                       lambda d:d['operatingCostsAtomic'].update(support=None),
                       lambda d:d['operatingCostsAtomic'].pop('rpc'),
                       lambda d:d.update(costAsset='different-token')):
            doc = deepcopy(self.doc); mutate(doc)
            self.assertIsNone(analyze(doc)['conditionalNetAtomic'])

    def test_positive_arithmetic_is_not_promoted_to_mir_revenue(self):
        self.doc['rewardEvents'][0]['rewardAtomic']='90'
        result = analyze(self.doc)
        self.assertEqual(result['conditionalNetAtomic'],'70')
        self.assertEqual(result['doubledCostConditionalNetAtomic'],'40')
        self.assertFalse(result['qualified'])
        self.assertIsNone(result['mirRevenueReceived'])

    def test_protocol_accrual_cannot_masquerade_as_direct_payment(self):
        for semantics in (None,'accrued-claim-reward'):
            self.doc['rewardSemantics']=semantics
            with self.assertRaises(ValueError): analyze(self.doc)

    def test_duplicate_events_receipts_and_rewards_on_failed_transactions_rejected(self):
        for mutate in (lambda d:d['receipts'].append(d['receipts'][0]),
                       lambda d:d['rewardEvents'].append(d['rewardEvents'][0]),
                       lambda d:d['rewardEvents'][0].update(txHash=d['receipts'][1]['txHash']),
                       lambda d:d['rewardEvents'][0].update(recipient='0x'+'2'*40),
                       lambda d:d['rewardEvents'][0].update(rewardAtomic='1.1')):
            doc = deepcopy(self.doc); mutate(doc)
            with self.assertRaises(ValueError): analyze(doc)


if __name__ == '__main__': unittest.main()
