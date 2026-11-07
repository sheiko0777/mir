import hashlib
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch
from urllib.parse import urlencode
from binance_history import HOUR, encode
from carry_candle_screen import provenance


def fixture(folder):
    now = int(time.time()*1000)-10000
    policy = {'assets':['BTC']}
    raw_policy = encode(policy); policy_file = folder/'policy.json'; policy_file.write_bytes(raw_policy)
    end = 90*24*HOUR
    document = dict(schemaVersion=1,kind='binance-paired-candle-history',status='captured',quoteUnit='USDT',
                    startMs=0,endExclusiveMs=end,intervalMs=HOUR,policy=policy,
                    policySha256=hashlib.sha256(raw_policy).hexdigest(),captureStartedAtMs=now,
                    capturedAtMs=now+1000,requests=[],assets={'BTC':{'identity':{},'spot':[],'perp':[],'mark':[],'funding':[]}})
    frozen = {k:v for k,v in document.items() if k not in ('assets','status','capturedAtMs','requests')}
    raw_plan = encode(frozen); sha = hashlib.sha256(raw_plan).hexdigest()
    (folder/(sha+'.plan.json')).write_bytes(raw_plan); document['frozenPlanSha256']=sha
    def record(host,path,params,response):
        raw = encode(response); sha = hashlib.sha256(raw).hexdigest()
        (folder/(sha+'.raw.json')).write_bytes(raw)
        document['requests'].append(dict(url='https://'+host+path+'?'+urlencode(params),httpStatus=200,
                                         requestedAtMs=now+1,capturedAtMs=now+2,rawSha256=sha))
    for leg,host,path in [('spot','api.binance.com','/api/v3/exchangeInfo'),('perp','fapi.binance.com','/fapi/v1/exchangeInfo')]:
        item = dict(symbol='BTCUSDT',baseAsset='BTC',quoteAsset='USDT',status='TRADING')
        document['assets']['BTC']['identity'][leg]=item
        record(host,path,{},dict(symbols=[item]))
    rows = [[i*HOUR,'100','101','99','100','0',(i+1)*HOUR-1,'0',0,'0','0','0'] for i in range(2160)]
    for kind,host,path,limit in [('spot','api.binance.com','/api/v3/klines',1000),
                                 ('perp','fapi.binance.com','/fapi/v1/klines',1500),
                                 ('mark','fapi.binance.com','/fapi/v1/markPriceKlines',1500)]:
        document['assets']['BTC'][kind]=json.loads(json.dumps(rows))
        for offset in range(0,len(rows),limit):
            record(host,path,dict(symbol='BTCUSDT',interval='1h',startTime=offset*HOUR,endTime=end-1,limit=limit),rows[offset:offset+limit])
    funding = [dict(symbol='BTCUSDT',fundingTime=i*HOUR,fundingRate='.001',markPrice='100') for i in range(0,2160,8)]
    document['assets']['BTC']['funding']=funding
    record('fapi.binance.com','/fapi/v1/fundingRate',dict(symbol='BTCUSDT',startTime=0,endTime=end-1,limit=1000),funding)
    document['requestCount']=len(document['requests'])
    return document,policy_file


class ProvenanceTests(unittest.TestCase):
    def test_bundle_is_reconstructed_from_raw_responses_and_changed_prices_rejected(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory); document,policy = fixture(folder)
            with patch('carry_candle_screen.POLICY',policy):
                self.assertEqual(provenance(document,folder),{'assets':['BTC']})
                document['assets']['BTC']['spot'][5][1]='999'
                with self.assertRaises(ValueError): provenance(document,folder)

    def test_corrupt_raw_response_rejected_even_when_bundle_unchanged(self):
        with TemporaryDirectory() as directory:
            folder = Path(directory); document,policy = fixture(folder)
            sha = document['requests'][2]['rawSha256']
            (folder/(sha+'.raw.json')).write_bytes(b'[]')
            with patch('carry_candle_screen.POLICY',policy):
                with self.assertRaises(ValueError): provenance(document,folder)

    def test_changed_frozen_cost_policy_or_period_rejected(self):
        for field,value in [('policy',{'assets':['ETH']}),('endExclusiveMs',91*24*HOUR)]:
            with TemporaryDirectory() as directory:
                folder = Path(directory); document,policy = fixture(folder)
                document[field]=value
                with patch('carry_candle_screen.POLICY',policy):
                    with self.assertRaises(ValueError): provenance(document,folder)


if __name__ == '__main__': unittest.main()
