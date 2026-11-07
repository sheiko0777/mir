"""Local Kronos source adapter. Each sampled path is requested independently."""
import argparse
from decimal import Decimal
import hashlib
import importlib.util
import importlib.metadata
import json
import os
from pathlib import Path
import random
from statistics import median
import subprocess
import sys
import time

SOURCE_COMMIT = '67b630e67f6a18c9e9be918d9b4337c960db1e9a'
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'work/upstream-video-sources/kronos'
WEIGHTS = ROOT / 'tools/models/kronos-small'
TOKENIZER = ROOT / 'tools/models/kronos-tokenizer-base'


def verify_models():
    manifest_raw = (ROOT / 'tools/research/kronos-models.json').read_bytes()
    manifest = json.loads(manifest_raw)
    expected = {'NeoQuasar/Kronos-small':'kronos-small', 'NeoQuasar/Kronos-Tokenizer-base':'kronos-tokenizer-base'}
    if len(manifest) != 2 or {entry['repo'] for entry in manifest} != set(expected):
        raise ValueError('Unexpected model manifest')
    for entry in manifest:
        if expected[entry['repo']] != entry['folder'] or entry['license'] != 'MIT' or \
                {item['name'] for item in entry['files']} != {'README.md','config.json','model.safetensors'}:
            raise ValueError('Unexpected model layout')
        for item in entry['files']:
            path = ROOT / 'tools/models' / entry['folder'] / item['name']
            with path.open('rb') as stream:
                sha = hashlib.file_digest(stream, 'sha256').hexdigest()
            if path.stat().st_size != item['size'] or sha != item['sha256']:
                raise ValueError('Model artifact changed')
    return {'manifestSha256':hashlib.sha256(manifest_raw).hexdigest(), 'models':manifest}


def validate_context(document, now_ms):
    if document.get('schemaVersion') != 1 or document.get('kind') != 'ohlcv-context' or \
            not isinstance(document.get('market'), str) or not document['market'] or \
            type(document.get('intervalMs')) is not int or document['intervalMs'] <= 0 or \
            type(document.get('asOfMs')) is not int or not 0 <= document['asOfMs'] <= now_ms:
        raise ValueError('Invalid timestamped OHLCV context')
    rows = document.get('rows')
    if not isinstance(rows, list) or not 16 <= len(rows) <= 512:
        raise ValueError('Kronos context requires 16..512 closed candles')
    previous = None
    for row in rows:
        stamp = row.get('timeMs')
        if type(stamp) is not int or stamp < 0 or stamp + document['intervalMs'] > document['asOfMs'] or \
                previous is not None and stamp - previous != document['intervalMs']:
            raise ValueError('Gapped, duplicate or unfinished candle')
        previous = stamp
        values = {}
        for field in ('open', 'high', 'low', 'close', 'volume'):
            if not isinstance(row.get(field), str):
                raise ValueError('OHLCV amounts require decimal strings')
            value = Decimal(row[field])
            if not value.is_finite() or value < 0 or value > Decimal('1e20'):
                raise ValueError('Invalid OHLCV amount')
            values[field] = value
        if values['low'] <= 0 or not values['low'] <= min(values['open'], values['close']) <= \
                max(values['open'], values['close']) <= values['high']:
            raise ValueError('Inconsistent candle bounds')
    if document['asOfMs'] - rows[-1]['timeMs'] - document['intervalMs'] >= document['intervalMs']:
        raise ValueError('Context omits a completed candle')
    return rows


def sample_paths(predictor, frame, timestamps, future, horizon, samples, seed_path=None):
    if type(horizon) is not int or not 1 <= horizon <= 24 or type(samples) is not int or not 2 <= samples <= 16:
        raise ValueError('Forecast admission budget exceeded')
    began = time.monotonic()
    paths = []
    for index in range(samples):
        if time.monotonic() - began > 180:
            raise ValueError('Forecast admission deadline exhausted')
        if seed_path:
            seed_path(index)
        prediction = predictor.predict(df=frame.copy(), x_timestamp=timestamps, y_timestamp=future,
                                       pred_len=horizon, T=1.0, top_p=0.9, sample_count=1, verbose=False)
        values = list(prediction['close'])
        if len(values) != horizon:
            raise ValueError('Forecast horizon mismatch')
        path = []
        for value in values:
            price = Decimal(str(value))
            if not price.is_finite() or not 0 < price <= Decimal('1e20'):
                raise ValueError('Invalid generated price')
            path.append(str(price))
        paths.append(path)
    return paths


def historical_split(document, horizon, now_ms):
    rows = validate_context(document, now_ms)
    if type(horizon) is not int or not 1 <= horizon <= 24 or len(rows)-horizon < 16:
        raise ValueError('Historical holdout leaves insufficient context')
    training = {**document, 'rows':rows[:-horizon], 'asOfMs':rows[-horizon]['timeMs']}
    validate_context(training,now_ms)
    return training, rows[-horizon:]


def preflight():
    missing = [name for name in ('torch', 'pandas', 'numpy', 'einops', 'huggingface_hub', 'safetensors', 'tqdm')
               if importlib.util.find_spec(name) is None]
    return {'missingPackages': missing, 'localWeightsPresent': WEIGHTS.is_dir(),
            'localTokenizerPresent': TOKENIZER.is_dir(), 'sourcePresent': (SOURCE / 'model/kronos.py').is_file(),
            'expectedSourceCommit': SOURCE_COMMIT}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--context', type=Path)
    parser.add_argument('--horizon', type=int, default=24, choices=range(1, 25))
    parser.add_argument('--samples', type=int, default=8, choices=range(2, 17))
    parser.add_argument('--lookback', type=int, default=512, choices=range(16,513))
    parser.add_argument('--historical-tail', action='store_true',
                        help='Withhold the last horizon candles for a retrospective forecast diagnostic, not a strategy backtest')
    args = parser.parse_args()
    readiness = preflight()
    if args.check:
        print(json.dumps(readiness))
        return
    if args.context is None:
        parser.error('--context is required for a forecast')
    if readiness['missingPackages'] or not all(readiness[key] for key in ('localWeightsPresent', 'localTokenizerPresent', 'sourcePresent')):
        raise ValueError('Kronos runtime requires reviewed local packages, weights and tokenizer. Run --check.')
    commit = subprocess.run(['git', '-C', str(SOURCE), 'rev-parse', 'HEAD'], check=True,
                            capture_output=True, text=True, timeout=10).stdout.strip()
    if commit != SOURCE_COMMIT:
        raise ValueError('Kronos source revision changed')
    source_hashes = {}
    for name in ('__init__.py', 'kronos.py', 'module.py'):
        file = SOURCE / 'model' / name
        # Compare the actual import bytes with the pinned Git object, including CRLF conversion.
        canonical = subprocess.run(['git', '-C', str(SOURCE), 'show', f'{SOURCE_COMMIT}:model/{name}'],
                                   check=True, capture_output=True, timeout=10).stdout.replace(b'\r\n', b'\n')
        raw = file.read_bytes()
        if raw.replace(b'\r\n', b'\n') != canonical:
            raise ValueError('Kronos import source was modified')
        source_hashes[name] = hashlib.sha256(raw).hexdigest()
    if args.context.stat().st_size > 1024 * 1024:
        raise ValueError('Context exceeds 1 MiB')
    raw = args.context.read_bytes()
    if len(raw) > 1024 * 1024:
        raise ValueError('Context exceeds 1 MiB')
    document = json.loads(raw)
    rows = validate_context(document, int(time.time() * 1000))
    held_out = None
    if args.historical_tail:
        document, held_out = historical_split(document,args.horizon,int(time.time()*1000))
        rows = document['rows']
    rows = rows[-args.lookback:]
    model_provenance = verify_models()
    resources = json.loads((ROOT / 'tools/research/kronos-resources.json').read_text(encoding='utf-8'))
    if Path(sys.prefix).resolve() != (ROOT / 'tools/research/.venv-kronos').resolve() or \
            any(importlib.metadata.version(r['name']) != r['version'] or
                r['status'] != 'installed-isolated; version-verified; torch-cpu-smoke-passed' for r in resources):
        raise ValueError('Reviewed isolated runtime audit required')
    os.environ['HF_HUB_OFFLINE'] = '1'
    os.environ['HF_HUB_DISABLE_TELEMETRY'] = '1'
    sys.path.insert(0, str(SOURCE))
    import numpy as np
    import pandas as pd
    import torch
    from model import Kronos, KronosTokenizer, KronosPredictor
    torch.set_num_threads(2)
    predictor = KronosPredictor(Kronos.from_pretrained(str(WEIGHTS)),
                               KronosTokenizer.from_pretrained(str(TOKENIZER)), device='cpu', max_context=512)
    frame = pd.DataFrame([{key: float(row[key]) for key in ('open', 'high', 'low', 'close', 'volume')} for row in rows])
    stamps = pd.Series(pd.to_datetime([row['timeMs'] for row in rows], unit='ms', utc=True))
    future_ms = [rows[-1]['timeMs'] + document['intervalMs'] * (index + 1) for index in range(args.horizon)]
    future = pd.Series(pd.to_datetime(future_ms, unit='ms', utc=True))
    def seed_path(index):
        random.seed(index)
        np.random.seed(index)
        torch.manual_seed(index)
    inference_began = time.monotonic()
    paths = sample_paths(predictor, frame, stamps, future, args.horizon, args.samples, seed_path)
    inference_elapsed_ms = round((time.monotonic()-inference_began)*1000)
    result = {'schemaVersion': 1, 'kind': 'kronos-forecast', 'market': document['market'],
              'sourceCommit': commit, 'sourceFileSha256': source_hashes,
              'contextSha256': hashlib.sha256(raw).hexdigest(), 'contextAsOfMs': document['asOfMs'],
              'generatedAtMs': int(time.time() * 1000), 'futureCandleOpenTimesMs': future_ms,
              'closePaths': paths, 'sampleSeeds': list(range(args.samples)),
              'inferenceElapsedMs': inference_elapsed_ms, 'device':'cpu', 'torchThreads':2,
              'contextCandles':len(rows), 'requestedLookback':args.lookback,
              'baselineLastClose': rows[-1]['close'], 'qualified': False, 'netUsd': None,
              'weightsProvenance': model_provenance,
              'runtimeVersions': {name:importlib.metadata.version(name) for name in
                                  ('torch','numpy','pandas','einops','huggingface_hub','safetensors','tqdm')},
              'derivedInputAssumption':'upstream amount feature = volume * mean(open,high,low,close); not observed quote volume',
              'validationStatus': 'awaiting-observed-outcomes-and-cost-evaluation'}
    if held_out is not None:
        predictions = [median([Decimal(path[i]) for path in paths]) for i in range(args.horizon)]
        actual = [Decimal(row['close']) for row in held_out]
        baseline = Decimal(rows[-1]['close'])
        model_error = sum(abs(p-a) for p,a in zip(predictions,actual)) / args.horizon
        baseline_error = sum(abs(baseline-a) for a in actual) / args.horizon
        result.update(kind='kronos-historical-diagnostic', heldOutCandles=args.horizon,
                      contextCandles=len(rows), forecastMae=str(model_error),
                      lastCloseBaselineMae=str(baseline_error), improvesOnLastClose=model_error < baseline_error,
                      actualCloses=[str(a) for a in actual],
                      validationStatus='retrospective-single-window; profitability-unproven',
                      limitations=['upstream pretraining overlap unknown',
                                   'one forecast window; no independent strategy holdout',
                                   'no order-book fills or complete trading costs'])
    target_folder = ROOT / 'data/bots/kronos'
    target_folder.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(result, sort_keys=True, allow_nan=False).encode()
    target = target_folder / (hashlib.sha256(payload).hexdigest() + '.json')
    with target.open('xb') as output:
        output.write(payload)
    print(json.dumps({'file': str(target), 'paths': len(paths), 'kind':result['kind'],
                      'forecastMae':result.get('forecastMae'), 'lastCloseBaselineMae':result.get('lastCloseBaselineMae'),
                      'qualified': False, 'netUsd': None}))


if __name__ == '__main__':
    main()
