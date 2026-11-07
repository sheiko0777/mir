"""One bounded public candleSnapshot request; preserve raw response and closed-hour context."""
import hashlib
import json
from pathlib import Path
import time
import urllib.request
from kronos_adapter import validate_context

ROOT = Path(__file__).resolve().parents[2]


def main():
    interval = 3600000
    began = int(time.time()*1000)
    end = began // interval * interval
    request_body = {'type':'candleSnapshot','req':{'coin':'BTC','interval':'1h','startTime':end-512*interval,'endTime':end-1}}
    request = urllib.request.Request('https://api.hyperliquid.xyz/info', data=json.dumps(request_body).encode(),
                                     headers={'Content-Type':'application/json'}, method='POST')
    with urllib.request.urlopen(request, timeout=30) as response:
        raw = response.read(2*1024*1024+1)
    if len(raw) > 2*1024*1024:
        raise ValueError('Candle response exceeds budget')
    captured = int(time.time()*1000)
    folder = ROOT / 'data/bots/kronos-context'
    folder.mkdir(parents=True,exist_ok=True)
    raw_sha = hashlib.sha256(raw).hexdigest()
    raw_file = folder / f'{raw_sha}.raw.json'
    raw_file.write_bytes(raw)
    candles = json.loads(raw)
    if not isinstance(candles,list) or len(candles) != 512:
        raise ValueError('Missing or excessive candles')
    rows = []
    for candle in candles:
        if candle.get('s') != 'BTC' or candle.get('i') != '1h' or candle.get('T') != candle['t'] + interval - 1:
            raise ValueError('Candle identity or duration mismatch')
        rows.append(dict(timeMs=candle['t'],open=candle['o'],high=candle['h'],low=candle['l'],close=candle['c'],volume=candle['v']))
    document = dict(schemaVersion=1,kind='ohlcv-context',market='hyperliquid:perp:BTC',intervalMs=interval,
                    asOfMs=end,rows=rows,requestedAtMs=began,capturedAtMs=captured,
                    rawSha256=raw_sha,source='https://api.hyperliquid.xyz/info',request=request_body,
                    priceUnit='perpetual-contract-price; not a USD collateral valuation')
    validate_context(document,captured)
    payload = json.dumps(document,sort_keys=True).encode()
    target = folder / (hashlib.sha256(payload).hexdigest()+'.json')
    target.write_bytes(payload)
    print(json.dumps({'file':str(target),'rows':len(rows),'asOfMs':end,'capturedAtMs':captured}))


if __name__ == '__main__':
    main()
