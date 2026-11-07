import json
from decimal import Decimal
import unittest
from lending_index import calculate, POLICY, RAY, Reader


class LendingIndexTests(unittest.TestCase):
    def setUp(self): self.policy = json.loads(POLICY.read_text())

    def test_atomic_accrual_and_total_capital_cost_reconcile(self):
        result = calculate('500',self.policy,RAY,101*RAY//100,365*86400,10**12,1<<56,1)
        self.assertEqual(Decimal(result['deployedAsset']),Decimal('475'))
        self.assertEqual(Decimal(result['grossIndexAccrualAsset']),Decimal('4.75'))
        self.assertEqual(Decimal(result['assumedCapitalOpportunityCostAsset']),Decimal('15'))
        self.assertEqual(Decimal(result['conditionalNetAsset']),Decimal('-12.25'))
        self.assertIsNone(result['verifiedNetAsset']); self.assertFalse(result['qualified'])

    def test_positive_scenario_still_has_no_verified_profit_and_cost_stress_can_reject(self):
        base = calculate('5000',self.policy,RAY,102*RAY//100,90*86400,10**12,1<<56,1)
        doubled = calculate('5000',self.policy,RAY,102*RAY//100,90*86400,10**12,1<<56,2)
        self.assertGreater(Decimal(base['conditionalNetAsset']),0)
        self.assertLess(Decimal(doubled['conditionalNetAsset']),Decimal(base['conditionalNetAsset']))
        self.assertIsNone(base['netUsd'])

    def test_frozen_paused_inactive_or_illiquid_reserve_rejects_positive_accrual(self):
        for config,liquidity in [(0,10**12),((1<<56)|(1<<57),10**12),((1<<56)|(1<<60),10**12),(1<<56,1)]:
            result = calculate('5000',self.policy,RAY,110*RAY//100,30*86400,liquidity,config,1)
            self.assertEqual(result['status'],'rejected-snapshot-constraints')
            self.assertTrue(result['reasons'])

    def test_regressed_indices_or_invalid_costs_are_not_replaced_with_zero(self):
        with self.assertRaises(ValueError): calculate('500',self.policy,RAY,RAY-1,86400,10**12,1<<56,1)
        with self.assertRaises(ValueError): calculate('500',{**self.policy,'roundTripCostReserveAsset':'100'},RAY,RAY,86400,10**12,1<<56,1)

    def test_rpc_write_methods_and_state_overrides_rejected_before_transport(self):
        # No ABI dependency or network needed to exercise admission policy.
        reader = Reader.__new__(Reader)
        reader.allowed = {('0x123','0x456')}; reader.records = []
        import time
        reader.began = time.monotonic()
        for method,params in [('eth_sendRawTransaction',['0x00']),('anvil_setBalance',[]),
                              ('eth_call',[dict(to='0x123',data='0x456'),'0x1',{}]),
                              ('eth_call',[dict(to='0x123',data='0x999'),'0x1'])]:
            with self.assertRaises(ValueError): reader.call(method,params)
        self.assertEqual(reader.records,[])


if __name__ == '__main__': unittest.main()
