import unittest
import tempfile
import hashlib
import json
from pathlib import Path
from eth_abi import encode
import liquity_screen
from liquity_screen import analyze, validate_read, REFERENCE, SCALE, MAX_TROVES, replay_capture


def fixture(oracle_age=10, duplicate=False, incomplete=False, zero_coll=False):
    oracle = '0x' + '11' * 20
    def trove(i, coll):
        return (i, 1000 * SCALE, coll, *([0] * 9), '0x' + '00' * 20, 0, 0, 0)
    rows = [trove(1, 0 if zero_coll else SCALE), trove(1 if duplicate else 2, 11 * SCALE // 10), trove(3, 2 * SCALE)]
    values = {
        'registry.getTroveManager(uint256)': REFERENCE['manager'], 'registry.getToken(uint256)': REFERENCE['collateral'],
        'helper.collateralRegistry()': REFERENCE['registry'], 'settings.troveManager()': REFERENCE['manager'],
        'settings.collToken()': REFERENCE['collateral'], 'settings.priceFeed()': REFERENCE['price'],
        'manager.sortedTroves()': REFERENCE['sorted'], 'manager.shutdownTime()': 0,
        'manager.getTroveIdsCount()': 4, 'settings.MCR()': 11 * SCALE // 10,
        'sorted.getSize()': 4 if incomplete else 3, 'price.priceSource()': 0,
        'price.ethUsdOracle()': (oracle, 100, 8), 'oracle.decimals()': 8,
        'oracle.latestRoundData()': (1, 1000 * 10 ** 8, 1000 - oracle_age, 1000 - oracle_age, 1),
        'helper.getMultipleSortedTroves(uint256,int256,uint256)': tuple(rows)
    }
    header = dict(number='0x64', hash='0x' + 'ab' * 32, timestamp='0x3e8')
    def read(method, params):
        validate_read(method, params)
        if method == 'eth_chainId': return '0x1'
        if method == 'eth_getBlockByNumber': return dict(header)
        if method == 'eth_getCode': return '0x6000'
        if method == 'eth_call':
            selected = [(name, spec) for name, spec in REFERENCE['functions'].items() if params[0]['data'].startswith(spec['selector'])]
            if len(selected) != 1: raise ValueError('Ambiguous fixture method')
            name, spec = selected[0]; value = values[name]
            return '0x' + encode(spec['outputs'], (value,) if len(spec['outputs']) == 1 else value).hex()
        raise ValueError('Unexpected fixture method')
    return read, values


class LiquityScreenTests(unittest.TestCase):
    def test_ratio_boundary_is_exact_and_positive_control_never_becomes_profit(self):
        read, _ = fixture(); result = analyze(read, 1001000)
        self.assertEqual(result['status'], 'below-mcr-screen-only')
        self.assertEqual([row['troveId'] for row in result['candidates']], ['1'])
        self.assertEqual(result['positions'][1]['icrAtomic'], str(11 * SCALE // 10))
        self.assertFalse(result['positions'][1]['belowMcr'])
        self.assertEqual(result['positions'][1]['maxOraclePriceForBelowMcrAtomic'], str(1000 * SCALE - 1))
        self.assertFalse(result['qualified']); self.assertIsNone(result['verifiedNetAtomic'])
        self.assertIsNone(result['actualReceiptsAtomic']); self.assertFalse(result['coverage']['zombieCoverage'])

    def test_stale_oracle_is_unknown_not_zero_candidates(self):
        read, _ = fixture(oracle_age=100); result = analyze(read, 1001000)
        self.assertEqual(result['status'], 'oracle-invalid'); self.assertIsNone(result['candidates'])
        self.assertIn('STALE_ORACLE', result['oracle']['reasons'])
        self.assertTrue(all(row['icrAtomic'] is None for row in result['positions']))

    def test_zero_collateral_with_positive_debt_is_not_hidden(self):
        read, _ = fixture(zero_coll=True); result = analyze(read, 1001000)
        self.assertTrue(result['positions'][0]['belowMcr'])
        self.assertEqual(result['positions'][0]['icrAtomic'], '0')
        self.assertIsNone(result['positions'][0]['maxOraclePriceForBelowMcrAtomic'])

    def test_partial_response_duplicate_ids_and_wrong_relationships_are_rejected(self):
        for options in [dict(duplicate=True), dict(incomplete=True)]:
            read, _ = fixture(**options)
            with self.assertRaises(ValueError): analyze(read, 1001000)
        read, values = fixture(); values['settings.troveManager()'] = '0x' + '22' * 20
        with self.assertRaisesRegex(ValueError, 'relationship'): analyze(read, 1001000)

    def test_reorg_and_noncanonical_abi_do_not_publish_a_candidate(self):
        read, _ = fixture()
        def changed(method, params):
            value = read(method, params)
            if method == 'eth_getBlockByNumber' and params[0] != 'latest': value['hash'] = '0x' + 'cd' * 32
            return value
        with self.assertRaisesRegex(ValueError, 'Canonical'): analyze(changed, 1001000)
        def trailing(method, params):
            value = read(method, params)
            if method == 'eth_call': return value + '00' * 32
            return value
        with self.assertRaises(ValueError): analyze(trailing, 1001000)

    def test_transport_surface_has_no_financial_or_unpinned_methods(self):
        pin = dict(blockHash='0x' + 'ab' * 32, requireCanonical=True)
        for method, params in [('eth_sendRawTransaction', ['0x1234']), ('eth_estimateGas', [{}]),
                               ('eth_call', [dict(to=REFERENCE['manager'], data='0x12345678'), pin]),
                               ('eth_call', [dict(to=REFERENCE['manager'], data=REFERENCE['functions']['manager.shutdownTime()']['selector']), 'latest'])]:
            with self.assertRaises(ValueError): validate_read(method, params)

    def test_replay_recomputes_and_rejects_a_rehashed_forged_result(self):
        read, _ = fixture(); records = []
        def record(method, params):
            result = read(method, params); records.append(dict(method=method, params=params, result=result)); return result
        analysis = analyze(record, 1001000)
        document = dict(schemaVersion=1, kind='liquity-screen-capture', source=liquity_screen.RPC,
                        records=records, analysis=analysis, capturedAtMs=1001001,
                        engineSha256=hashlib.sha256(Path(liquity_screen.__file__).read_bytes()).hexdigest(),
                        referenceSha256=hashlib.sha256(liquity_screen.REFERENCE_PATH.read_bytes()).hexdigest())
        with tempfile.TemporaryDirectory(prefix='mir-liquity-replay-') as directory:
            def save(value):
                raw = json.dumps(value, sort_keys=True).encode(); target = Path(directory) / (hashlib.sha256(raw).hexdigest() + '.json')
                target.write_bytes(raw); return target
            self.assertEqual(replay_capture(save(document)), analysis)
            document['analysis']['verifiedNetAtomic'] = '100000'
            with self.assertRaisesRegex(ValueError, 'reproduce'): replay_capture(save(document))


if __name__ == '__main__': unittest.main()
