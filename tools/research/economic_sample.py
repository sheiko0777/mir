"""Produce a reviewable data-QA sample from existing evidence; no network or payment."""
import argparse
import hashlib
import json
from pathlib import Path
from statistics import median
import time
from datetime import datetime, timezone

from carry_candle_screen import provenance, normalize

ROOT=Path(__file__).resolve().parents[2]


def utc(ms): return datetime.fromtimestamp(ms/1000,timezone.utc).isoformat()


def audit(path):
    if path.stat().st_size>16*1024*1024: raise ValueError('Snapshot exceeds audit budget')
    raw=path.read_bytes(); sha=hashlib.sha256(raw).hexdigest()
    if path.name!=sha+'.json': raise ValueError('Snapshot content identity mismatch')
    document=json.loads(raw)
    runs=[]; assets=None
    for _ in range(3):
        began=time.perf_counter(); cpu=time.process_time()
        policy=provenance(document,path.parent)
        assets=[]
        for asset in policy['assets']:
            normalized=normalize(asset,document['assets'][asset],document['startMs'],document['endExclusiveMs'])
            events=normalized['funding']
            assets.append(dict(asset=asset,quoteUnit='USDT',spotCandles=len(normalized['spot']),
                               perpetualCandles=len(normalized['perp']),markCandles=len(normalized['mark']),
                               fundingSettlements=len(events),fundingWithAssociatedMarkPrice=len(events),
                               nativeIdentity='matched-published-capture-metadata',
                               historicalTradingRulesCertified=False))
        runs.append(dict(elapsedMs=round((time.perf_counter()-began)*1000,3),cpuMs=round((time.process_time()-cpu)*1000,3)))
    return dict(schemaVersion=1,kind='mir-data-quality-service-sample',sampleStatus='research-demonstration-no-customer-payment',
                sourceSha256=sha,policySha256=document['policySha256'],sourceCapturedAtMs=document['capturedAtMs'],
                sourceWindow=dict(startMs=document['startMs'],endExclusiveMs=document['endExclusiveMs']),
                assets=assets,sourceRequests=document['requestCount'],sourceRawBytes=document['rawBytes'],
                validation=['raw-response hashes matched','bundle rebuilt from source responses',
                            'frozen policy and window matched','contiguous closed-hour candle coverage',
                            'native base/quote/perpetual identity matched','funding schedule and settlement mark checked',
                            'decimal strings retained for amounts'],
                localBenchmark=dict(repetitions=3,runs=runs,medianElapsedMs=median(r['elapsedMs'] for r in runs),
                                    medianCpuMs=median(r['cpuMs'] for r in runs),networkRequests=0,
                                    interpretation='same saved dataset on this machine; small warm-cache sample, not a production SLA'),
                observedAnomalies=[],customerPaid=False,revenueReceived=None,fullDeliveryCostUsd=None,verifiedNetUsd=None,
                limitations=['The audit found no anomaly within this supported capture format; this is not proof of all data correctness',
                             'Captured historical data, not a current executable market or live provider availability test',
                             'No source truth beyond supplied public responses or historical depth/fills certified',
                             'CPU time is measured; electricity, hosting, support, acquisition and collection costs are not priced',
                             'No customer, demand, conversion or recurring service profit established'])


def main():
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('input',type=Path); args=parser.parse_args()
    result=audit(args.input)
    result.update(generatedAtMs=int(time.time()*1000),engineSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest())
    payload=json.dumps(result,sort_keys=True,allow_nan=False).encode()
    folder=ROOT/'data/economic-samples'; folder.mkdir(parents=True,exist_ok=True)
    identifier=hashlib.sha256(payload).hexdigest()
    target=folder/(identifier+'.json')
    with target.open('xb') as stream: stream.write(payload)
    lines=['# MIR — historical data-quality sample','',
           '**Research demonstration. No customer payment or verified business profit.**','',
           'Built by WADJ Studio. LXR remains the internal onchain engine.','',
           f"Window: {utc(result['sourceWindow']['startMs'])} to {utc(result['sourceWindow']['endExclusiveMs'])} (exclusive).",'',
           '| Asset | Spot hours | Perpetual hours | Mark hours | Funding settlements with mark |',
           '|---|---:|---:|---:|---:|']
    for asset in result['assets']:
        lines.append(f"| {asset['asset']} | {asset['spotCandles']} | {asset['perpetualCandles']} | {asset['markCandles']} | {asset['fundingSettlements']} |")
    lines += ['',f"Public source collection: {result['sourceRequests']} requests; {result['sourceRawBytes']:,} raw bytes. No new network requests for this audit.",'',
              '## Checks performed','']+[f'- {item}' for item in result['validation']]
    lines += ['',f"Observed anomaly findings: {len(result['observedAnomalies'])}. Scope and limitations below still apply.",'',
              f"Three local repetitions: median {result['localBenchmark']['medianElapsedMs']} ms elapsed; median {result['localBenchmark']['medianCpuMs']} ms CPU. Small local sample; no production latency claim.",'',
              '## Limits and economic status','']+[f'- {item}' for item in result['limitations']]
    lines += ['',f"Input SHA-256: `{result['sourceSha256']}`.",f"Report SHA-256: `{identifier}`.",
              f"Engine SHA-256: `{result['engineSha256']}`.",'']
    markdown=folder/(identifier+'.md'); markdown.write_text('\n'.join(lines),encoding='utf-8')
    print(json.dumps({'report':str(target),'sample':str(markdown),'assets':result['assets'],
                      'localBenchmark':result['localBenchmark'],'customerPaid':False,'verifiedNetUsd':None}))


if __name__=='__main__': main()
