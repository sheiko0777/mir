"""Read-only Aave reserve index history and conservative atomic-unit lending scenarios.

Uses the already reviewed eth-utils dependency in .venv-almanak for ABI selectors.
No wallet, approval, transaction, state override or financial execution is available.
"""
import hashlib
import argparse
import json
from decimal import Decimal, ROUND_DOWN, localcontext
from pathlib import Path
import re
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[2]
POLICY = ROOT / 'tools/research/policies/lending-index-v1.json'
RPC = 'https://arb1.arbitrum.io/rpc'
RPC_PROFILES = {'official':RPC,'publicnode':'https://arbitrum-one-rpc.publicnode.com'}
BOOK = 'https://raw.githubusercontent.com/bgd-labs/aave-address-book/main/src/AaveV3Arbitrum.sol'
RAY = 10**27


def encode(value): return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()


def calculate(capital,policy,start,end,seconds,available_atomic,config,multiplier):
    if type(start) is not int or type(end) is not int or not RAY<=start<=end or type(seconds) is not int or seconds<=0 or \
            type(available_atomic) is not int or available_atomic<0 or type(config) is not int or config<0 or type(multiplier) is not int or multiplier not in (1,2):
        raise ValueError('Invalid reserve index, time, liquidity or cost policy')
    with localcontext() as ctx:
        ctx.prec = 70
        capital = Decimal(capital)
        scale = 10**policy['decimals']
        fraction = Decimal(policy['deployedFraction'])
        if not capital.is_finite() or capital<=0 or not 0<fraction<1:
            raise ValueError('Invalid capital allocation')
        deposit = int((capital*fraction*scale).to_integral_value(rounding=ROUND_DOWN))
        # Floor both conversions: a conservative reference, not an exact replica of all aToken versions.
        scaled = deposit*RAY//start
        redemption = scaled*end//RAY
        gross = Decimal(redemption-deposit)/scale
        reserve = Decimal(policy['roundTripCostReserveAsset'])*multiplier
        opportunity = capital*Decimal(policy['capitalOpportunityApr'])*multiplier*seconds/Decimal(365*24*3600)
        if reserve<0 or opportunity<0 or reserve>capital-Decimal(deposit)/scale:
            raise ValueError('Cost reserve exceeds undeployed capital')
        reasons = []
        if not config & (1<<56) or config & (1<<60): reasons.append('reserve-inactive-or-paused')
        if config & (1<<57): reasons.append('reserve-frozen-for-new-supply')
        if redemption>available_atomic: reasons.append('insufficient-snapshot-withdrawal-liquidity')
        net = gross-reserve-opportunity
        return dict(capitalAsset=str(capital),deployedAsset=str(Decimal(deposit)/scale),undeployedAsset=str(capital-Decimal(deposit)/scale),
                    grossIndexAccrualAsset=str(gross),assumedRoundTripCostReserveAsset=str(reserve),
                    assumedCapitalOpportunityCostAsset=str(opportunity),conditionalNetAsset=str(net),
                    costMultiplier=multiplier,assetUnit=policy['assetUnit'],durationSeconds=seconds,
                    status='rejected-snapshot-constraints' if reasons else 'positive-conditional-screen-only' if net>0 else 'nonpositive-conditional-screen',
                    reasons=reasons,verifiedNetAsset=None,netUsd=None,qualified=False,actualTransactions=0)


class Reader:
    def __init__(self,policy,rpc=RPC):
        from eth_utils import keccak
        if rpc not in RPC_PROFILES.values(): raise ValueError('Unknown public RPC profile')
        self.policy = policy; self.rpc = rpc; self.records = []; self.began = time.monotonic()
        self.allowed = set()
        self.encoded = {}
        for name,to,signature,arg in [
            ('index',policy['pool'],'getReserveNormalizedIncome(address)',policy['underlying']),
            ('config',policy['pool'],'getConfiguration(address)',policy['underlying']),
            ('decimals',policy['underlying'],'decimals()',None),
            ('liquidity',policy['underlying'],'balanceOf(address)',policy['aToken']),
            ('underlying',policy['aToken'],'UNDERLYING_ASSET_ADDRESS()',None),
            ('pool',policy['aToken'],'POOL()',None)]:
            data = '0x'+keccak(text=signature).hex()[:8]+(arg[2:].zfill(64) if arg else '')
            self.allowed.add((to,data)); self.encoded[name] = (to,data)

    def call(self,method,params):
        if len(self.records)>=128 or time.monotonic()-self.began>240: raise ValueError('RPC admission budget exhausted')
        if method=='eth_chainId' and params==[]: pass
        elif method=='eth_getBlockByNumber' and len(params)==2 and params[1] is False and (params[0]=='finalized' or re.fullmatch('0x[0-9a-f]+',params[0])): pass
        elif method=='eth_call' and len(params)==2 and set(params[0])=={'to','data'} and \
                (params[0]['to'],params[0]['data']) in self.allowed and re.fullmatch('0x[0-9a-f]+',params[1]): pass
        else: raise ValueError('Only allowlisted pinned view calls permitted')
        record = dict(method=method,params=params,requestedAtMs=int(time.time()*1000))
        identifier = len(self.records)+1
        body = encode(dict(jsonrpc='2.0',id=identifier,method=method,params=params))
        try:
            request = urllib.request.Request(self.rpc,data=body,headers={'Content-Type':'application/json'},method='POST')
            with urllib.request.urlopen(request,timeout=15) as response: raw = response.read(256*1024+1)
            if len(raw)>256*1024: raise ValueError('RPC response budget exceeded')
            parsed = json.loads(raw); record['response'] = parsed
            if parsed.get('id')!=identifier or parsed.get('error') or 'result' not in parsed:
                raise ValueError('RPC response failed: '+str(parsed.get('error')))
            return parsed['result']
        except urllib.error.HTTPError as error:
            record.update(httpStatus=error.code,error=error.read(4096).decode('utf-8',errors='replace')); raise
        except Exception as error:
            record['error'] = str(error); raise
        finally:
            record['capturedAtMs'] = int(time.time()*1000); self.records.append(record)

    def block(self,number):
        result = self.call('eth_getBlockByNumber',[number if isinstance(number,str) else hex(number),False])
        if not isinstance(result,dict) or not re.fullmatch('0x[0-9a-fA-F]{64}',result.get('hash','')) or \
                not re.fullmatch('0x[0-9a-fA-F]+',result.get('number','')) or not re.fullmatch('0x[0-9a-fA-F]+',result.get('timestamp','')) or \
                int(result['timestamp'],16)>int(time.time()) or \
                number!='finalized' and int(result['number'],16)!=(int(number,16) if isinstance(number,str) else number):
            raise ValueError('Invalid block header')
        return result

    def at_time(self,target,head):
        low,high = 0,int(head['number'],16)
        if int(head['timestamp'],16)<target: raise ValueError('Target beyond finalized head')
        while low+1<high:
            mid = (low+high)//2
            block = self.block(mid)
            if int(block['timestamp'],16)<target: low=mid
            else: high=mid
        before,after = self.block(low),self.block(high)
        if not int(before['timestamp'],16)<target<=int(after['timestamp'],16) or int(after['timestamp'],16)-target>60:
            raise ValueError('Timestamp bracket unavailable')
        return after

    def view(self,name,block):
        to,data = self.encoded[name]
        value = self.call('eth_call',[dict(to=to,data=data),block['number']])
        if not isinstance(value,str) or not re.fullmatch('0x[0-9a-fA-F]{64}',value): raise ValueError('Invalid ABI word')
        return int(value,16)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rpc-profile',choices=RPC_PROFILES,default='official')
    rpc = RPC_PROFILES[parser.parse_args().rpc_profile]
    policy_raw = POLICY.read_bytes(); policy = json.loads(policy_raw)
    folder = ROOT / 'data/lending-index'; folder.mkdir(parents=True,exist_ok=True)
    end = int(time.time())//86400*86400
    report = dict(schemaVersion=1,kind='aave-lending-index-research',policy=policy,
                  policySha256=hashlib.sha256(policy_raw).hexdigest(),requestedTimes=[end-90*86400,end-30*86400,end],
                  createdAtMs=int(time.time()*1000),rpc=rpc,qualified=False,netUsd=None,actualTransactions=0)
    plan_raw = encode(report)
    plan_sha = hashlib.sha256(plan_raw).hexdigest()
    with (folder/(plan_sha+'.plan.json')).open('xb') as stream: stream.write(plan_raw)
    report['frozenPlanSha256'] = plan_sha
    reader = Reader(policy,rpc)
    try:
        with urllib.request.urlopen(BOOK,timeout=20) as response: source = response.read(128*1024+1)
        text = source.decode()
        if len(source)>128*1024: raise ValueError('Address source budget exceeded')
        for name,address in [('POOL',policy['pool']),('USDT_UNDERLYING',policy['underlying']),('USDT_A_TOKEN',policy['aToken'])]:
            pattern = r'\b'+name+r'\s*=\s*'+(r'IPool\(' if name=='POOL' else '')+r'(0x[0-9a-fA-F]{40})'
            matched = re.search(pattern,text)
            if not matched or matched.group(1).lower()!=address.lower(): raise ValueError('Published address source changed; review required')
        report['addressSource'] = dict(url=BOOK,sha256=hashlib.sha256(source).hexdigest())
        (folder/(report['addressSource']['sha256']+'.source.sol')).write_bytes(source)
        if int(reader.call('eth_chainId',[]),16)!=policy['chainId']: raise ValueError('Wrong chain')
        head = reader.block('finalized')
        # Confirm archive access before spending requests on three timestamp searches.
        probe = reader.block(max(1,int(head['number'],16)-90*86400*4))
        reader.view('index',probe)
        snapshots = []
        for target in report['requestedTimes']:
            block = reader.at_time(target,head)
            values = {name:reader.view(name,block) for name in ('index','config','decimals','liquidity','underlying','pool')}
            if values['decimals']!=policy['decimals'] or values['underlying']!=int(policy['underlying'],16) or values['pool']!=int(policy['pool'],16):
                raise ValueError('Native reserve identity or decimals mismatch')
            if reader.block(int(block['number'],16))['hash']!=block['hash']: raise ValueError('Canonical block changed')
            snapshots.append(dict(targetTime=target,blockNumber=block['number'],blockHash=block['hash'],
                                  blockTime=int(block['timestamp'],16),values=values))
        report['snapshots'] = snapshots
        cases = []
        for i,period in enumerate(('development','heldout')):
            first,last = snapshots[i:i+2]
            for capital in policy['capitalBudgets']:
                for multiplier in policy['costMultipliers']:
                    result = calculate(capital,policy,first['values']['index'],last['values']['index'],
                                       last['blockTime']-first['blockTime'],last['values']['liquidity'],last['values']['config'],multiplier)
                    if not first['values']['config']&(1<<56) or first['values']['config']&((1<<57)|(1<<60)):
                        result['reasons'].append('entry-reserve-inactive-frozen-or-paused'); result['status']='rejected-snapshot-constraints'
                    cases.append(dict(period=period,result=result))
        # Recheck all snapshots after collection, not only immediately after each view batch.
        for snapshot in snapshots:
            if reader.block(int(snapshot['blockNumber'],16))['hash']!=snapshot['blockHash']: raise ValueError('Canonical block changed')
        report.update(status='captured-and-calculated',cases=cases,
                      limitations=['Index accrual is a protocol-state observation, not a realized wallet profit',
                                   'Supply/withdraw execution, full fees, caps and outage/liquidity history not simulated',
                                   'Cost reserve and opportunity APR are assumptions; USD peg and bridge safety not assumed',
                                   'No borrowing, rewards tokens, leverage or strategy winner selection',
                                   'Three canonical snapshots cannot establish 30-day drawdown or forward validation'])
    except Exception as error:
        report.update(status='unavailable-or-incomplete',error=str(error))
    report.update(requests=reader.records,requestCount=len(reader.records),capturedAtMs=int(time.time()*1000))
    raw = encode(report); target = folder/(hashlib.sha256(raw).hexdigest()+'.json')
    with target.open('xb') as stream: stream.write(raw)
    print(json.dumps({'file':str(target),'status':report['status'],'error':report.get('error'),
                      'requests':len(reader.records),'cases':report.get('cases',[]),'qualified':False}))


if __name__ == '__main__': main()
