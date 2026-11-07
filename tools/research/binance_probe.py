"""Bounded public Binance data capability probe; no authentication or trading endpoints."""
import hashlib
import json
from pathlib import Path
import time
import urllib.error
import urllib.request

ENDPOINTS = {
    'spot': 'https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=1h&limit=2',
    'perp': 'https://fapi.binance.com/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=2',
    'funding': 'https://fapi.binance.com/fapi/v1/fundingRate?symbol=BTCUSDT&limit=2',
}


def main():
    folder = Path(__file__).resolve().parents[2] / 'data/binance-probe'
    folder.mkdir(parents=True,exist_ok=True)
    records = []
    for name,url in ENDPOINTS.items():
        record = dict(name=name,url=url,requestedAtMs=int(time.time()*1000))
        try:
            with urllib.request.urlopen(url,timeout=20) as response:
                raw = response.read(1024*1024+1)
                record['httpStatus'] = response.status
            if len(raw) > 1024*1024:
                raise ValueError('Response budget exceeded')
            record.update(rawSha256=hashlib.sha256(raw).hexdigest(),response=json.loads(raw))
        except urllib.error.HTTPError as error:
            record.update(httpStatus=error.code,error=error.read(4096).decode('utf-8',errors='replace'))
        except Exception as error:
            record['error'] = str(error)
        record['capturedAtMs'] = int(time.time()*1000)
        records.append(record)
    payload = json.dumps({'kind':'binance-public-capability-probe','records':records},sort_keys=True).encode()
    target = folder / (hashlib.sha256(payload).hexdigest()+'.json')
    target.write_bytes(payload)
    print(json.dumps({'file':str(target),'records':records}))


if __name__ == '__main__': main()
