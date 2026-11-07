"""Bounded, public-only paired-price and settlement-mark capture for a fixed 90-day research window."""
import hashlib
import json
from pathlib import Path
import time
import urllib.parse
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
POLICY = ROOT / 'tools/research/policies/carry-candle-v1.json'
HOUR = 3600000


def encode(value):
    return json.dumps(value,sort_keys=True,separators=(',',':'),allow_nan=False).encode()


class Capture:
    def __init__(self):
        self.folder = ROOT / 'data/binance-history'
        self.folder.mkdir(parents=True,exist_ok=True)
        self.calls, self.total, self.records = 0, 0, []
        self.began = time.monotonic()

    def get(self,host,path,params):
        allowed = {'api.binance.com':{'/api/v3/klines','/api/v3/exchangeInfo'},
                   'fapi.binance.com':{'/fapi/v1/klines','/fapi/v1/markPriceKlines','/fapi/v1/fundingRate','/fapi/v1/exchangeInfo'}}
        if path not in allowed.get(host,set()) or self.calls >= 32 or time.monotonic()-self.began > 180:
            raise ValueError('Public path or request admission budget exceeded')
        url = 'https://'+host+path+'?'+urllib.parse.urlencode(params)
        record = dict(url=url,requestedAtMs=int(time.time()*1000))
        self.calls += 1
        try:
            with urllib.request.urlopen(url,timeout=20) as response:
                raw = response.read(8*1024*1024+1)
                record['httpStatus'] = response.status
            self.total += len(raw)
            if len(raw)>8*1024*1024 or self.total>32*1024*1024:
                raise ValueError('Storage budget exceeded')
            sha = hashlib.sha256(raw).hexdigest()
            (self.folder / (sha+'.raw.json')).write_bytes(raw)
            record.update(rawSha256=sha,bytes=len(raw))
            return json.loads(raw)
        except urllib.error.HTTPError as error:
            record.update(httpStatus=error.code,error=error.read(4096).decode('utf-8',errors='replace'))
            raise
        except Exception as error:
            record['error'] = str(error)
            raise
        finally:
            record['capturedAtMs'] = int(time.time()*1000)
            self.records.append(record)

    def candles(self,symbol,kind,start,end):
        host = 'api.binance.com' if kind=='spot' else 'fapi.binance.com'
        path = '/api/v3/klines' if kind=='spot' else '/fapi/v1/markPriceKlines' if kind=='mark' else '/fapi/v1/klines'
        limit = 1000 if kind=='spot' else 1500
        rows, cursor = [], start
        while cursor < end:
            page = self.get(host,path,dict(symbol=symbol,interval='1h',startTime=cursor,endTime=end-1,limit=limit))
            if not isinstance(page,list) or not page or any(not isinstance(row,list) or len(row)!=12 or type(row[0]) is not int for row in page):
                raise ValueError('Malformed or missing candle page')
            for row in page:
                if row[0]!=cursor or row[6]!=cursor+HOUR-1 or row[0]>=end:
                    raise ValueError('Duplicate, gapped, wrong-unit or unfinished candles')
                rows.append(row)
                cursor += HOUR
        if len(rows)!=2160:
            raise ValueError('Incomplete 90-day hourly coverage')
        return rows


def main():
    capture = Capture()
    policy_raw = POLICY.read_bytes()
    policy = json.loads(policy_raw)
    end = int(time.time()*1000)//(24*HOUR)*(24*HOUR)
    start = end-90*24*HOUR
    document = dict(schemaVersion=1,kind='binance-paired-candle-history',quoteUnit='USDT',
                    startMs=start,endExclusiveMs=end,intervalMs=HOUR,assets={},
                    policySha256=hashlib.sha256(policy_raw).hexdigest(),policy=policy,
                    captureStartedAtMs=int(time.time()*1000),qualified=False,netUsd=None)
    # Freeze protocol, costs, dates and assets before observing any history.
    frozen = {key:value for key,value in document.items() if key!='assets'}
    frozen_raw = encode(frozen)
    plan = capture.folder / (hashlib.sha256(frozen_raw).hexdigest()+'.plan.json')
    with plan.open('xb') as stream: stream.write(frozen_raw)
    document['frozenPlanSha256'] = hashlib.sha256(frozen_raw).hexdigest()
    try:
        spot_meta = capture.get('api.binance.com','/api/v3/exchangeInfo',{'symbols':json.dumps([a+'USDT' for a in policy['assets']],separators=(',',':'))})
        perp_meta = capture.get('fapi.binance.com','/fapi/v1/exchangeInfo',{})
        for asset in policy['assets']:
            symbol = asset+'USDT'
            identity = {}
            for leg,meta in [('spot',spot_meta),('perp',perp_meta)]:
                found = [row for row in meta['symbols'] if row.get('symbol')==symbol]
                if len(found)!=1:
                    raise ValueError('Ambiguous native symbol identity')
                item = found[0]
                if item.get('baseAsset')!=asset or item.get('quoteAsset')!='USDT' or item.get('status')!='TRADING' or \
                        leg=='perp' and (item.get('contractType')!='PERPETUAL' or item.get('marginAsset')!='USDT'):
                    raise ValueError('Native spot/perpetual identity mismatch')
                identity[leg] = item
            data = dict(identity=identity)
            for kind in ('spot','perp','mark'):
                data[kind] = capture.candles(symbol,kind,start,end)
            funding = capture.get('fapi.binance.com','/fapi/v1/fundingRate',dict(symbol=symbol,startTime=start,endTime=end-1,limit=1000))
            if not isinstance(funding,list) or not 2<=len(funding)<1000:
                raise ValueError('Funding coverage missing or truncated')
            data['funding'] = funding
            document['assets'][asset] = data
        document['status'] = 'captured'
    except Exception as error:
        document.update(status='unavailable-or-incomplete',error=str(error))
    document.update(requests=capture.records,capturedAtMs=int(time.time()*1000),requestCount=capture.calls,rawBytes=capture.total)
    raw = encode(document)
    target = capture.folder / (hashlib.sha256(raw).hexdigest()+'.json')
    with target.open('xb') as stream: stream.write(raw)
    print(json.dumps({'file':str(target),'status':document['status'],'error':document.get('error'),
                      'assets':list(document['assets']),'requests':capture.calls,'rawBytes':capture.total,
                      'policySha256':document['policySha256'],'plan':str(plan)}))


if __name__ == '__main__': main()
