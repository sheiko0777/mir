"""Bounded historical payment evidence, not an execution bot or profit backtest.

Uses official Alchemy Transfers API for discovery, then receipt token logs as evidence.
Liquity interfaces: pinned d262669ef3c4d37bf0544df3bb2624c07b8a5ee0.
Curve deployment list: https://docs.curve.finance/developer/deployments/dao
"""
import argparse
import hashlib
import json
from pathlib import Path
import re
import time
import urllib.request
import urllib.error
from eth_utils import keccak
from eth_abi import decode, encode
import liquity_screen as base

WETH = base.REFERENCE['collateral']
MANAGER = base.REFERENCE['manager']
PEGKEEPERS = ['0x9201da0d97caaaff53f01b2fb56767c7072de340',
              '0xfb726f57d251ab5c731e5c64ed4f5f94351ef9f3',
              '0x3fa20eaa107de08b38a8734063d605d5842fe09c',
              '0x338cb2d827112d989a861cde87cd9ffd913a1f9d']
REGULATOR = '0x36a04caffc681fa179558b2aaba30395cddd855f'
TRANSFER = '0x' + keccak(text='Transfer(address,address,uint256)').hex()
LIQUIDATION = '0x' + keccak(text='Liquidation(' + ','.join(['uint256']*10) + ')').hex()
HASH = r'0x[0-9a-f]{64}'
ADDRESS = r'0x[0-9a-f]{40}'


class SourceUnavailable(RuntimeError):
    pass


def call(address, signature, pin):
    return [{'to': address, 'data': '0x'+keccak(text=signature).hex()[:8]}, pin]


def unpack(raw, kind):
    if not isinstance(raw, str) or not re.fullmatch(r'0x[0-9a-f]*', raw): raise ValueError('Invalid ABI')
    payload = bytes.fromhex(raw[2:]); value = decode([kind], payload)[0]
    if encode([kind], [value]) != payload: raise ValueError('Noncanonical ABI')
    return value


def transfer_logs(receipt, asset):
    rows = []; seen = set()
    for log in receipt.get('logs', []):
        if log.get('address', '').lower() != asset or log.get('topics', [])[:1] != [TRANSFER]: continue
        topics = log['topics']; index = base.quantity(log['logIndex'])
        if index in seen or len(topics) != 3 or any(not re.fullmatch(HASH, x) or x[2:26] != '0'*24 for x in topics[1:]) or log.get('removed') or log.get('transactionHash') != receipt['transactionHash'] or log.get('blockHash') != receipt['blockHash']:
            raise ValueError('Invalid transfer identity')
        seen.add(index)
        rows.append(dict(sender='0x'+topics[1][-40:], recipient='0x'+topics[2][-40:], amount=unpack(log['data'], 'uint256')))
    return rows


def liquidation_payment(receipt, gas_pool, active_pool):
    if receipt.get('status') != '0x1': return None
    events = [log for log in receipt.get('logs', []) if log.get('address', '').lower() == MANAGER and log.get('topics') == [LIQUIDATION]]
    if not events: return None
    if len(events) != 1: raise ValueError('Ambiguous liquidation events')
    data = events[0]['data']
    if not re.fullmatch('0x[0-9a-f]{640}', data): raise ValueError('Invalid liquidation event')
    transfers = transfer_logs(receipt, WETH)
    recipients = {x['recipient'] for x in transfers if x['sender'] == gas_pool and x['amount'] > 0}
    if len(recipients) != 1: raise ValueError('Unresolved gas compensation recipient')
    recipient = next(iter(recipients))
    reward = sum(x['amount'] for x in transfers if x['sender'] in (gas_pool, active_pool) and x['recipient'] == recipient)
    gas = base.quantity(receipt['gasUsed']) * int(receipt['effectiveGasPrice'], 16)
    return dict(txHash=receipt['transactionHash'], blockNumber=base.quantity(receipt['blockNumber']),
                recipient=recipient, gasPayer=receipt['from'].lower(), rewardWethAtomic=str(reward),
                gasWei=str(gas), rewardMinusTransactionGasAtomic=str(reward-gas),
                rewardMinusDoubleTransactionGasAtomic=str(reward-2*gas),
                samePayerAndRecipient=recipient == receipt['from'].lower(),
                verifiedNetAtomic=None, interpretation='Successful transaction surplus only; operating costs and failed races missing')


def observe(read, observed_at=None):
    if read('eth_chainId', []) != '0x1': raise ValueError('Wrong chain')
    head = read('eth_getBlockByNumber', ['latest', False]); number = base.quantity(head['number'])
    if not re.fullmatch(HASH, head['hash']): raise ValueError('Invalid head')
    observed_at = time.time() if observed_at is None else observed_at
    if not 0 <= observed_at - base.quantity(head['timestamp']) <= 120: raise ValueError('Stale head')
    start_number = max(0, number - 648000)
    start = read('eth_getBlockByNumber', [hex(start_number), False])
    if base.quantity(start['number']) != start_number: raise ValueError('Invalid range start')
    pin = dict(blockHash=head['hash'], requireCanonical=True)
    gas_pool = unpack(read('eth_call', call(base.REFERENCE['settings'], 'gasPoolAddress()', pin)), 'address')
    active_pool = unpack(read('eth_call', call(base.REFERENCE['settings'], 'activePool()', pin)), 'address')
    if int(gas_pool,16) == 0 or int(active_pool,16) == 0: raise ValueError('Missing reward pools')
    def transfers(address, token):
        params = dict(fromBlock=hex(start_number), toBlock=head['number'], fromAddress=address,
                      contractAddresses=[token], category=['erc20'], withMetadata=False,
                      excludeZeroValue=True, maxCount='0x3e8', order='desc')
        result = read('alchemy_getAssetTransfers', [params])
        rows = result.get('transfers')
        if not isinstance(rows, list) or len(rows) > 1000: raise ValueError('Invalid transfer discovery')
        for row in rows:
            if row.get('from', '').lower() != address or row.get('rawContract', {}).get('address', '').lower() != token or not re.fullmatch(HASH, row.get('hash', '')) or not start_number <= base.quantity(row['blockNum']) <= number:
                raise ValueError('Transfer outside discovery scope')
        return rows, not bool(result.get('pageKey'))
    rows, complete = transfers(gas_pool, WETH)
    hashes = list(dict.fromkeys(row['hash'] for row in rows)); payments = []; rejected = []
    receipt_count = 0
    for tx in hashes[:16]:
        try:
            receipt = read('eth_getTransactionReceipt', [tx]); receipt_count += 1
            if receipt.get('transactionHash') != tx or not re.fullmatch(HASH, receipt.get('blockHash', '')) or not start_number <= base.quantity(receipt['blockNumber']) <= number:
                raise ValueError('Receipt identity mismatch')
            payment = liquidation_payment(receipt, gas_pool, active_pool)
            if payment: payments.append(payment)
        except SourceUnavailable:
            raise
        except Exception:
            rejected.append(dict(txHash=tx, reason='RECEIPT_UNAVAILABLE_OR_INVALID'))
            # Stop on source refusal, not automatic retry or selection of better-looking samples.
            break
    curves = []
    for address in PEGKEEPERS:
        entry = dict(address=address, qualified=False, verifiedNetAtomic=None)
        try:
            regulator = unpack(read('eth_call', call(address, 'regulator()', pin)), 'address')
            if regulator != REGULATOR: raise ValueError('Unreviewed regulator')
            pool = unpack(read('eth_call', call(address, 'pool()', pin)), 'address')
            if int(pool,16) == 0: raise ValueError('Missing pool')
            estimate = unpack(read('eth_call', call(address, 'estimate_caller_profit()', pin)), 'uint256')
            entry.update(pool=pool, conditionalCallerRewardLpAtomic=str(estimate), rewardUnit='pool-LP-token',
                         status='zero-estimated-caller-reward' if estimate == 0 else 'positive-estimate-needs-conversion-and-simulation')
            discovered, full = transfers(address, pool)
            entry.update(outgoingLpTransfers=len(discovered), transferDiscoveryComplete=full,
                         historicalCallerPaymentsVerified=False)
        except SourceUnavailable:
            raise
        except Exception as error:
            entry.update(status='unavailable-or-unreviewed', failureType=type(error).__name__)
        curves.append(entry)
    confirmed = read('eth_getBlockByNumber', [head['number'], False])
    if confirmed.get('hash') != head['hash']: raise ValueError('Head changed')
    return dict(schemaVersion=1, kind='protocol-income-economic-evidence', sourceBlock=number, sourceBlockHash=head['hash'],
                startBlock=start_number, startTimeSeconds=base.quantity(start['timestamp']), endTimeSeconds=base.quantity(head['timestamp']),
                windowSeconds=base.quantity(head['timestamp']) - base.quantity(start['timestamp']),
                liquity=dict(gasPool=gas_pool, activePool=active_pool, discoveryTransferRows=len(rows), discoveryTransactions=len(hashes),
                             transferDiscoveryComplete=complete, receiptsInspected=receipt_count, receiptSampleLimit=16,
                             allDiscoveryReceiptsInspected=complete and len(hashes) <= receipt_count and not rejected,
                             observedLiquidationPayments=payments, rejectedReceipts=rejected,
                             failureAttemptCoverage=False, operatingCostCoverage=False),
                curve=curves, qualified=False, verifiedNetAtomic=None,
                limitations=['Gas-pool transfers can be borrower refunds; only receipt-confirmed liquidation payments count',
                             'Transfers discovery is provider-indexed, not an independently verified full event census',
                             'Selected recent successful receipts omit failed races and operating costs',
                             'LP transfers and estimates are not liquid caller income', 'Historical bot receipts are not MIR revenue'])


class Capture:
    def __init__(self):
        self._rpc, self.source = base.rpc_configuration()
        if self.source != base.ALCHEMY_SOURCE: raise ValueError('Authorized Alchemy environment required')
        self.opener = urllib.request.build_opener(base.NoRedirect())
        self.records = []; self.started = time.monotonic(); self.raw_bytes = 0

    def read(self, method, params):
        if method not in ('eth_chainId', 'eth_getBlockByNumber', 'eth_call', 'alchemy_getAssetTransfers', 'eth_getTransactionReceipt'):
            raise ValueError('No financial RPC methods')
        if len(self.records) >= 64 or time.monotonic() - self.started >= 60: raise ValueError('Evidence request/time budget exceeded')
        row = dict(method=method, params=params); self.records.append(row)
        body = json.dumps(dict(jsonrpc='2.0', id=len(self.records), method=method, params=params)).encode()
        try:
            req = urllib.request.Request(self._rpc, data=body, headers={'Content-Type': 'application/json'})
            with self.opener.open(req, timeout=min(8,max(.1,60-(time.monotonic()-self.started)))) as response:
                raw = response.read(524289)
            self.raw_bytes += len(raw)
            if len(raw) > 524288 or self.raw_bytes > 4194304: raise ValueError('Evidence byte budget exceeded')
            payload = json.loads(raw)
            if payload.get('jsonrpc') != '2.0' or payload.get('id') != len(self.records) or 'error' in payload or 'result' not in payload:
                raise ValueError('Invalid RPC response')
            row['result'] = payload['result']; return row['result']
        except urllib.error.HTTPError as error:
            row['error'] = 'HTTP '+str(error.code); raise SourceUnavailable('Evidence source refused request') from None
        except Exception:
            row['error'] = 'Evidence source unavailable or invalid'; raise SourceUnavailable('Evidence source unavailable or invalid') from None


def replay(path):
    if path.stat().st_size > 4194304: raise ValueError('Evidence file too large')
    raw = path.read_bytes()
    if path.name != hashlib.sha256(raw).hexdigest()+'.json': raise ValueError('Evidence identity mismatch')
    doc = json.loads(raw)
    if doc.get('kind') != 'protocol-income-evidence-capture' or doc.get('source') != base.ALCHEMY_SOURCE or doc.get('engineSha256') != hashlib.sha256(Path(__file__).read_bytes()).hexdigest() or not isinstance(doc.get('analysis'),dict):
        raise ValueError('Evidence provenance or analysis missing')
    rows = doc['records']; cursor = 0
    if not isinstance(rows,list) or len(rows)>64: raise ValueError('Evidence replay budget exceeded')
    def read(method,params):
        nonlocal cursor
        if cursor>=len(rows): raise ValueError('Incomplete evidence transcript')
        row=rows[cursor]; cursor+=1
        if row.get('method')!=method or row.get('params')!=params or 'error' in row or 'result' not in row:
            raise SourceUnavailable('Evidence transcript mismatch')
        return row['result']
    result=observe(read,doc['observedAtSeconds'])
    if cursor!=len(rows) or result!=doc['analysis']: raise ValueError('Evidence analysis did not reproduce')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('--replay',type=Path); args=parser.parse_args()
    if args.replay:
        print(json.dumps(dict(replayed=True,analysis=replay(args.replay)))); return
    capture = Capture(); report = None; failure = None
    observed_at=time.time()
    try: report = observe(capture.read, observed_at)
    except Exception as error: failure = type(error).__name__
    doc = dict(schemaVersion=1, source=capture.source, kind='protocol-income-evidence-capture',
               records=capture.records, analysis=report, failure=failure, capturedAtMs=int(time.time()*1000), observedAtSeconds=observed_at,
               engineSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    raw = base.capture_payload(doc,capture); name = hashlib.sha256(raw).hexdigest()
    folder = base.ROOT/'data/protocol-income'; folder.mkdir(parents=True,exist_ok=True)
    with (folder/(name+'.json')).open('xb') as stream: stream.write(raw)
    print(json.dumps(dict(id=name,requests=len(capture.records),failure=failure,analysis=report)))


if __name__ == '__main__': main()
