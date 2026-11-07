"""Decode published PoolTogether Base events and separate earned credit from cash.

Reads supplied raw receipt exports only. No RPC, signing, wallet or transaction.
"""
from collections import Counter
import argparse
import hashlib
import importlib.metadata
import json
from pathlib import Path
import re
from eth_abi import decode, encode
from paid_work import atomic, identifier

ROOT=Path(__file__).resolve().parents[2]
REFERENCE=Path(__file__).with_name('pooltogether-reference.json')


def uint(value):
    if not isinstance(value,str) or not re.fullmatch(r'0x[0-9a-fA-F]+',value): raise ValueError('RPC unsigned hex required')
    result=int(value,16)
    if result>=2**256: raise ValueError('RPC word overflow')
    return result


def decode_log(log,reference):
    address=identifier(log.get('address'),40)
    topics=log.get('topics')
    if not isinstance(topics,list) or len(topics)>4: raise ValueError('Invalid topics')
    if not topics: return None  # Valid EVM LOG0 from an unrelated contract.
    for topic in topics: identifier(topic,64)
    found=[e for e in reference['events'] if e['address']==address and e['topic']==topics[0].lower()]
    if not found: return None
    event=found[0]
    indexed=[f for f in event['inputs'] if f['indexed']]
    plain=[f for f in event['inputs'] if not f['indexed']]
    raw=log.get('data')
    if len(topics)!=len(indexed)+1 or not isinstance(raw,str) or not re.fullmatch(r'0x(?:[0-9a-fA-F]{2})*',raw) or len(raw)>8194:
        raise ValueError('Invalid event ABI envelope')
    data=bytes.fromhex(raw[2:]); types=[f['type'] for f in plain]
    try:
        values=decode(types,data)
        if encode(types,values)!=data: raise ValueError('Noncanonical event data')
        fields={f['name']:v for f,v in zip(plain,values)}
        for f,topic in zip(indexed,topics[1:]): fields[f['name']]=decode([f['type']],bytes.fromhex(topic[2:]))[0]
    except Exception as error: raise ValueError('ABI decoding rejected event') from error
    return dict(name=event['name'],fields=fields,index=uint(log['logIndex']))


def snapshot(value):
    if value is None: return None
    return dict(block=uint(value['blockNumber']),hash=identifier(value['blockHash'],64),balance=atomic(value['valueAtomic']))


def analyze(document,reference=None):
    reference=reference or json.loads(REFERENCE.read_text(encoding='utf-8'))
    if document.get('schemaVersion')!=1 or document.get('kind')!='pooltogether-reward-window' or \
            document.get('evidenceKind') not in ('illustrative','observed-unverified') or document.get('chainId')!=8453:
        raise ValueError('Explicit Base reward-window evidence required')
    operator=identifier(document.get('operator'),40)
    receipts=document.get('receipts')
    if not isinstance(receipts,list) or not 1<=len(receipts)<=1000: raise ValueError('Receipt budget exceeded')
    opening,closing=snapshot(document.get('openingRewardBalance')),snapshot(document.get('closingRewardBalance'))
    if opening and closing and opening['block']>=closing['block']: raise ValueError('Reversed balance window')
    claimed=allocated=withdrawn=self_withdrawn=cash=other_cash=errors=failed=execution_fees=l1_fees=operator_fees=0
    claimed_jobs=set(); seen_txs=set(); block_hashes={}; missing_fees=[]; different_payers=[]; findings=[]
    all_complete=all(r.get('logsComplete') is True for r in receipts)
    running=opening['balance'] if opening and closing and all_complete and document.get('windowCoverage')=='supplied-complete' else None
    previous_order=None
    for receipt in receipts:
        tx=identifier(receipt.get('transactionHash'),64)
        if tx in seen_txs: raise ValueError('Duplicate receipt')
        seen_txs.add(tx)
        block=uint(receipt['blockNumber']); block_hash=identifier(receipt['blockHash'],64)
        order=(block,uint(receipt['transactionIndex']))
        if previous_order is not None and order<=previous_order: raise ValueError('Receipts must be in canonical transaction order')
        previous_order=order
        if block in block_hashes and block_hashes[block]!=block_hash: raise ValueError('Mixed canonical hashes')
        block_hashes[block]=block_hash
        if opening and block<=opening['block'] or closing and block>closing['block']: raise ValueError('Receipt outside balance window')
        if opening and block==opening['block'] and opening['hash']!=block_hash or closing and block==closing['block'] and closing['hash']!=block_hash:
            raise ValueError('Snapshot block hash mismatch')
        payer=identifier(receipt.get('from'),40)
        success=uint(receipt['status'])
        if success not in (0,1): raise ValueError('Invalid receipt status')
        if payer==operator:
            if receipt.get('gasUsed') is None or receipt.get('effectiveGasPrice') is None: missing_fees.append(tx+':execution')
            else: execution_fees+=uint(receipt['gasUsed'])*uint(receipt['effectiveGasPrice'])
            for field in ('l1Fee','operatorFee'):
                if receipt.get(field) is None: missing_fees.append(tx+':'+field)
                elif field=='l1Fee': l1_fees+=uint(receipt[field])
                else: operator_fees+=uint(receipt[field])
        logs=receipt.get('logs'); complete=receipt.get('logsComplete') is True
        if not isinstance(logs,list) or len(logs)>5000: raise ValueError('Log budget exceeded')
        all_complete &= complete
        decoded=[]; indices=[]
        for log in logs:
            if identifier(log.get('transactionHash'),64)!=tx or identifier(log.get('blockHash'),64)!=block_hash or uint(log['blockNumber'])!=block or log.get('removed') is not False:
                raise ValueError('Mixed, removed or unpinned log')
            index=uint(log['logIndex']); indices.append(index)
            event=decode_log(log,reference)
            if event: decoded.append(event)
        if indices!=sorted(set(indices)) or complete and indices and indices!=list(range(indices[0],indices[-1]+1)):
            raise ValueError('Duplicate, unordered or gapped receipt logs')
        if not success:
            failed+=1
            if logs: raise ValueError('Failed receipt cannot retain logs')
            continue
        accruals=Counter(); mirrors=Counter(); relevant=False
        by_index={e['index']:e for e in decoded}
        for event in decoded:
            name,f=event['name'],event['fields']
            if name=='ClaimError': errors+=1
            elif name=='ClaimedPrize':
                job=(f['vault'],f['winner'],f['drawId'],f['tier'],f['prizeIndex'])
                if job in claimed_jobs: raise ValueError('Duplicate semantic prize claim')
                claimed_jobs.add(job)
                accruals[f['claimRewardRecipient']]+=f['claimReward']
                if f['claimRewardRecipient']==operator:
                    claimed+=f['claimReward']; relevant=True
                    if running is not None: running+=f['claimReward']
            elif name=='IncreaseClaimRewards': mirrors[f['to']]+=f['amount']
            elif name=='AllocateRewardFromReserve' and f['to']==operator:
                allocated+=f['amount']; relevant=True
                if running is not None: running+=f['amount']
            elif name=='WithdrawRewards' and f['account']==operator:
                withdrawn+=f['amount']; relevant=True
                if f['amount']>f['available']: raise ValueError('Withdrawal exceeds available rewards')
                if running is not None:
                    if f['available']!=running: raise ValueError('Intermediate reward balance does not reconcile')
                    running-=f['amount']
                if f['to']==reference['pool']:
                    self_withdrawn+=f['amount']
                    continue
                # Published implementation transfers first, then immediately emits WithdrawRewards.
                transfer=by_index.get(event['index']-1)
                if not transfer or transfer['name']!='Transfer' or transfer['fields']!=dict(
                        **{'from':reference['pool']},to=f['to'],value=f['amount']):
                    findings.append(tx+':withdrawal-transfer-not-confirmed')
                elif f['to']==operator: cash+=f['amount']
                else: other_cash+=f['amount']
        if complete and accruals!=mirrors: raise ValueError('Claim accrual differs from mirror event')
        if relevant and payer!=operator: different_payers.append(tx)
    expected=None; inventory_status='unknown-missing-balance-or-coverage'
    if opening and closing and document.get('windowCoverage')=='supplied-complete' and all_complete:
        expected=opening['balance']+claimed+allocated-withdrawn
        if expected<0 or expected!=closing['balance']: raise ValueError('Reward inventory does not reconcile')
        inventory_status='reconciled-supplied-balances; chain-authenticity-unverified'
    return dict(schemaVersion=1,kind='pooltogether-reward-accounting',chainId=8453,evidenceKind=document['evidenceKind'],operator=operator,
                prizeToken=reference['prizeToken'],amountUnit='atomic published prize-token units; live identity/decimals unverified',
                accruedClaimRewardsAtomic=str(claimed),reserveAllocationsAtomic=str(allocated),withdrawnRewardCreditAtomic=str(withdrawn),
                withdrawnBackToPoolAtomic=str(self_withdrawn),confirmedTransferToOperatorAtomic=str(cash),
                confirmedTransferToOtherRecipientAtomic=str(other_cash),knownExecutionFeesNativeAtomic=str(execution_fees),
                knownL1FeesNativeAtomic=str(l1_fees),knownOperatorFeesNativeAtomic=str(operator_fees),
                suppliedTotalFeesNativeAtomic=str(execution_fees+l1_fees+operator_fees) if not missing_fees and not different_payers else None,
                missingFeeComponents=missing_fees,unresolvedPayerTransactions=different_payers,findings=findings,
                innerClaimErrors=errors,failedTransactions=failed,uniqueTransactionCount=len(receipts),
                rewardInventoryStatus=inventory_status,expectedClosingRewardBalanceAtomic=str(expected) if expected is not None else None,
                conditionalNetAtomic=None,verifiedNetAtomic=None,mirRevenueReceived=None,qualified=False,
                runtimeVersions={name:importlib.metadata.version(name) for name in ('eth-abi','eth-utils')},
                limitations=['Accrual mirrors are not added twice; winner payouts are not caller revenue',
                             'Withdrawals can include opening balances and draw allocations; they are not all current claim income',
                             'Withdrawals back to PrizePool do not imply cash transfer',
                             'Receipt success does not erase individual ClaimError failures',
                             'L1/operator/withdrawal costs and native/prize-token conversion must be complete before net evaluation',
                             'Relevant transactions from another payer are not assumed free or attributed to this operator automatically',
                             'Supplied receipt exports, balance snapshots and deployed bytecode are not independently verified',
                             'No live backlog, competition or sustainable MIR revenue established'])


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('input',type=Path); args=parser.parse_args()
    if args.input.stat().st_size>8*1024*1024: raise ValueError('Input budget exceeded')
    raw=args.input.read_bytes(); result=analyze(json.loads(raw))
    result.update(inputSha256=hashlib.sha256(raw).hexdigest(),referenceSha256=hashlib.sha256(REFERENCE.read_bytes()).hexdigest(),
                  engineSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    payload=json.dumps(result,sort_keys=True,allow_nan=False).encode()
    folder=ROOT/'data/pooltogether-accounting'; folder.mkdir(parents=True,exist_ok=True)
    target=folder/(hashlib.sha256(payload).hexdigest()+'.json')
    try:
        with target.open('xb') as stream: stream.write(payload)
    except FileExistsError:
        if target.read_bytes()!=payload: raise ValueError('Immutable report mismatch')
    print(json.dumps({'file':str(target),**result}))


if __name__=='__main__': main()
