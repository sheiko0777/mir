"""One anonymous read from an independent public Base explorer. Never handles payment/auth."""
import hashlib
import argparse
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
URL = 'https://base.blockscout.com/api/v2/addresses/0x45b2010d8a4f08b53c9fa7544c51dfd9733732cb/logs'


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source',choices=['blockscout','base-rpc'],default='blockscout')
    source=parser.parse_args().source
    url=URL if source=='blockscout' else 'https://mainnet.base.org'
    folder = ROOT / 'data/paid-work-probe'; folder.mkdir(parents=True,exist_ok=True)
    result = dict(schemaVersion=1,kind='public-protocol-work-probe',source=url,chainId=8453,
                  requestedAtMs=int(time.time()*1000),requests=1,qualified=False,mirRevenueReceived=None)
    try:
        request=urllib.request.Request(url) if source=='blockscout' else urllib.request.Request(url,
            data=json.dumps(dict(jsonrpc='2.0',id=1,method='eth_chainId',params=[])).encode(),headers={'Content-Type':'application/json'},method='POST')
        with urllib.request.urlopen(request,timeout=20) as response:
            raw=response.read(2*1024*1024+1); result['httpStatus']=response.status
        if len(raw)>2*1024*1024: raise ValueError('Response exceeds budget')
        data=json.loads(raw)
        if source=='blockscout':
            if not isinstance(data,dict) or not isinstance(data.get('items'),list) or len(data['items'])>100:
                raise ValueError('Unexpected public log response')
        elif data.get('id')!=1 or data.get('error') or data.get('result')!='0x2105': raise ValueError('Wrong chain or RPC failure')
        sha=hashlib.sha256(raw).hexdigest(); (folder/(sha+'.raw.json')).write_bytes(raw)
        result.update(status='captured-partial-page' if source=='blockscout' else 'public-chain-id-confirmed',rawSha256=sha,
                      itemCount=len(data.get('items',[])),firstItemKeys=list(data['items'][0]) if data.get('items') else [],
                      hasNextPage=data.get('next_page_params') is not None,completeWindow=False,netAtomic=None)
    except urllib.error.HTTPError as error:
        result.update(status='unavailable',httpStatus=error.code,error=error.read(4096).decode('utf-8',errors='replace'))
    except Exception as error: result.update(status='unavailable',error=str(error))
    result['capturedAtMs']=int(time.time()*1000)
    payload=json.dumps(result,sort_keys=True,allow_nan=False).encode()
    target=folder/(hashlib.sha256(payload).hexdigest()+'.json')
    with target.open('xb') as stream: stream.write(payload)
    print(json.dumps({'file':str(target),**{k:v for k,v in result.items() if k!='error'},
                      'errorSummary':'HTTP access denied; saved bounded response body' if result.get('httpStatus') in (401,403) else result.get('error')}))


if __name__=='__main__': main()
