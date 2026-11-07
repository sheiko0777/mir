"""Local Kronos source adapter. Each sampled path is requested independently."""
import argparse
from decimal import Decimal
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import time

SOURCE_COMMIT = '67b630e67f6a18c9e9be918d9b4337c960db1e9a'
ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'work/upstream-video-sources/kronos'
WEIGHTS = ROOT / 'tools/models/kronos-small'
TOKENIZER = ROOT / 'tools/models/kronos-tokenizer-base'


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
    paths = sample_paths(predictor, frame, stamps, future, args.horizon, args.samples, seed_path)
    result = {'schemaVersion': 1, 'kind': 'kronos-forecast', 'market': document['market'],
              'sourceCommit': commit, 'sourceFileSha256': source_hashes,
              'contextSha256': hashlib.sha256(raw).hexdigest(), 'contextAsOfMs': document['asOfMs'],
              'generatedAtMs': int(time.time() * 1000), 'futureCandleOpenTimesMs': future_ms,
              'closePaths': paths, 'sampleSeeds': list(range(args.samples)),
              'baselineLastClose': rows[-1]['close'], 'qualified': False, 'netUsd': None,
              'weightsProvenance': 'operator-supplied-local-files',
              'validationStatus': 'awaiting-observed-outcomes-and-cost-evaluation'}
    target_folder = ROOT / 'data/bots/kronos'
    target_folder.mkdir(parents=True, exist_ok=True)
    payload = json.dumps(result, sort_keys=True, allow_nan=False).encode()
    target = target_folder / (hashlib.sha256(payload).hexdigest() + '.json')
    with target.open('xb') as output:
        output.write(payload)
    print(json.dumps({'file': str(target), 'paths': len(paths), 'qualified': False, 'netUsd': None}))


if __name__ == '__main__':
    main()
