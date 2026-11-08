"""Fixed-target, read-only WETH branch screen. No signing, wallets or transaction simulation."""
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import time
import urllib.request
import urllib.error

from eth_abi import encode, decode

ROOT = Path(__file__).resolve().parents[2]
REFERENCE_PATH = Path(__file__).with_name('liquity-read-reference.json')
REFERENCE = json.loads(REFERENCE_PATH.read_bytes())
RPC = 'https://eth.llamarpc.com'
ALCHEMY_SOURCE = 'https://eth-mainnet.g.alchemy.com/v2/[redacted]'
SCALE = 10 ** 18
MAX_TROVES = 128


def quantity(value):
    if not isinstance(value, str) or not value.startswith('0x') or hex(int(value, 16)) != value:
        raise ValueError('Invalid RPC quantity')
    n = int(value, 16)
    if not 0 <= n < 2 ** 53:
        raise ValueError('Quantity outside exact time/block bounds')
    return n


def analyze(read, captured_at):
    if read('eth_chainId', []) != '0x1':
        raise ValueError('Expected Ethereum mainnet')
    header = read('eth_getBlockByNumber', ['latest', False])
    if not re.fullmatch(r'0x[0-9a-f]{64}', header.get('hash', '')):
        raise ValueError('Invalid block hash')
    number = quantity(header['number']); seconds = quantity(header['timestamp'])
    observed_at = captured_at() if callable(captured_at) else captured_at
    if type(observed_at) is not int or not 0 <= observed_at - seconds * 1000 <= 120000:
        raise ValueError('Stale or future head')
    pin = {'blockHash': header['hash'], 'requireCanonical': True}
    code = read('eth_getCode', [REFERENCE['manager'], pin])
    if not isinstance(code, str) or not re.fullmatch(r'0x(?:[0-9a-f]{2})+', code) or len(code) > 131074:
        raise ValueError('Missing manager code')
    targets = {k: REFERENCE[k] for k in ['registry', 'manager', 'helper', 'settings', 'sorted', 'price']}

    def call(method, args=()):
        spec = REFERENCE['functions'][method]
        data = spec['selector'] + encode(spec['inputs'], args).hex()
        raw = read('eth_call', [{'to': targets[method.split('.')[0]], 'data': data}, pin])
        if not isinstance(raw, str) or not re.fullmatch(r'0x(?:[0-9a-f]{2})*', raw) or len(raw) > 150000:
            raise ValueError('Invalid ABI response')
        payload = bytes.fromhex(raw[2:]); values = decode(spec['outputs'], payload, strict=True)
        if encode(spec['outputs'], values) != payload:
            raise ValueError('Noncanonical ABI response')
        return values[0] if len(values) == 1 else values

    expected = [('registry.getTroveManager(uint256)', (0,), REFERENCE['manager']),
                ('registry.getToken(uint256)', (0,), REFERENCE['collateral']),
                ('helper.collateralRegistry()', (), REFERENCE['registry']),
                ('settings.troveManager()', (), REFERENCE['manager']),
                ('settings.collToken()', (), REFERENCE['collateral']),
                ('settings.priceFeed()', (), REFERENCE['price']),
                ('manager.sortedTroves()', (), REFERENCE['sorted'])]
    for method, args, value in expected:
        if call(method, args) != value:
            raise ValueError('Contract relationship mismatch')
    shutdown = call('manager.shutdownTime()'); tracked = call('manager.getTroveIdsCount()')
    mcr = call('settings.MCR()'); sorted_count = call('sorted.getSize()')
    if not SCALE < mcr < 2 * SCALE or sorted_count > tracked:
        raise ValueError('Invalid branch parameters')
    result = dict(schemaVersion=1, kind='liquity-weth-position-screen', modelVersion='liquity-weth-screen-v1', capturedAtMs=observed_at,
                  chainId=1, blockNumber=number, blockHash=header['hash'], blockTimestampMs=seconds * 1000,
                  sourceCommit=REFERENCE['sourceCommit'], manager=REFERENCE['manager'],
                  bytecodeMatchedToAuditedBuild=False, finality='latest-unfinalized',
                  shutdownTimeSeconds=str(shutdown), mcrAtomic=str(mcr), trackedTroveIds=str(tracked),
                  qualified=False, executionEnabled=False, verifiedNetAtomic=None, actualReceiptsAtomic=None)
    if shutdown:
        result.update(status='branch-shutdown', candidates=None, coverage={'positionsScanned': 0, 'complete': False})
    else:
        price_source = call('price.priceSource()')
        oracle, stale_threshold, declared_decimals = call('price.ethUsdOracle()')
        if int(oracle, 16) == 0 or not 0 < stale_threshold <= 7 * 86400 or declared_decimals != 8:
            raise ValueError('Unexpected oracle parameters')
        targets['oracle'] = oracle
        decimals = call('oracle.decimals()')
        round_id, answer, started_at, updated_at, answered_in_round = call('oracle.latestRoundData()')
        reasons = []
        if price_source != 0: reasons.append('ORACLE_NOT_PRIMARY')
        if decimals != declared_decimals: reasons.append('ORACLE_DECIMALS_CHANGED')
        if answer <= 0: reasons.append('NONPOSITIVE_ORACLE_ANSWER')
        if not 0 < started_at <= updated_at <= seconds: reasons.append('INVALID_ORACLE_TIMES')
        if updated_at <= seconds and seconds - updated_at >= stale_threshold: reasons.append('STALE_ORACLE')
        if answered_in_round < round_id or round_id == 0: reasons.append('INCOMPLETE_ORACLE_ROUND')
        price = answer * 10 ** (18 - declared_decimals) if not reasons else None
        troves = call('helper.getMultipleSortedTroves(uint256,int256,uint256)', (0, 0, MAX_TROVES))
        if len(troves) != min(MAX_TROVES, sorted_count):
            raise ValueError('Incomplete sorted response')
        rows = []; seen = set()
        for values in troves:
            trove_id, debt, coll = values[:3]
            if trove_id == 0 or trove_id in seen:
                raise ValueError('Invalid or duplicate trove ID')
            seen.add(trove_id)
            row = dict(troveId=str(trove_id), entireDebtAtomic=str(debt), entireCollAtomic=str(coll))
            if price is not None and debt:
                ratio = coll * price // debt
                threshold = (debt * mcr - 1) // coll if coll else None
                row.update(icrAtomic=str(ratio), belowMcr=ratio < mcr,
                           maxOraclePriceForBelowMcrAtomic=str(threshold) if threshold is not None else None,
                           distanceToThresholdBps=(price - threshold) * 10000 // price if threshold is not None else None)
            else:
                row.update(icrAtomic=None, belowMcr=None, maxOraclePriceForBelowMcrAtomic=None, distanceToThresholdBps=None)
            rows.append(row)
        candidates = [row for row in rows if row['belowMcr']] if price is not None else None
        ranked = sorted([row for row in rows if row['distanceToThresholdBps'] is not None], key=lambda row: row['distanceToThresholdBps'])
        result.update(status='below-mcr-screen-only' if candidates else 'no-below-mcr-in-sorted-sample' if price is not None else 'oracle-invalid',
                      oracle=dict(address=oracle, priceSource=price_source, decimals=decimals, roundId=str(round_id),
                                  updatedAtSeconds=str(updated_at), stalenessThresholdSeconds=str(stale_threshold),
                                  priceAtomic=str(price) if price is not None else None, valid=not reasons, reasons=reasons,
                                  conservativeAdditionalRoundChecks=True),
                      coverage=dict(sortedCount=str(sorted_count), positionsScanned=len(rows),
                                    sortedListComplete=len(rows) == sorted_count, zombieCoverage=False, wholeBranchComplete=False),
                      positions=rows, candidates=candidates, nearestThresholds=ranked[:5])
    confirmed = read('eth_getBlockByNumber', [header['number'], False])
    if any(confirmed.get(k) != header[k] for k in ['hash', 'number', 'timestamp']):
        raise ValueError('Canonical block changed')
    result['limitations'] = ['Sorted active-list sample; zombies excluded', 'No liquidation or gas simulation',
                             'No competition, full-cost or withdrawal evidence', 'Oracle may change before inclusion',
                             'BOLD debt units used for protocol collateral ratios, not a USD peg valuation']
    return result


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def validate_read(method, params):
    if not isinstance(params, list): raise ValueError('Invalid RPC parameters')
    if method == 'eth_chainId' and params == []: return
    if method == 'eth_getBlockByNumber' and len(params) == 2 and params[1] is False:
        if params[0] != 'latest': quantity(params[0])
        return
    if method not in ('eth_call', 'eth_getCode') or len(params) != 2:
        raise ValueError('RPC method not allowed')
    pin = params[1]
    if not isinstance(pin, dict) or set(pin) != {'blockHash', 'requireCanonical'} or pin['requireCanonical'] is not True or not re.fullmatch(r'0x[0-9a-f]{64}', pin.get('blockHash', '')):
        raise ValueError('Hash-pinned read required')
    if method == 'eth_getCode':
        if params[0] != REFERENCE['manager']: raise ValueError('Unreviewed code target')
        return
    call = params[0]
    if not isinstance(call, dict) or set(call) != {'to', 'data'} or not re.fullmatch(r'0x[0-9a-f]{40}', call.get('to', '')) or int(call['to'], 16) == 0:
        raise ValueError('Invalid read target')
    roles = {REFERENCE[k]: k for k in ['registry', 'manager', 'helper', 'settings', 'sorted', 'price']}
    role = roles.get(call['to'], 'oracle')
    for name, spec in REFERENCE['functions'].items():
        if name.startswith(role + '.') and isinstance(call.get('data'), str) and call['data'].startswith(spec['selector']):
            suffix = call['data'][10:]
            if not re.fullmatch(r'(?:[0-9a-f]{2})*', suffix): raise ValueError('Invalid read data')
            payload = bytes.fromhex(suffix); values = decode(spec['inputs'], payload, strict=True)
            if encode(spec['inputs'], values) != payload: raise ValueError('Noncanonical read data')
            if spec['inputs'] and values not in ((0,), (0, 0, MAX_TROVES)):
                raise ValueError('Unreviewed data window')
            return
    raise ValueError('Contract method not allowed')


class PublicCapture:
    def __init__(self):
        self._rpc, self.source = rpc_configuration()
        self.records = []; self.started = time.monotonic(); self.raw_bytes = 0
        self.opener = urllib.request.build_opener(NoRedirect())

    def read(self, method, params):
        validate_read(method, params)
        if len(self.records) >= 32 or time.monotonic() - self.started >= 60:
            raise ValueError('Capture request/time budget exceeded')
        row = {'method': method, 'params': params}; self.records.append(row)
        request_id = len(self.records)
        body = json.dumps(dict(jsonrpc='2.0', id=request_id, method=method, params=params)).encode()
        try:
            request = urllib.request.Request(self._rpc, data=body, headers={'Content-Type': 'application/json'})
            with self.opener.open(request, timeout=min(8, max(0.1, 60 - (time.monotonic() - self.started)))) as response:
                raw = response.read(256 * 1024 + 1)
            self.raw_bytes += len(raw)
            if len(raw) > 256 * 1024 or self.raw_bytes > 2 * 1024 * 1024: raise ValueError('Byte budget exceeded')
            payload = json.loads(raw)
            if payload.get('jsonrpc') != '2.0' or payload.get('id') != request_id or payload.get('error') or 'result' not in payload:
                raise ValueError('Invalid RPC response')
            row['result'] = payload['result']; return row['result']
        except urllib.error.HTTPError as error:
            row['error'] = f'HTTP {error.code}'; raise
        except Exception:
            row['error'] = 'Public source unavailable or invalid'; raise


def rpc_configuration():
    endpoint = os.environ.get('MIR_ETHEREUM_RPC_URL')
    if endpoint is None:
        return RPC, RPC
    if not re.fullmatch(r'https://eth-mainnet\.g\.alchemy\.com/v2/[A-Za-z0-9_-]{8,128}', endpoint):
        raise ValueError('MIR_ETHEREUM_RPC_URL must be an Alchemy Ethereum mainnet HTTPS endpoint')
    return endpoint, ALCHEMY_SOURCE


def capture_payload(document, capture):
    # Even an unexpected provider result must not persist the credential.
    payload = json.dumps(document, sort_keys=True, allow_nan=False)
    if capture.source == ALCHEMY_SOURCE:
        payload = payload.replace(capture._rpc, ALCHEMY_SOURCE)
        payload = payload.replace(capture._rpc.rsplit('/', 1)[1], '[redacted]')
    return payload.encode()


def replay_capture(path):
    if path.stat().st_size > 2 * 1024 * 1024: raise ValueError('Capture exceeds replay budget')
    raw = path.read_bytes()
    if path.name != hashlib.sha256(raw).hexdigest() + '.json': raise ValueError('Capture content identity mismatch')
    document = json.loads(raw)
    if document.get('schemaVersion') != 1 or document.get('source') not in (RPC, ALCHEMY_SOURCE) or document.get('kind') != 'liquity-screen-capture' or document.get('engineSha256') != hashlib.sha256(Path(__file__).read_bytes()).hexdigest() or document.get('referenceSha256') != hashlib.sha256(REFERENCE_PATH.read_bytes()).hexdigest():
        raise ValueError('Capture engine/reference mismatch')
    records = document.get('records')
    if not isinstance(records, list) or len(records) > 32 or not isinstance(document.get('analysis'), dict):
        raise ValueError('No complete analysis to replay')
    observed = document['analysis'].get('capturedAtMs'); captured = document.get('capturedAtMs')
    if type(observed) is not int or type(captured) is not int or not 0 <= captured - observed <= 60000:
        raise ValueError('Invalid capture time window')
    cursor = 0
    def read(method, params):
        nonlocal cursor
        validate_read(method, params)
        if cursor >= len(records): raise ValueError('Incomplete capture transcript')
        row = records[cursor]; cursor += 1
        if row.get('method') != method or row.get('params') != params or 'result' not in row or 'error' in row:
            raise ValueError('Capture transcript mismatch')
        return row['result']
    result = analyze(read, document['analysis']['capturedAtMs'])
    if cursor != len(records) or result != document['analysis']: raise ValueError('Saved analysis did not reproduce')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--replay', type=Path); args = parser.parse_args()
    if args.replay:
        report = replay_capture(args.replay)
        print(json.dumps(dict(replayed=True, status=report['status'], coverage=report['coverage'],
                              candidates=len(report['candidates']) if report.get('candidates') is not None else None,
                              qualified=False, verifiedNetAtomic=None)))
        return
    capture = PublicCapture(); report = None
    try: report = analyze(capture.read, lambda: int(time.time() * 1000))
    except Exception as error: failure = 'Source unavailable or validation failed: ' + type(error).__name__
    result = dict(schemaVersion=1, kind='liquity-screen-capture', source=capture.source,
                  capturedAtMs=int(time.time() * 1000), records=capture.records, analysis=report,
                  failure=None if report is not None else failure,
                  engineSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                  referenceSha256=hashlib.sha256(REFERENCE_PATH.read_bytes()).hexdigest(),
                  requests=len(capture.records), responseBytes=capture.raw_bytes, retries=0)
    payload = capture_payload(result, capture); identity = hashlib.sha256(payload).hexdigest()
    folder = ROOT / 'data/liquity-screen'; folder.mkdir(parents=True, exist_ok=True)
    pending = folder / ('.' + identity + '.pending'); target = folder / (identity + '.json')
    with pending.open('xb') as stream: stream.write(payload)
    pending.replace(target)
    print(json.dumps(dict(id=identity, status=report['status'] if report else 'unavailable-or-rejected',
                          coverage=report.get('coverage') if report else None,
                          candidates=len(report['candidates']) if report and report.get('candidates') is not None else None,
                          nearestThresholds=report.get('nearestThresholds') if report else None,
                          requests=len(capture.records), failure=result['failure'], verifiedNetAtomic=None)))


if __name__ == '__main__': main()
