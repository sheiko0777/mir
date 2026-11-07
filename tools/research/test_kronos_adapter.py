import unittest
from copy import deepcopy
import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

from kronos_adapter import sample_paths, validate_context, historical_split, verify_models


class Predictor:
    def __init__(self):
        self.calls = []

    def predict(self, **options):
        self.calls.append(options)
        options['df'].append('model-added-column')
        return {'close': ['100', str(100 + len(self.calls))]}


class KronosAdapterTests(unittest.TestCase):
    def test_model_files_are_rehashed_before_import(self):
        with TemporaryDirectory() as directory:
            root = Path(directory)
            manifest = []
            for repo,folder in [('NeoQuasar/Kronos-small','kronos-small'),
                                ('NeoQuasar/Kronos-Tokenizer-base','kronos-tokenizer-base')]:
                files = []
                for name in ('README.md','config.json','model.safetensors'):
                    raw = b'model-test-fixture'
                    path = root / 'tools/models' / folder / name
                    path.parent.mkdir(parents=True,exist_ok=True)
                    path.write_bytes(raw)
                    files.append(dict(name=name,size=len(raw),sha256=hashlib.sha256(raw).hexdigest()))
                manifest.append(dict(repo=repo,folder=folder,license='MIT',files=files))
            location = root / 'tools/research/kronos-models.json'
            location.parent.mkdir(parents=True)
            location.write_text(json.dumps(manifest),encoding='utf-8')
            with patch('kronos_adapter.ROOT',root):
                self.assertEqual(len(verify_models()['models']),2)
                (root / 'tools/models/kronos-small/model.safetensors').write_bytes(b'altered-test-model')
                with self.assertRaises(ValueError): verify_models()

    def test_historical_targets_are_absent_from_model_context(self):
        document = {'schemaVersion':1,'kind':'ohlcv-context','market':'test','intervalMs':1000,'asOfMs':40000,
                    'rows':[dict(timeMs=i*1000,open='100',high='102',low='99',close='101',volume='1') for i in range(40)]}
        training, targets = historical_split(document,24,40000)
        self.assertEqual(len(training['rows']),16)
        self.assertEqual(len(targets),24)
        self.assertEqual(training['asOfMs'],targets[0]['timeMs'])
        self.assertTrue(all(row['timeMs'] < targets[0]['timeMs'] for row in training['rows']))
        self.assertEqual(len(document['rows']),40)
        with self.assertRaises(ValueError): historical_split({**document,'rows':document['rows'][1:]},24,40000)

    def test_paths_are_kept_separate_and_single_sample_mode_is_used(self):
        predictor, frame, seeds = Predictor(), [], []
        paths = sample_paths(predictor, frame, [], [], 2, 3, seeds.append)
        self.assertEqual(paths, [['100', '101'], ['100', '102'], ['100', '103']])
        self.assertEqual(seeds, [0, 1, 2])
        self.assertEqual(frame, [])
        self.assertTrue(all(call['sample_count'] == 1 for call in predictor.calls))
        with self.assertRaises(ValueError): sample_paths(predictor, frame, [], [], 2, 100)

    def test_context_rejects_future_unfinished_gapped_and_inconsistent_candles(self):
        document = {'schemaVersion': 1, 'kind': 'ohlcv-context', 'market': 'BTCUSDT',
                    'intervalMs': 1000, 'asOfMs': 16000,
                    'rows': [dict(timeMs=i * 1000, open='100', high='102', low='99', close='101', volume='1') for i in range(16)]}
        self.assertEqual(len(validate_context(document, 16000)), 16)
        for mutate in (lambda d: d.update(asOfMs=15999),
                       lambda d: d['rows'][3].update(timeMs=2000),
                       lambda d: d['rows'][0].update(high='99'),
                       lambda d: d['rows'][0].update(close='NaN')):
            copy = deepcopy(document)
            mutate(copy)
            with self.assertRaises(ValueError): validate_context(copy, 16000)

    def test_model_failure_and_malformed_output_are_propagated(self):
        class Failed:
            def predict(self, **options):
                raise RuntimeError('Model load failed')
        with self.assertRaises(RuntimeError): sample_paths(Failed(), [], [], [], 2, 2)
        class Bad:
            def predict(self, **options):
                return {'close': ['NaN', '1']}
        with self.assertRaises(ValueError): sample_paths(Bad(), [], [], [], 2, 2)


if __name__ == '__main__':
    unittest.main()
