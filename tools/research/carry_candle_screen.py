"""Chronological, Decimal carry economics from observed candles and settlement marks.

Reference-price scenarios only: historical candles never establish executable fills.
"""
import argparse
from decimal import Decimal, ROUND_DOWN, localcontext
import hashlib
import json
from pathlib import Path
import re
import time
from urllib.parse import urlparse, parse_qs

from binance_history import HOUR, ROOT, POLICY, encode


def number(value, positive=False):
    if not isinstance(value,str): raise ValueError('Decimal strings required')
    result = Decimal(value)
    if not result.is_finite() or abs(result)>Decimal('1e20') or positive and result<=0:
        raise ValueError('Invalid numeric amount')
    return result


def provenance(document, folder):
    """Rebuild the bundled dataset from its immutable raw public response files."""
    if document.get('schemaVersion')!=1 or document.get('kind')!='binance-paired-candle-history' or document.get('status')!='captured':
        raise ValueError('Complete public capture required')
    policy_raw = POLICY.read_bytes()
    policy = json.loads(policy_raw)
    if document.get('policySha256')!=hashlib.sha256(policy_raw).hexdigest() or document.get('policy')!=policy:
        raise ValueError('Policy changed after collection')
    plan_sha = document.get('frozenPlanSha256','')
    if not re.fullmatch('[0-9a-f]{64}',plan_sha): raise ValueError('Missing frozen plan')
    plan_raw = (folder / (plan_sha+'.plan.json')).read_bytes()
    if hashlib.sha256(plan_raw).hexdigest()!=plan_sha: raise ValueError('Plan integrity mismatch')
    plan = json.loads(plan_raw)
    if any(document.get(k)!=v for k,v in plan.items()): raise ValueError('Frozen window changed')
    start,end = document.get('startMs'),document.get('endExclusiveMs')
    if type(start) is not int or type(end) is not int or start<0 or start%(24*HOUR) or end-start!=90*24*HOUR or \
            document.get('intervalMs')!=HOUR or document.get('quoteUnit')!='USDT' or \
            type(document.get('capturedAtMs')) is not int or end>document['captureStartedAtMs'] or \
            document['capturedAtMs']>int(time.time()*1000):
        raise ValueError('Invalid research window or capture chronology')
    rebuilt = {a:dict(identity={},spot=[],perp=[],mark=[],funding=[]) for a in policy['assets']}
    seen_meta,seen_funding,total = set(),set(),0
    records = document.get('requests',[])
    if not 1<=len(records)<=32 or document.get('requestCount')!=len(records): raise ValueError('Invalid request count')
    for record in records:
        if record.get('error') or record.get('httpStatus')!=200 or not document['captureStartedAtMs']<=record['requestedAtMs']<=record['capturedAtMs']<=document['capturedAtMs']:
            raise ValueError('Invalid or failed request evidence')
        sha = record.get('rawSha256','')
        if not re.fullmatch('[0-9a-f]{64}',sha): raise ValueError('Invalid raw file identity')
        path = folder / (sha+'.raw.json')
        if path.stat().st_size>8*1024*1024: raise ValueError('Raw response budget exceeded')
        raw = path.read_bytes(); total += len(raw)
        if total>32*1024*1024 or hashlib.sha256(raw).hexdigest()!=sha: raise ValueError('Raw evidence changed')
        response = json.loads(raw)
        url = urlparse(record['url']); query = parse_qs(url.query)
        if url.scheme!='https' or url.netloc not in ('api.binance.com','fapi.binance.com'): raise ValueError('Unknown source')
        spot = url.netloc=='api.binance.com'
        if url.path==('/api/v3/exchangeInfo' if spot else '/fapi/v1/exchangeInfo'):
            leg = 'spot' if spot else 'perp'
            if leg in seen_meta: raise ValueError('Duplicate metadata source')
            seen_meta.add(leg)
            for asset in rebuilt:
                matches = [r for r in response['symbols'] if r.get('symbol')==asset+'USDT']
                if len(matches)!=1: raise ValueError('Native market identity missing')
                rebuilt[asset]['identity'][leg] = matches[0]
            continue
        symbol = query.get('symbol',[''])[0]
        asset = symbol[:-4] if symbol.endswith('USDT') else ''
        if asset not in rebuilt or query.get('endTime')!=[str(end-1)]: raise ValueError('Symbol/window mismatch')
        if not spot and url.path=='/fapi/v1/fundingRate':
            if asset in seen_funding or query.get('startTime')!=[str(start)] or query.get('limit')!=['1000']:
                raise ValueError('Funding request mismatch')
            seen_funding.add(asset); rebuilt[asset]['funding'] = response
        else:
            kind = 'spot' if spot and url.path=='/api/v3/klines' else 'perp' if not spot and url.path=='/fapi/v1/klines' else 'mark' if not spot and url.path=='/fapi/v1/markPriceKlines' else None
            if kind is None or query.get('interval')!=['1h'] or query.get('startTime')!=[str(start+len(rebuilt[asset][kind])*HOUR)]:
                raise ValueError('Candle request chronology mismatch')
            rebuilt[asset][kind].extend(response)
    if seen_meta!={'spot','perp'} or seen_funding!=set(rebuilt) or rebuilt!=document['assets']:
        raise ValueError('Bundled data differs from raw source evidence')
    return policy


def normalize(asset, data, start, end):
    for leg in ('spot','perp'):
        identity = data['identity'][leg]
        if identity.get('symbol')!=asset+'USDT' or identity.get('baseAsset')!=asset or identity.get('quoteAsset')!='USDT' or \
                identity.get('status')!='TRADING' or leg=='perp' and (identity.get('contractType')!='PERPETUAL' or identity.get('marginAsset')!='USDT'):
            raise ValueError('Wrong native market identity')
    normalized = {}
    for kind in ('spot','perp','mark'):
        rows = data[kind]
        if len(rows)!=(end-start)//HOUR: raise ValueError('Missing candle coverage')
        normalized[kind] = []
        for i,row in enumerate(rows):
            if len(row)!=12 or type(row[0]) is not int or row[0]!=start+i*HOUR or row[6]!=row[0]+HOUR-1:
                raise ValueError('Candle time units, gaps or duplicates')
            o,h,l,c = [number(v,True) for v in row[1:5]]
            if not l<=min(o,c)<=max(o,c)<=h: raise ValueError('Inconsistent candle prices')
            normalized[kind].append(dict(timeMs=row[0],open=o,high=h,low=l,close=c))
    events,previous = [],None
    # This v1 supports the default eight-hour schedule only. Changed schedules fail closed.
    expected_slots = list(range(start,end,8*HOUR))
    if len(data['funding'])!=len(expected_slots): raise ValueError('Funding gaps or unsupported settlement schedule')
    for row,slot in zip(data['funding'],expected_slots):
        stamp = row.get('fundingTime')
        if row.get('symbol')!=asset+'USDT' or type(stamp) is not int or abs(stamp-slot)>15000 or \
                previous is not None and stamp<=previous or row.get('rateType','Regular')!='Regular':
            raise ValueError('Funding identity, sequence or schedule mismatch')
        rate,mark = number(row['fundingRate']),number(row['markPrice'],True)
        if abs(rate)>Decimal('.04'): raise ValueError('Invalid funding rate')
        events.append(dict(timeMs=stamp,slotMs=slot,rate=rate,mark=mark)); previous = stamp
    normalized['funding'] = events
    steps = []
    for leg in ('spot','perp'):
        found = [f for f in data['identity'][leg]['filters'] if f.get('filterType')=='LOT_SIZE']
        if len(found)!=1: raise ValueError('Unknown size increment')
        steps.append(number(found[0]['stepSize'],True))
    step = max(steps)
    if any(step/s != (step/s).to_integral_value() for s in steps): raise ValueError('Incompatible common size step')
    normalized['step'] = step
    return normalized


def simulate(data,policy,capital,multiplier,begin,finish):
    with localcontext() as ctx:
        ctx.prec = 50
        return _simulate(data,policy,capital,multiplier,begin,finish)


def _simulate(data,policy,capital,multiplier,begin,finish):
    capital = number(capital,True)
    fee_s = number(policy['spotTakerFeeBps'])/10000*multiplier
    fee_p = number(policy['perpTakerFeeBps'])/10000*multiplier
    slip = number(policy['perLegSlippageBps'])/10000*multiplier
    apr = number(policy['capitalOpportunityApr'])*multiplier
    maintenance = number(policy['maintenanceMarginBps'])/10000
    if type(multiplier) is not int or multiplier not in (1,2) or not 0<=fee_s<1 or not 0<=fee_p<1 or not 0<=slip<1 or apr<0 or not 0<maintenance<1:
        raise ValueError('Invalid cost policy')
    # Enter at 01:00, exit at 23:00 on the last day: avoid both settlement boundaries.
    first,last = begin+1,finish-1
    if last<=first or last>=len(data['spot']): raise ValueError('Invalid chronological segment')
    entry_time,exit_time = data['spot'][first]['timeMs'],data['spot'][last]['timeMs']
    funding = [e for e in data['funding'] if entry_time+15000<e['timeMs']<exit_time-15000]
    if len(funding)<policy['minimumRoundTripFundingIntervals']: raise ValueError('Insufficient funding intervals')
    s0,p0 = data['spot'][first]['open'],data['perp'][first]['open']
    entry_spot,entry_perp = s0*(1+slip),p0*(1-slip)
    quantity = (capital*number(policy['spotAllocation'],True)/(entry_spot*(1+fee_s))/data['step']).to_integral_value(rounding=ROUND_DOWN)*data['step']
    if quantity<=0: raise ValueError('Capital below common size step')
    margin = capital*number(policy['marginAllocation'],True)
    entry_fees = quantity*(entry_spot*fee_s+entry_perp*fee_p)
    committed = quantity*entry_spot*(1+fee_s)+margin+quantity*entry_perp*fee_p
    if committed>capital: raise ValueError('Capital allocation exceeds budget')
    accrued = Decimal(0); peak = capital; max_dd = Decimal(0); ledger = []
    events_by_slot = {event['slotMs']:event for event in funding}
    status = 'completed-reference-scenario'
    for index in range(first,last):
        stamp = data['spot'][index]['timeMs']
        event = events_by_slot.get(stamp)
        payment = quantity*event['mark']*event['rate'] if event else Decimal(0)
        elapsed = Decimal(stamp+HOUR-entry_time)/Decimal(365*24*HOUR)
        opportunity = capital*apr*elapsed
        # Positive funding later in a bar cannot rescue an earlier margin high.
        margin_low = margin+quantity*(entry_perp-data['mark'][index]['high'])+accrued+min(payment,Decimal(0))
        possible_breach = margin_low<=quantity*data['mark'][index]['high']*maintenance
        low_spot,high_perp = data['spot'][index]['low']*(1-slip),data['perp'][index]['high']*(1+slip)
        worst_net = quantity*(low_spot-entry_spot+entry_perp-high_perp)+accrued+min(payment,Decimal(0))-entry_fees-quantity*(low_spot*fee_s+high_perp*fee_p)-opportunity
        worst_dd = max(Decimal(0),(peak-capital-worst_net)/peak)
        max_dd = max(max_dd,worst_dd)
        accrued += payment
        s1,p1 = data['spot'][index+1]['open'],data['perp'][index+1]['open']
        exit_spot,exit_perp = s1*(1-slip),p1*(1+slip)
        basis = quantity*(s1-s0+p0-p1)
        slippage = quantity*(entry_spot-s0+p0-entry_perp+s1-exit_spot+exit_perp-p1)
        fees = entry_fees+quantity*(exit_spot*fee_s+exit_perp*fee_p)
        net = basis+accrued-slippage-fees-opportunity
        peak = max(peak,capital+net)
        ledger.append(dict(timeMs=stamp+HOUR,referenceBasisPnlQuote=str(basis),fundingPaymentQuote=str(payment),
                           cumulativeFundingQuote=str(accrued),assumedSlippageCostQuote=str(slippage),assumedFeesQuote=str(fees),
                           assumedCapitalOpportunityCostQuote=str(opportunity),conditionalNetQuote=str(net),
                           conservativeIntrahourDrawdownBound=str(worst_dd),marginEquityLowerBoundQuote=str(margin_low)))
        if possible_breach:
            status = 'rejected-possible-intrahour-margin-breach'; break
        if worst_dd>=number(policy['maximumDrawdown'],True):
            status = 'rejected-possible-intrahour-drawdown-stop'; break
    return dict(capitalQuote=str(capital),quoteUnit='USDT',quantityBase=str(quantity),unusedReserveQuote=str(capital-committed),
                entryTimeMs=entry_time,intendedExitTimeMs=exit_time,evaluatedThroughMs=ledger[-1]['timeMs'],
                status=status,conditionalNetQuote=ledger[-1]['conditionalNetQuote'] if status=='completed-reference-scenario' else None,
                verifiedNetQuote=None,netUsd=None,qualified=False,actualFills=0,
                maximumConservativeDrawdownBound=str(max_dd),ledger=ledger)


def evaluate(document,policy):
    normalized = {a:normalize(a,d,document['startMs'],document['endExclusiveMs']) for a,d in document['assets'].items()}
    cases = []
    for asset in policy['assets']:
        for period,begin,finish in [('development',0,60*24),('heldout',60*24,90*24)]:
            for capital in policy['capitalBudgetsQuote']:
                for multiplier in policy['stressMultipliers']:
                    cases.append(dict(asset=asset,period=period,costMultiplier=multiplier,
                                      result=simulate(normalized[asset],policy,capital,multiplier,begin,finish)))
    screens = []
    for asset in policy['assets']:
        for capital in policy['capitalBudgetsQuote']:
            group = [c for c in cases if c['asset']==asset and c['period']=='heldout' and c['result']['capitalQuote']==str(Decimal(capital))]
            reasons = [f"cost-x{c['costMultiplier']}:{c['result']['status']}" if c['result']['conditionalNetQuote'] is None else
                       f"cost-x{c['costMultiplier']}:nonpositive-conditional-net" for c in group
                       if c['result']['conditionalNetQuote'] is None or Decimal(c['result']['conditionalNetQuote'])<=0]
            screens.append(dict(asset=asset,capitalQuote=capital,status='rejected-reference-scenario' if reasons else 'positive-conditional-screen-only',
                                reasons=reasons,qualified=False,verifiedNetQuote=None))
    return dict(schemaVersion=1,kind='carry-candle-economic-screen',quoteUnit='USDT',cases=cases,screens=screens,
                qualified=False,verifiedNetQuote=None,netUsd=None,actualFills=0,decision='insufficient-execution-evidence',
                limitations=['Reference candle opens are not synchronized executable quotes or fills',
                             'Fees, slippage, opportunity APR and maintenance are frozen assumptions, not verified account costs',
                             'Current native lot increments are not historical rule certification',
                             'Intrahour bounds combine separate extremes conservatively; possible stops are rejected without invented fills',
                             'USDT valuation and transfer, custody, outage and withdrawal costs remain unverified',
                             'Chronological retrospective 60/30 split; no optimization or winner selection on heldout results',
                             'Positive conditional results require depth replay and a frozen 30-day forward policy before promotion'])


def main():
    parser = argparse.ArgumentParser(description=__doc__); parser.add_argument('input',type=Path)
    args = parser.parse_args()
    if args.input.stat().st_size>16*1024*1024: raise ValueError('Input budget exceeded')
    raw = args.input.read_bytes(); source_sha = hashlib.sha256(raw).hexdigest()
    if args.input.name!=source_sha+'.json': raise ValueError('Capture content identity mismatch')
    document = json.loads(raw)
    policy = provenance(document,args.input.parent)
    report = evaluate(document,policy)
    report.update(sourceSha256=source_sha,policySha256=document['policySha256'],frozenPlanSha256=document['frozenPlanSha256'],
                  engineSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),evaluatedAtMs=int(time.time()*1000))
    payload = encode(report)
    if len(payload)>32*1024*1024: raise ValueError('Output budget exceeded')
    folder = ROOT / 'data/carry-candle-screen'; folder.mkdir(parents=True,exist_ok=True)
    target = folder / (hashlib.sha256(payload).hexdigest()+'.json')
    with target.open('xb') as stream: stream.write(payload)
    print(json.dumps({'file':str(target),'screens':report['screens'],'qualified':False,'verifiedNetQuote':None,
                      'heldoutCases':[dict(asset=c['asset'],costMultiplier=c['costMultiplier'],
                                           **{k:v for k,v in c['result'].items() if k!='ledger'}) for c in report['cases'] if c['period']=='heldout']}))


if __name__ == '__main__': main()
