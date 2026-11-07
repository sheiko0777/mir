"""Account for supplied protocol-work rewards, shared transaction costs and failed work.

No blockchain transport or execution. Events are observations of other operators,
not revenue received by MIR. Export/receipt authenticity remains a separate gate.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]


def atomic(value):
    if not isinstance(value,str) or not re.fullmatch(r'0|[1-9][0-9]{0,77}',value) or int(value)>=2**256:
        raise ValueError('Unsigned atomic-unit strings required')
    return int(value)


def identifier(value,size):
    if not isinstance(value,str) or not re.fullmatch('0x[0-9a-fA-F]{'+str(size)+'}',value):
        raise ValueError('Invalid transaction or operator identity')
    return value.lower()


def analyze(document):
    if document.get('schemaVersion')!=1 or document.get('kind')!='protocol-paid-work-observations' or \
            document.get('evidenceKind') not in ('illustrative','observed-unverified') or \
            type(document.get('chainId')) is not int or document['chainId']<=0:
        raise ValueError('Explicit observed/illustrative evidence and chain required')
    operator = identifier(document.get('operator'),40)
    receipts,events = document.get('receipts'),document.get('rewardEvents')
    if not isinstance(receipts,list) or not isinstance(events,list) or not 1<=len(receipts)<=10000 or len(events)>50000:
        raise ValueError('Work observation budget exceeded')
    asset = document.get('rewardAsset')
    cost_asset = document.get('costAsset')
    if not isinstance(asset,str) or not asset or not isinstance(cost_asset,str) or not cost_asset:
        raise ValueError('Explicit reward and cost asset identities required')
    same_asset = asset==cost_asset
    txs,seen_events = {},set()
    total_reward,total_fees,failed,missing_fees = 0,0,0,[]
    for receipt in receipts:
        tx_hash = identifier(receipt.get('txHash'),64)
        if tx_hash in txs: raise ValueError('Duplicate transaction receipt')
        if identifier(receipt.get('payer'),40)!=operator or type(receipt.get('success')) is not bool or \
                type(receipt.get('timeMs')) is not int or receipt['timeMs']<0:
            raise ValueError('Mixed operator or invalid receipt')
        fee = receipt.get('totalFeeAtomic')
        if fee is None: missing_fees.append(tx_hash)
        else: total_fees += atomic(fee)
        if not receipt['success']: failed += 1
        txs[tx_hash] = receipt
    for event in events:
        tx_hash = identifier(event.get('txHash'),64)
        index = event.get('logIndex')
        if type(index) is not int or index<0 or (tx_hash,index) in seen_events:
            raise ValueError('Duplicate or invalid log identity')
        seen_events.add((tx_hash,index))
        if tx_hash not in txs or not txs[tx_hash]['success']:
            raise ValueError('Reward on missing or failed receipt')
        if identifier(event.get('recipient'),40)!=operator:
            raise ValueError('Another operator reward cannot count as ours')
        total_reward += atomic(event.get('rewardAtomic'))
    costs = document.get('operatingCostsAtomic')
    # Failed RPC/compute attempts, hosting, support and acquisition must all be supplied.
    required = {'rpc','compute','hosting','support','acquisition','conversionAndWithdrawal'}
    missing_operating = sorted(required-set(costs)) if isinstance(costs,dict) else sorted(required)
    operating = 0
    if isinstance(costs,dict):
        if set(costs)-required: raise ValueError('Unrecognized cost category')
        for name in required & set(costs):
            if costs[name] is None: missing_operating.append(name)
            else: operating += atomic(costs[name])
    complete = same_asset and not missing_fees and not missing_operating
    net = total_reward-total_fees-operating if complete else None
    return dict(schemaVersion=1,kind='protocol-paid-work-accounting',chainId=document['chainId'],
                evidenceKind=document['evidenceKind'],operator=operator,rewardAsset=asset,costAsset=cost_asset,
                rewardEventCount=len(events),uniqueTransactionCount=len(txs),failedTransactions=failed,
                observedRewardAtomic=str(total_reward),knownTransactionFeesAtomic=str(total_fees),
                knownOperatingCostsAtomic=str(operating),conditionalNetAtomic=str(net) if net is not None else None,
                doubledCostConditionalNetAtomic=str(total_reward-2*(total_fees+operating)) if complete else None,
                missingFeeTransactions=missing_fees,missingOperatingCosts=sorted(set(missing_operating)),
                missingAssetConversion=not same_asset,qualified=False,verifiedNetAtomic=None,mirRevenueReceived=None,
                decision='insufficient-live-job-and-execution-evidence',
                limitations=['One receipt cost is counted once even when a batch emits many reward events',
                             'totalFeeAtomic must include chain-specific L1/operator fees; export authenticity is unverified',
                             'No reward conversion or WETH/ETH equivalence is assumed automatically',
                             'Historical operator rewards are not MIR revenue or proof of currently available jobs',
                             'No claim of low competition, achievable win rate, future repetition or forward profit'])


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('input',type=Path)
    args = parser.parse_args()
    if args.input.stat().st_size>8*1024*1024: raise ValueError('Input budget exceeded')
    raw = args.input.read_bytes()
    result = analyze(json.loads(raw))
    result.update(inputSha256=hashlib.sha256(raw).hexdigest(),engineSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    payload = json.dumps(result,sort_keys=True,allow_nan=False).encode()
    folder = ROOT / 'data/paid-work'; folder.mkdir(parents=True,exist_ok=True)
    target = folder/(hashlib.sha256(payload).hexdigest()+'.json')
    try:
        with target.open('xb') as stream: stream.write(payload)
    except FileExistsError:
        if target.read_bytes()!=payload: raise ValueError('Immutable record changed')
    print(json.dumps({'file':str(target),**result}))


if __name__ == '__main__': main()
