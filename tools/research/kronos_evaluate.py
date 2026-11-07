"""Evaluate timestamped forecasts against later closed candles, never infer fills from candles."""
import argparse
from decimal import Decimal
import hashlib
import json
from pathlib import Path
from statistics import median
import time
from kronos_adapter import validate_context

ROOT = Path(__file__).resolve().parents[2]


def evaluate(forecast, observations, now_ms):
    rows = validate_context(observations, now_ms)
    if forecast.get('kind') != 'kronos-forecast' or forecast.get('schemaVersion') != 1 or \
            forecast.get('market') != observations['market']:
        raise ValueError('Forecast/observation market identity mismatch')
    generated = forecast.get('generatedAtMs')
    times = forecast.get('futureCandleOpenTimesMs')
    paths = forecast.get('closePaths')
    interval = observations['intervalMs']
    if type(generated) is not int or not 0 <= generated <= now_ms or \
            type(forecast.get('contextAsOfMs')) is not int or forecast['contextAsOfMs'] > generated or \
            not isinstance(times,list) or not 1 <= len(times) <= 24 or \
            any(type(t) is not int or t != forecast['contextAsOfMs'] + i*interval for i,t in enumerate(times)) or \
            not isinstance(paths,list) or not 2 <= len(paths) <= 16 or any(len(p) != len(times) for p in paths):
        raise ValueError('Invalid forecast chronology or paths')
    def price(value):
        if not isinstance(value,str):
            raise ValueError('Prices require decimal strings')
        result = Decimal(value)
        if not result.is_finite() or not 0 < result <= Decimal('1e20'):
            raise ValueError('Invalid forecast price')
        return result
    baseline = price(forecast['baselineLastClose'])
    predictions = [median([price(p[i]) for p in paths]) for i in range(len(times))]
    # Exclude the candle already in progress when the forecast was generated.
    eligible = [(i,t) for i,t in enumerate(times) if t >= generated]
    observed = {row['timeMs']:row for row in rows}
    missing = [t for _,t in eligible if t not in observed or t+interval > observations['asOfMs']]
    result = dict(schemaVersion=1,kind='kronos-outcome-evaluation',market=forecast['market'],
                  eligibleCandles=len(eligible),excludedInProgressCandles=len(times)-len(eligible),
                  missingCandleOpenTimesMs=missing,qualified=False,netUsd=None,actualFills=0,
                  decision='insufficient-evidence',limitations=['forecast accuracy is not executable profit',
                    'no order-book fills, funding, margin or complete costs evaluated',
                    'one forecast is not an independent strategy holdout'])
    if missing or not eligible:
        return result
    predicted_error, baseline_error, coverage = Decimal(0), Decimal(0), 0
    for i,t in eligible:
        actual = price(observed[t]['close'])
        predicted_error += abs(predictions[i]-actual)
        baseline_error += abs(baseline-actual)
        samples = [price(p[i]) for p in paths]
        coverage += min(samples) <= actual <= max(samples)
    count = Decimal(len(eligible))
    result.update(forecastMae=str(predicted_error/count),lastCloseBaselineMae=str(baseline_error/count),
                  improvesOnLastClose=predicted_error < baseline_error,
                  sampleRangeCoverage=str(Decimal(coverage)/count),
                  coverageInterpretation='sample min/max range; not calibrated confidence',
                  decision='forecast-measured; profitability-unproven')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--forecast',type=Path,required=True)
    parser.add_argument('--observations',type=Path,required=True)
    args = parser.parse_args()
    sources = []
    for path in (args.forecast,args.observations):
        if path.stat().st_size > 2*1024*1024:
            raise ValueError('Input budget exceeded')
        sources.append(path.read_bytes())
    result = evaluate(*(json.loads(raw) for raw in sources),int(time.time()*1000))
    result.update(forecastSha256=hashlib.sha256(sources[0]).hexdigest(),
                  observationsSha256=hashlib.sha256(sources[1]).hexdigest(),
                  evaluatedAtMs=int(time.time()*1000),
                  evaluatorSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    payload = json.dumps(result,sort_keys=True).encode()
    folder = ROOT / 'data/bots/kronos-evaluations'
    folder.mkdir(parents=True,exist_ok=True)
    target = folder / (hashlib.sha256(payload).hexdigest()+'.json')
    with target.open('xb') as stream:
        stream.write(payload)
    print(json.dumps({'file':str(target),**result}))


if __name__ == '__main__':
    main()
