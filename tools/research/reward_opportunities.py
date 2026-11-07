"""One bounded, unauthenticated Merkl opportunity read; no claims or paid actions."""
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
URL = 'https://api.merkl.xyz/v4/opportunities?chainId=8453&page=1&items=2'


def main():
    folder = ROOT / 'data/reward-research'; folder.mkdir(parents=True,exist_ok=True)
    report = dict(schemaVersion=1,kind='public-reward-opportunity-capture',source=URL,
                  requestedAtMs=int(time.time()*1000),maxRequests=1,actualRequests=1,
                  qualified=False,revenueReceived=None,netUsd=None)
    try:
        with urllib.request.urlopen(URL,timeout=20) as response:
            raw = response.read(2*1024*1024+1); report['httpStatus']=response.status
        if len(raw)>2*1024*1024: raise ValueError('Response budget exceeded')
        sha = hashlib.sha256(raw).hexdigest(); (folder/(sha+'.raw.json')).write_bytes(raw)
        data = json.loads(raw)
        if not isinstance(data,list) or len(data)>2: raise ValueError('Unexpected list or pagination budget')
        report.update(status='captured',rawSha256=sha,opportunities=data,
                      limitations=['Advertised rewards are not MIR revenue or verified profit',
                                   'No independent reward entitlement, root or onchain payout verified',
                                   'Demand for an independent reconciliation service is unproven'])
    except urllib.error.HTTPError as error:
        report.update(status='unavailable',httpStatus=error.code,error=error.read(4096).decode('utf-8',errors='replace'))
    except Exception as error: report.update(status='unavailable',error=str(error))
    report['capturedAtMs']=int(time.time()*1000)
    payload = json.dumps(report,sort_keys=True,allow_nan=False).encode()
    target = folder/(hashlib.sha256(payload).hexdigest()+'.json')
    with target.open('xb') as stream: stream.write(payload)
    print(json.dumps({'file':str(target),'status':report['status'],'httpStatus':report.get('httpStatus'),
                      'error':report.get('error'),'opportunityKeys':[list(d) for d in report.get('opportunities',[])],
                      'revenueReceived':None,'netUsd':None}))


if __name__ == '__main__': main()
