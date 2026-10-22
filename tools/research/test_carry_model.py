import unittest
from decimal import Decimal
from carry_model import replay


def observations():
    return [dict(timeMs=i * 3600000, spotBid='100', spotAsk='100', perpBid='100', perpAsk='100',
                 oracle='100', mark='100', fundingRate='0.001', otherCostUsd='0') for i in range(3)]


POLICY = dict(spotFeeBps='0', perpFeeBps='0', maintenanceMarginBps='500')


class CarryTests(unittest.TestCase):
    def test_fixed_quantity_and_entry_settlement(self):
        result = replay('500', observations(), POLICY)
        self.assertEqual(Decimal(result['quantity']), Decimal('2.5'))
        self.assertEqual(Decimal(result['scenarioNetUsd']), Decimal('.5'))
        self.assertEqual(Decimal(result['scenarioReturnOnCapital']), Decimal('.001'))
        self.assertEqual(result['ledger'][0]['fundingPaymentUsd'], '0')
        self.assertIsNone(result['netUsd'])

    def test_fees_basis_and_other_costs_reconcile(self):
        rows = observations(); rows[-1].update(perpBid='102', perpAsk='102', mark='102', otherCostUsd='1')
        result = replay('500', rows, {**POLICY, 'spotFeeBps': '10', 'perpFeeBps': '10'})
        row = result['ledger'][-1]
        expected = sum(Decimal(row[k]) for k in ('spotPnlUsd', 'perpPnlUsd', 'cumulativeFundingUsd')) - Decimal(row['feesUsd']) - Decimal(row['otherCostsUsd'])
        self.assertAlmostEqual(Decimal(row['scenarioNetUsd']), expected, places=20)
        self.assertLess(Decimal(result['scenarioNetUsd']), 0)

    def test_drawdown_stops_and_preserves_loss(self):
        rows = observations(); rows[1].update(spotBid='80', spotAsk='80')
        result = replay('500', rows, POLICY)
        self.assertEqual(result['status'], 'stopped-at-drawdown-limit')
        self.assertEqual(len(result['ledger']), 2)
        self.assertLess(Decimal(result['scenarioNetUsd']), 0)

    def test_margin_breach_and_unknown_cost_do_not_invent_net(self):
        rows = observations(); rows[1].update(perpBid='200', perpAsk='200', mark='200')
        result = replay('500', rows, POLICY)
        self.assertEqual(result['status'], 'margin-breach-unmodeled-liquidation')
        self.assertIsNone(result['scenarioNetUsd'])
        self.assertIsNone(replay('500', observations(), {})['netUsd'])
        rows = observations(); rows[1]['timeMs'] = 0
        with self.assertRaises(ValueError): replay('500', rows, POLICY)


if __name__ == '__main__': unittest.main()
