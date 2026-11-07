import unittest
from copy import deepcopy
from decimal import Decimal, localcontext
import json
from carry_candle_screen import simulate, normalize, number
from binance_history import HOUR, POLICY


def data():
    row = lambda i:dict(timeMs=i*HOUR,open=Decimal('100'),high=Decimal('100'),low=Decimal('100'),close=Decimal('100'))
    return dict(spot=[row(i) for i in range(20)],perp=[row(i) for i in range(20)],mark=[row(i) for i in range(20)],
                step=Decimal('.001'),funding=[dict(timeMs=i*HOUR+1,slotMs=i*HOUR,rate=Decimal('.001'),mark=Decimal('120')) for i in (0,8,16)])


class CarryCandleTests(unittest.TestCase):
    def setUp(self): self.policy = json.loads(POLICY.read_text())

    def test_decomposition_uses_settlement_mark_and_reconciles_every_cost(self):
        result = simulate(data(),self.policy,'500',1,0,20)
        last = result['ledger'][-1]
        quantity = Decimal(result['quantityBase'])
        self.assertEqual(Decimal(last['cumulativeFundingQuote']),quantity*Decimal('120')*Decimal('.002'))
        self.assertNotEqual(Decimal(last['cumulativeFundingQuote']),quantity*Decimal('100')*Decimal('.002'))
        with localcontext() as ctx:
            ctx.prec = 50
            self.assertEqual(Decimal(last['conditionalNetQuote']),
                Decimal(last['referenceBasisPnlQuote'])+Decimal(last['cumulativeFundingQuote'])-
                Decimal(last['assumedFeesQuote'])-Decimal(last['assumedSlippageCostQuote'])-Decimal(last['assumedCapitalOpportunityCostQuote']))
        self.assertGreaterEqual(Decimal(result['unusedReserveQuote']),0)
        self.assertFalse(result['qualified']); self.assertIsNone(result['verifiedNetQuote'])

    def test_negative_funding_and_double_costs_reduce_net(self):
        baseline = simulate(data(),self.policy,'5000',1,0,20)
        stressed = simulate(data(),self.policy,'5000',2,0,20)
        self.assertLess(Decimal(stressed['conditionalNetQuote']),Decimal(baseline['conditionalNetQuote']))
        adverse = data()
        for event in adverse['funding']: event['rate'] = -event['rate']
        self.assertLess(Decimal(simulate(adverse,self.policy,'5000',1,0,20)['conditionalNetQuote']),0)

    def test_intrahour_margin_and_drawdown_rejections_never_invent_exit_fills(self):
        for kind in ('mark','perp'):
            changed = data(); changed[kind][4]['high'] = Decimal('300')
            result = simulate(changed,self.policy,'500',1,0,20)
            self.assertTrue(result['status'].startswith('rejected-possible-intrahour-'))
            self.assertIsNone(result['conditionalNetQuote'])
            self.assertEqual(result['actualFills'],0)
            self.assertLess(result['evaluatedThroughMs'],result['intendedExitTimeMs'])

    def test_heldout_does_not_receive_funding_from_development(self):
        changed = data()
        # Enter at hour 10; only the hour-16 event is eligible.
        policy = {**self.policy,'minimumRoundTripFundingIntervals':1}
        result = simulate(changed,policy,'500',1,9,20)
        self.assertEqual(Decimal(result['ledger'][-1]['cumulativeFundingQuote']),Decimal(result['quantityBase'])*Decimal('.12'))

    def test_normalization_rejects_units_identity_duplicate_or_gapped_funding(self):
        identity = lambda leg:dict(symbol='BTCUSDT',baseAsset='BTC',quoteAsset='USDT',status='TRADING',
            contractType='PERPETUAL',marginAsset='USDT',filters=[dict(filterType='LOT_SIZE',stepSize='.001')])
        raw = dict(identity={leg:identity(leg) for leg in ('spot','perp')},
            funding=[dict(symbol='BTCUSDT',fundingTime=i*HOUR,markPrice='100',fundingRate='.001') for i in (0,8,16)])
        for kind in ('spot','perp','mark'):
            raw[kind] = [[i*HOUR,'100','101','99','100','0',(i+1)*HOUR-1,'0',0,'0','0','0'] for i in range(24)]
        normalize('BTC',raw,0,24*HOUR)
        for mutate in (lambda d:d['spot'][1].__setitem__(0,0),
                       lambda d:d['spot'][0].__setitem__(1,100),
                       lambda d:d['identity']['perp'].update(baseAsset='ETH'),
                       lambda d:d['funding'].pop(),
                       lambda d:d['funding'][1].update(fundingTime=0),
                       lambda d:d['funding'][1].update(markPrice='NaN')):
            changed = deepcopy(raw); mutate(changed)
            with self.assertRaises(ValueError): normalize('BTC',changed,0,24*HOUR)


if __name__ == '__main__': unittest.main()
