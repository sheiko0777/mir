import copy
import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from eth_abi import encode
import liquity_screen as base
import liquity_inventory as inv
from test_liquity_screen import fixture


def setup_inventory(debt=1000 * base.SCALE, coll=base.SCALE, status=4):
    read, _ = fixture(); baseline_records = []
    def recorded(method, params):
        result = read(method, params)
        baseline_records.append(dict(method=method, params=params, result=result)); return result
    screen = base.analyze(recorded, 1001000)
    def read_many(requests):
        output = []
        for method, params in requests:
            inv.validate(method, params)
            if method != 'eth_call': output.append(read(method, params)); continue
            data = params[0]['data']; arg = int(data[10:], 16)
            if data.startswith(inv.SELECTORS['getTroveFromTroveIdsArray(uint256)']): value, types = arg + 1, ['uint256']
            elif data.startswith(inv.SELECTORS['getTroveStatus(uint256)']): value, types = status, ['uint8']
            else: value, types = (debt, coll, *([0]*8)), inv.SPECS['getLatestTroveData(uint256)'][1]
            output.append('0x' + encode(types, [value]).hex())
        return output
    return screen, read_many, baseline_records


class InventoryTests(unittest.TestCase):
    def test_missing_zombie_is_screened_without_upgrading_to_profit(self):
        screen, read, _ = setup_inventory(); result = inv.analyze(read, screen)
        self.assertEqual(result['coverage']['zombiePositions'], 1)
        self.assertTrue(result['coverage']['allTrackedPositionsScreened'])
        self.assertEqual([x['troveId'] for x in result['candidates']], ['1', '4'])
        self.assertFalse(result['qualified']); self.assertIsNone(result['verifiedNetAtomic'])

    def test_zero_debt_and_invalid_oracle_do_not_become_zero_cost_opportunities(self):
        screen, read, _ = setup_inventory(debt=0)
        self.assertIsNone(inv.analyze(read, screen)['zombiePositions'][0]['belowMcr'])
        screen['oracle'].update(valid=False, priceAtomic=None)
        self.assertIsNone(inv.analyze(read, screen)['candidates'])

    def test_wrong_status_partial_baseline_and_large_inventory_are_rejected(self):
        screen, read, _ = setup_inventory(status=1)
        with self.assertRaisesRegex(ValueError, 'non-zombie'): inv.analyze(read, screen)
        screen['coverage']['sortedListComplete'] = False
        with self.assertRaises(ValueError): inv.analyze(read, screen)
        screen['coverage']['sortedListComplete'] = True; screen['trackedTroveIds'] = '129'
        with self.assertRaisesRegex(ValueError, 'budget'): inv.analyze(read, screen)

    def test_reorg_duplicates_and_trailing_abi_are_rejected(self):
        screen, read, _ = setup_inventory()
        for failure in ['reorg', 'duplicate', 'abi']:
            def broken(requests):
                values = read(requests)
                if failure == 'reorg' and requests[0][0] == 'eth_getBlockByNumber': values[0]['hash'] = '0x' + 'ff'*32
                if requests[0][0] == 'eth_call':
                    if failure == 'duplicate' and len(values) > 1: values[1] = values[0]
                    if failure == 'abi': values[0] += '00'*32
                return values
            with self.assertRaises(ValueError): inv.analyze(broken, screen)

    def test_batch_response_order_identity_errors_and_partial_results(self):
        def row(i): return dict(jsonrpc='2.0', id=i, result=str(i))
        self.assertEqual(inv.validate_batch([row(1), row(0)], 2), ['0', '1'])
        for rows in [[row(0)], [row(0), row(0)], [row(0), row(2)], [row(0), dict(jsonrpc='2.0', id=1, error={})]]:
            with self.assertRaises(ValueError): inv.validate_batch(rows, 2)

    def test_transport_excludes_writes_other_addresses_and_unpinned_reads(self):
        pin = dict(blockHash='0x' + 'ab'*32, requireCanonical=True)
        valid = inv.request('getTroveStatus(uint256)', 4, pin); inv.validate(*valid)
        for method, params in [('eth_sendRawTransaction', ['0x1234']),
                               ('eth_call', [valid[1][0], 'latest']),
                               ('eth_call', [dict(valid[1][0], to='0x'+'11'*20), pin]),
                               inv.request('getTroveFromTroveIdsArray(uint256)', 128, pin)]:
            with self.assertRaises(ValueError): inv.validate(method, params)

    def test_replay_checks_baseline_and_recomputes_forged_result(self):
        screen, read, records = setup_inventory(); transcript = []
        def recorded(requests):
            results = read(requests); transcript.append(dict(requests=requests, results=results)); return results
        result = inv.analyze(recorded, screen)
        baseline = dict(schemaVersion=1, kind='liquity-screen-capture', source=base.ALCHEMY_SOURCE,
                        records=records, analysis=screen, capturedAtMs=1001001,
                        engineSha256=hashlib.sha256(Path(base.__file__).read_bytes()).hexdigest(),
                        referenceSha256=hashlib.sha256(base.REFERENCE_PATH.read_bytes()).hexdigest())
        with tempfile.TemporaryDirectory(prefix='mir-inventory-') as folder:
            def save(doc):
                raw = json.dumps(doc, sort_keys=True).encode(); path = Path(folder)/(hashlib.sha256(raw).hexdigest()+'.json')
                path.write_bytes(raw); return path
            baseline_path = save(baseline)
            doc = dict(kind='liquity-inventory-capture', source=base.ALCHEMY_SOURCE,
                       baselineSha256=baseline_path.stem, engineSha256=hashlib.sha256(Path(inv.__file__).read_bytes()).hexdigest(),
                       records=transcript, analysis=result)
            self.assertEqual(inv.replay(save(doc), baseline_path), result)
            doc['analysis'] = copy.deepcopy(result); doc['analysis']['verifiedNetAtomic'] = '100'
            with self.assertRaisesRegex(ValueError, 'reproduce'): inv.replay(save(doc), baseline_path)
            doc['baselineSha256'] = '0'*64
            with self.assertRaisesRegex(ValueError, 'provenance'): inv.replay(save(doc), baseline_path)


if __name__ == '__main__': unittest.main()
