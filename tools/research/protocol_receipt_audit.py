"""Audit a bounded, frozen discovery set of historical protocol transfers."""
import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.request
import urllib.error
import protocol_income_evidence as evidence
import liquity_screen as base

PROVIDE = '0x'+evidence.keccak(text='Provide(uint256)').hex()
WITHDRAW = '0x'+evidence.keccak(text='Withdraw(uint256)').hex()
PROFIT = '0x'+evidence.keccak(text='Profit(uint256)').hex()


def selection(doc, analysis):
    gas_pool=analysis['liquity']['gasPool']; sets={}
    for row in doc['records']:
        if row['method']=='alchemy_getAssetTransfers' and 'result' in row:
            address=row['params'][0]['fromAddress']
            hashes=list(dict.fromkeys(item['hash'] for item in row['result']['transfers']))
            sets[address]=hashes if address==gas_pool else hashes[:4]
    hashes=list(dict.fromkeys(tx for group in sets.values() for tx in group))
    if len(hashes)>128: raise ValueError('Receipt audit exceeds 128 transactions')
    return sets,hashes


def curve_payment(receipt, keeper, pool):
    if receipt.get('status')!='0x1': return None
    events=[log for log in receipt.get('logs',[]) if log.get('address','').lower()==keeper]
    if not any(log.get('topics') in ([PROVIDE],[WITHDRAW]) for log in events): return None
    if any(log.get('topics')==[PROFIT] for log in events):
        return dict(txHash=receipt['transactionHash'], status='mixed-caller-and-protocol-profit-unresolved')
    transfers=[row for row in evidence.transfer_logs(receipt,pool) if row['sender']==keeper and row['amount']>0
               and row['recipient'] not in ('0x'+'0'*40,keeper)]
    if not transfers: return None
    return dict(txHash=receipt['transactionHash'],status='caller-lp-transfers-observed',
                payouts=[dict(recipient=row['recipient'],lpAtomic=str(row['amount'])) for row in transfers],
                lpToken=pool,gasWei=str(base.quantity(receipt['gasUsed'])*int(receipt['effectiveGasPrice'],16)),
                gasPayer=receipt['from'].lower(), verifiedNetAtomic=None,
                missing=['Historical executable LP redemption quote','Reward/gas conversion','Failed attempts and operating costs'])


def analyze(read_many,doc,analysis):
    sets,hashes=selection(doc,analysis); receipts={}
    for offset in range(0,len(hashes),8):
        subset=hashes[offset:offset+8]
        values=read_many([['eth_getTransactionReceipt',[tx]] for tx in subset])
        if len(values)!=len(subset): raise ValueError('Incomplete receipt batch')
        for tx,receipt in zip(subset,values):
            if not isinstance(receipt,dict) or receipt.get('transactionHash')!=tx or not evidence.re.fullmatch(evidence.HASH,receipt.get('blockHash','')) or not analysis['startBlock']<=base.quantity(receipt['blockNumber'])<=analysis['sourceBlock']:
                raise ValueError('Receipt outside frozen discovery')
            receipts[tx]=receipt
    head=read_many([['eth_getBlockByNumber',[hex(analysis['sourceBlock']),False]]])[0]
    if head.get('hash')!=analysis['sourceBlockHash']: raise ValueError('Frozen discovery block changed')
    gas_pool=analysis['liquity']['gasPool']; active=analysis['liquity']['activePool']
    liquidations=[]; other=0
    for tx in sets[gas_pool]:
        payment=evidence.liquidation_payment(receipts[tx],gas_pool,active)
        if payment: liquidations.append(payment)
        else: other+=1
    curves=[]
    for entry in analysis['curve']:
        if entry['address'] not in sets: continue
        payments=[curve_payment(receipts[tx],entry['address'],entry['pool']) for tx in sets[entry['address']]]
        curves.append(dict(address=entry['address'],pool=entry['pool'],sampledTransactions=len(payments),
                           paymentObservations=[x for x in payments if x is not None],
                           fullHistoryReceiptCoverage=False,verifiedNetAtomic=None))
    return dict(kind='protocol-receipt-economic-audit',windowSeconds=analysis['windowSeconds'],
                receiptsInspected=len(receipts),liquity=dict(discoveryTransactions=len(sets[gas_pool]),
                allDiscoveredReceiptsInspected=True,transferDiscoveryComplete=analysis['liquity']['transferDiscoveryComplete'],
                liquidationPayments=liquidations,otherGasPoolTransactions=other,
                grossWethAtomic=str(sum(int(x['rewardWethAtomic']) for x in liquidations)),
                successfulLiquidationGasWei=str(sum(int(x['gasWei']) for x in liquidations))),curve=curves,
                qualified=False,verifiedNetAtomic=None,
                limitations=['Provider indexed transfers, not independent chain-wide event proof',
                             'Historical winners are not MIR revenue', 'No failed-race or operating-cost coverage',
                             'Curve sample is four recent discovery transactions per keeper; no demand extrapolation'])


class Capture:
    def __init__(self, hashes, head):
        self._rpc,self.source=base.rpc_configuration()
        if self.source!=base.ALCHEMY_SOURCE: raise ValueError('Authorized Alchemy environment required')
        self.hashes=set(hashes); self.head=head; self.records=[]; self.calls=0; self.raw_bytes=0; self.started=time.monotonic()
        self.opener=urllib.request.build_opener(base.NoRedirect())

    def read_many(self,requests):
        if not 1<=len(requests)<=8: raise ValueError('Audit batch budget exceeded')
        for method,params in requests:
            if not ((method=='eth_getTransactionReceipt' and len(params)==1 and params[0] in self.hashes) or
                    (method=='eth_getBlockByNumber' and params==[hex(self.head),False])):
                raise ValueError('Audit read outside frozen selection')
        if self.calls+len(requests)>129 or len(self.records)>=20 or time.monotonic()-self.started>=60: raise ValueError('Audit resource budget exceeded')
        self.calls+=len(requests); row=dict(requests=requests); self.records.append(row)
        body=json.dumps([dict(jsonrpc='2.0',id=i,method=m,params=p) for i,(m,p) in enumerate(requests)]).encode()
        try:
            req=urllib.request.Request(self._rpc,data=body,headers={'Content-Type':'application/json'})
            with self.opener.open(req,timeout=min(8,max(.1,60-(time.monotonic()-self.started)))) as response: raw=response.read(524289)
            self.raw_bytes+=len(raw)
            if len(raw)>524288 or self.raw_bytes>4194304: raise ValueError('Audit byte budget exceeded')
            from liquity_inventory import validate_batch
            results=validate_batch(json.loads(raw),len(requests)); row['results']=results; return results
        except urllib.error.HTTPError as error:
            row['error']='HTTP '+str(error.code); raise evidence.SourceUnavailable('Audit source refused request') from None
        except Exception:
            row['error']='Audit source unavailable or invalid'; raise evidence.SourceUnavailable('Audit source unavailable or invalid') from None


def replay(path,discovery):
    analysis=evidence.replay(discovery); original=json.loads(discovery.read_bytes())
    if path.stat().st_size>4194304: raise ValueError('Audit replay file too large')
    raw=path.read_bytes()
    if path.name!=hashlib.sha256(raw).hexdigest()+'.json': raise ValueError('Audit identity mismatch')
    doc=json.loads(raw)
    if doc.get('kind')!='protocol-receipt-audit-capture' or doc.get('source')!=base.ALCHEMY_SOURCE or doc.get('discoverySha256')!=discovery.stem or doc.get('engineSha256')!=hashlib.sha256(Path(__file__).read_bytes()).hexdigest() or not isinstance(doc.get('analysis'),dict): raise ValueError('Audit provenance mismatch')
    cursor=0; rows=doc['records']
    if not isinstance(rows,list) or len(rows)>20: raise ValueError('Audit replay budget exceeded')
    def read(requests):
        nonlocal cursor
        if cursor>=len(rows): raise ValueError('Incomplete audit transcript')
        row=rows[cursor]; cursor+=1
        if row.get('requests')!=requests or 'error' in row or not isinstance(row.get('results'),list): raise ValueError('Audit transcript mismatch')
        return row['results']
    result=analyze(read,original,analysis)
    if cursor!=len(rows) or result!=doc['analysis']: raise ValueError('Audit result did not reproduce')
    return result


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('--discovery',required=True,type=Path)
    parser.add_argument('--replay',type=Path); parser.add_argument('--recalculate',type=Path); args=parser.parse_args()
    if args.replay:
        print(json.dumps(dict(replayed=True,analysis=replay(args.replay,args.discovery)))); return
    analysis=evidence.replay(args.discovery); doc=json.loads(args.discovery.read_bytes())
    _,hashes=selection(doc,analysis); result=None; failure=None
    if args.recalculate:
        from types import SimpleNamespace
        raw=args.recalculate.read_bytes()
        if len(raw)>4194304 or args.recalculate.name!=hashlib.sha256(raw).hexdigest()+'.json': raise ValueError('Recalculation identity mismatch')
        previous=json.loads(raw)
        if previous.get('kind')!='protocol-receipt-audit-capture' or previous.get('source')!=base.ALCHEMY_SOURCE or previous.get('discoverySha256')!=args.discovery.stem: raise ValueError('Recalculation provenance mismatch')
        rows=previous['records']; cursor=0
        if not isinstance(rows,list) or len(rows)>20: raise ValueError('Recalculation budget exceeded')
        def read_many(requests):
            nonlocal cursor
            if cursor>=len(rows): raise ValueError('Incomplete recalculation transcript')
            row=rows[cursor]; cursor+=1
            if row.get('requests')!=requests or 'error' in row or not isinstance(row.get('results'),list): raise ValueError('Recalculation transcript mismatch')
            return row['results']
        # Deliberately ignore the old analysis and engine identity: rebuild from raw,
        # content-verified responses using this version. Retain the old artifact identity.
        capture=SimpleNamespace(source=base.ALCHEMY_SOURCE,records=rows,calls=len(hashes)+1)
    else:
        capture=Capture(hashes,analysis['sourceBlock']); read_many=capture.read_many
    try:
        result=analyze(read_many,doc,analysis)
        if args.recalculate and cursor!=len(rows): raise ValueError('Unused recalculation transcript')
    except Exception as error: failure=type(error).__name__; result=None
    output=dict(kind='protocol-receipt-audit-capture',source=capture.source,discoverySha256=args.discovery.stem,
                engineSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),records=capture.records,analysis=result,failure=failure,
                recalculatedFrom=args.recalculate.stem if args.recalculate else None)
    raw=json.dumps(output,sort_keys=True).encode() if args.recalculate else base.capture_payload(output,capture)
    name=hashlib.sha256(raw).hexdigest()
    folder=base.ROOT/'data/protocol-income'; folder.mkdir(parents=True,exist_ok=True)
    with (folder/(name+'.json')).open('xb') as stream: stream.write(raw)
    print(json.dumps(dict(id=name,httpRequests=len(capture.records),logicalCalls=capture.calls,failure=failure,analysis=result)))


if __name__=='__main__': main()
