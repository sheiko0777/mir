"""Bounded same-block extension of a verified WETH screen, including zombie troves.

Factual read interfaces reviewed at liquity/bold d262669ef3c4d37bf0544df3bb2624c07b8a5ee0:
contracts/src/Interfaces/ITroveManager.sol and contracts/src/Types/LatestTroveData.sol (MIT).
No upstream implementation copied. No liquidation or signing methods.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.error
import urllib.request

from eth_abi import encode, decode
from eth_utils import keccak
import liquity_screen as base

MAX_IDS = 128
MAX_EXTRA = 32
MAX_CALLS = 200
MAX_HTTP = 20
SPECS = {
    'getTroveFromTroveIdsArray(uint256)': (['uint256'], ['uint256']),
    'getTroveStatus(uint256)': (['uint256'], ['uint8']),
    'getLatestTroveData(uint256)': (['uint256'], ['(' + ','.join(['uint256'] * 10) + ')']),
}
SELECTORS = {name: '0x' + keccak(text=name).hex()[:8] for name in SPECS}


def request(name, value, pin):
    return ['eth_call', [{'to': base.REFERENCE['manager'],
                         'data': SELECTORS[name] + encode(SPECS[name][0], [value]).hex()}, pin]]


def unpack(name, raw):
    if not isinstance(raw, str) or not re.fullmatch(r'0x(?:[0-9a-f]{2})*', raw) or len(raw) > 1026:
        raise ValueError('Invalid inventory ABI result')
    payload = bytes.fromhex(raw[2:]); values = decode(SPECS[name][1], payload, strict=True)
    if encode(SPECS[name][1], values) != payload:
        raise ValueError('Noncanonical inventory ABI result')
    return values[0]


def validate(method, params):
    if method != 'eth_call':
        base.validate_read(method, params); return
    if not isinstance(params, list) or len(params) != 2:
        raise ValueError('Invalid inventory call')
    call, pin = params
    # Reuse the strict pin validation without broadening the base engine.
    base.validate_read('eth_getCode', [base.REFERENCE['manager'], pin])
    if not isinstance(call, dict) or set(call) != {'to', 'data'} or call['to'] != base.REFERENCE['manager']:
        raise ValueError('Unreviewed inventory target')
    for name, selector in SELECTORS.items():
        if isinstance(call.get('data'), str) and call['data'].startswith(selector):
            suffix = call['data'][10:]
            if not re.fullmatch(r'[0-9a-f]{64}', suffix): break
            value = int(suffix, 16)
            if name.startswith('getTroveFrom') and value >= MAX_IDS: break
            if not name.startswith('getTroveFrom') and not value: break
            return
    raise ValueError('Unreviewed inventory method or argument')


def analyze(read_many, screen):
    coverage = screen.get('coverage', {})
    if screen.get('shutdownTimeSeconds') != '0' or not coverage.get('sortedListComplete'):
        raise ValueError('Live branch and complete sorted baseline required')
    count = int(screen['trackedTroveIds'])
    if not 0 <= count <= MAX_IDS: raise ValueError('Tracked array exceeds inventory budget')
    header_request = ['eth_getBlockByNumber', [hex(screen['blockNumber']), False]]
    def check_head():
        head = read_many([header_request])[0]
        if not isinstance(head, dict) or head.get('hash') != screen['blockHash'] or head.get('number') != hex(screen['blockNumber']) or base.quantity(head['timestamp']) * 1000 != screen['blockTimestampMs']:
            raise ValueError('Inventory source block changed')
    if read_many([['eth_chainId', []]]) != ['0x1']: raise ValueError('Wrong inventory chain')
    check_head()
    pin = dict(blockHash=screen['blockHash'], requireCanonical=True)
    def calls(name, args):
        values = []
        for start in range(0, len(args), 16):
            chunk = args[start:start + 16]
            raw = read_many([request(name, arg, pin) for arg in chunk])
            if len(raw) != len(chunk): raise ValueError('Incomplete inventory batch')
            values.extend(unpack(name, item) for item in raw)
        return values
    ids = calls('getTroveFromTroveIdsArray(uint256)', list(range(count)))
    if any(not value for value in ids) or len(set(ids)) != count: raise ValueError('Invalid or duplicate inventory IDs')
    sorted_rows = screen['positions']
    sorted_ids = {int(row['troveId']) for row in sorted_rows}
    if len(sorted_ids) != len(sorted_rows) or not sorted_ids.issubset(ids):
        raise ValueError('Sorted baseline not contained in tracked array')
    missing = [value for value in ids if value not in sorted_ids]
    if len(missing) > MAX_EXTRA: raise ValueError('Unsorted positions exceed inventory budget')
    statuses = calls('getTroveStatus(uint256)', missing)
    if any(value != 4 for value in statuses):
        raise ValueError('Unexpected non-zombie outside complete sorted list')
    data = calls('getLatestTroveData(uint256)', missing)
    price = int(screen['oracle']['priceAtomic']) if screen['oracle']['valid'] else None
    mcr = int(screen['mcrAtomic']); extras = []
    for trove_id, values in zip(missing, data):
        debt, coll = values[:2]
        ratio = coll * price // debt if price is not None and debt else None
        extras.append(dict(troveId=str(trove_id), status='zombie', entireDebtAtomic=str(debt),
                           entireCollAtomic=str(coll), icrAtomic=str(ratio) if ratio is not None else None,
                           belowMcr=ratio < mcr if ratio is not None else None))
    check_head()
    candidates = None if price is None else [row for row in sorted_rows + extras if row['belowMcr']]
    return dict(modelVersion='liquity-weth-inventory-v1', chainId=1, manager=base.REFERENCE['manager'],
                blockNumber=screen['blockNumber'], blockHash=screen['blockHash'], blockTimestampMs=screen['blockTimestampMs'],
                coverage=dict(trackedIds=count, sortedPositions=len(sorted_rows), zombiePositions=len(extras),
                              allTrackedPositionsScreened=True, otherCollateralBranches=False),
                zombiePositions=extras, candidates=candidates,
                status='oracle-invalid' if price is None else 'below-mcr-screen-only' if candidates else 'no-below-mcr-in-tracked-array',
                qualified=False, executionEnabled=False, verifiedNetAtomic=None,
                limitations=['Historical source block; not necessarily current', 'Below MCR is not proof of executable liquidation',
                             'No gas, competition, cash receipt or continuous opportunity proof'])


class Capture:
    def __init__(self):
        self._rpc, self.source = base.rpc_configuration()
        if self.source != base.ALCHEMY_SOURCE: raise ValueError('Explicit authorized Alchemy environment required')
        self.opener = urllib.request.build_opener(base.NoRedirect())
        self.records = []; self.started = time.monotonic(); self.raw_bytes = 0; self.calls = 0

    def read_many(self, requests):
        if not 1 <= len(requests) <= 16: raise ValueError('Invalid batch size')
        for method, params in requests: validate(method, params)
        if self.calls + len(requests) > MAX_CALLS or len(self.records) >= MAX_HTTP or time.monotonic() - self.started >= 60:
            raise ValueError('Inventory request/time budget exceeded')
        self.calls += len(requests)
        row = {'requests': requests}; self.records.append(row)
        body = json.dumps([dict(jsonrpc='2.0', id=i, method=method, params=params)
                           for i, (method, params) in enumerate(requests)]).encode()
        try:
            req = urllib.request.Request(self._rpc, data=body, headers={'Content-Type': 'application/json'})
            with self.opener.open(req, timeout=min(8, max(.1, 60 - (time.monotonic() - self.started)))) as response:
                raw = response.read(262145)
            self.raw_bytes += len(raw)
            if len(raw) > 262144 or self.raw_bytes > 2097152: raise ValueError('Inventory byte budget exceeded')
            payload = json.loads(raw)
            values = validate_batch(payload, len(requests))
            row['results'] = values; return values
        except urllib.error.HTTPError as error:
            row['error'] = 'HTTP ' + str(error.code); raise
        except Exception:
            row['error'] = 'Inventory source unavailable or invalid'; raise


def validate_batch(payload, count):
    if not isinstance(payload, list) or len(payload) != count: raise ValueError('Incomplete batch response')
    by_id = {}
    for item in payload:
        if not isinstance(item, dict) or item.get('jsonrpc') != '2.0' or type(item.get('id')) is not int or not 0 <= item['id'] < count or item['id'] in by_id or 'error' in item or 'result' not in item:
            raise ValueError('Invalid batch response identity')
        by_id[item['id']] = item['result']
    return [by_id[i] for i in range(count)]


def identity(path):
    if path.stat().st_size > 2097152: raise ValueError('Inventory document too large')
    raw = path.read_bytes()
    if path.name != hashlib.sha256(raw).hexdigest() + '.json': raise ValueError('Inventory content identity mismatch')
    return json.loads(raw)


def replay(path, baseline):
    screen = base.replay_capture(baseline); doc = identity(path)
    if doc.get('kind') != 'liquity-inventory-capture' or doc.get('source') != base.ALCHEMY_SOURCE or doc.get('baselineSha256') != baseline.stem or doc.get('engineSha256') != hashlib.sha256(Path(__file__).read_bytes()).hexdigest() or not isinstance(doc.get('analysis'), dict):
        raise ValueError('Inventory provenance mismatch')
    records = doc.get('records'); cursor = 0; calls = 0
    if not isinstance(records, list) or len(records) > MAX_HTTP: raise ValueError('Inventory transcript budget exceeded')
    def read_many(requests):
        nonlocal cursor, calls
        if not 1 <= len(requests) <= 16 or cursor >= len(records): raise ValueError('Incomplete inventory transcript')
        for method, params in requests: validate(method, params)
        calls += len(requests)
        if calls > MAX_CALLS: raise ValueError('Inventory replay call budget exceeded')
        row = records[cursor]; cursor += 1
        if row.get('requests') != requests or 'error' in row or not isinstance(row.get('results'), list) or len(row['results']) != len(requests):
            raise ValueError('Inventory transcript mismatch')
        return row['results']
    report = analyze(read_many, screen)
    if cursor != len(records) or report != doc['analysis']: raise ValueError('Inventory result did not reproduce')
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--baseline', required=True, type=Path)
    parser.add_argument('--replay', type=Path); args = parser.parse_args()
    if args.replay:
        result = replay(args.replay, args.baseline)
        print(json.dumps(dict(replayed=True, status=result['status'], coverage=result['coverage'],
                              candidates=len(result['candidates']) if result['candidates'] is not None else None))); return
    screen = base.replay_capture(args.baseline)
    capture = Capture(); report = None; failure = None
    try: report = analyze(capture.read_many, screen)
    except Exception as error: failure = 'Source unavailable or validation failed: ' + type(error).__name__
    doc = dict(schemaVersion=1, kind='liquity-inventory-capture', source=capture.source,
               baselineSha256=args.baseline.stem, engineSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
               capturedAtMs=int(time.time()*1000), records=capture.records, analysis=report, failure=failure,
               logicalCalls=capture.calls, httpRequests=len(capture.records), responseBytes=capture.raw_bytes, retries=0)
    raw = base.capture_payload(doc, capture); name = hashlib.sha256(raw).hexdigest()
    folder = base.ROOT / 'data/liquity-inventory'; folder.mkdir(parents=True, exist_ok=True)
    with (folder / (name + '.json')).open('xb') as stream: stream.write(raw)
    print(json.dumps(dict(id=name, status=report['status'] if report else 'unavailable-or-rejected', failure=failure,
                          coverage=report['coverage'] if report else None, calls=capture.calls, httpRequests=len(capture.records),
                          candidates=len(report['candidates']) if report and report['candidates'] is not None else None)))


if __name__ == '__main__': main()
