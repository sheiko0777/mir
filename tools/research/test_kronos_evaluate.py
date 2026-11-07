import unittest
from copy import deepcopy
from kronos_evaluate import evaluate


class OutcomeTests(unittest.TestCase):
    def setUp(self):
        self.forecast = dict(schemaVersion=1,kind='kronos-forecast',market='test',contextAsOfMs=16000,
                             generatedAtMs=16500,futureCandleOpenTimesMs=[16000,17000,18000],
                             closePaths=[['105','104','104'],['107','106','108']],baselineLastClose='100')
        self.observed = dict(schemaVersion=1,kind='ohlcv-context',market='test',intervalMs=1000,asOfMs=19000,
            rows=[dict(timeMs=i*1000,open='100',high='110',low='99',close='106',volume='1') for i in range(2,19)])

    def test_exact_baseline_and_current_candle_exclusion(self):
        result = evaluate(self.forecast,self.observed,19000)
        self.assertEqual(result['eligibleCandles'],2)
        self.assertEqual(result['excludedInProgressCandles'],1)
        self.assertEqual(result['forecastMae'],'0.5')
        self.assertEqual(result['lastCloseBaselineMae'],'6')
        self.assertTrue(result['improvesOnLastClose'])
        self.assertFalse(result['qualified'])
        self.assertIsNone(result['netUsd'])

    def test_missing_future_keeps_metrics_unavailable(self):
        observed = deepcopy(self.observed)
        observed['rows'] = observed['rows'][:-1]
        observed['asOfMs'] = 18000
        result = evaluate(self.forecast,observed,19000)
        self.assertEqual(result['missingCandleOpenTimesMs'],[18000])
        self.assertNotIn('forecastMae',result)

    def test_rejects_market_gaps_units_chronology_and_nan(self):
        for mutate in (lambda f,o:o.update(market='other'),
                       lambda f,o:o['rows'][1].update(timeMs=2000),
                       lambda f,o:f.update(generatedAtMs=15000),
                       lambda f,o:f['closePaths'][0].__setitem__(0,'NaN'),
                       lambda f,o:f['closePaths'][0].__setitem__(0,100),
                       lambda f,o:f['futureCandleOpenTimesMs'].__setitem__(1,17001)):
            forecast,observed = deepcopy(self.forecast),deepcopy(self.observed)
            mutate(forecast,observed)
            with self.assertRaises(ValueError): evaluate(forecast,observed,19000)

    def test_model_can_lose_to_baseline(self):
        self.forecast['closePaths'] = [['200']*3,['220']*3]
        self.assertFalse(evaluate(self.forecast,self.observed,19000)['improvesOnLastClose'])


if __name__ == '__main__':
    unittest.main()
