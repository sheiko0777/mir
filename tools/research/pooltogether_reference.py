"""Pin official published Base ABI/config and print event topics using reviewed eth-utils."""
import hashlib
import argparse
import json
from pathlib import Path
import urllib.request

ROOT=Path(__file__).resolve().parents[2]
SIGNATURES = [
    'ClaimedPrize(address,address,address,uint24,uint8,uint32,uint152,uint96,address)',
    'IncreaseClaimRewards(address,uint256)',
    'WithdrawRewards(address,address,uint256,uint256)',
    'AllocateRewardFromReserve(address,uint256)',
    'ClaimError(address,uint8,address,uint32,bytes)',
    'Transfer(address,address,uint256)',
]
PUBLISHED = {'abi':'6f264ba14cbe0fca4df45f7ebfd842d334d376e4afc9ef309510257c6f9f1293',
             'config':'8b4bee822293d09677ed40e39bb15951706da0e754f8176b75f340e77329729b'}
POOL='0x45b2010d8a4f08b53c9fa7544c51dfd9733732cb'
CLAIMER='0xcdce635b774de77cdf791647601dba64a75547ba'
TOKEN='0x4200000000000000000000000000000000000006'


def capture():
    from eth_utils import keccak
    folder=ROOT/'data/paid-work-reference'; folder.mkdir(parents=True,exist_ok=True)
    sources=[]
    for name,url in [('abi','https://raw.githubusercontent.com/GenerationSoftware/pt-v5-mainnet/main/deployments/base/contracts.json'),
                     ('config','https://raw.githubusercontent.com/GenerationSoftware/pt-v5-mainnet/main/config/base.json')]:
        with urllib.request.urlopen(url,timeout=20) as response: raw=response.read(8*1024*1024+1)
        if len(raw)>8*1024*1024: raise ValueError('Published reference budget exceeded')
        value=json.loads(raw); sha=hashlib.sha256(raw).hexdigest()
        (folder/(sha+'.'+name+'.json')).write_bytes(raw)
        sources.append(dict(name=name,url=url,sha256=sha,bytes=len(raw),rootType=type(value).__name__,
                            rootKeys=list(value)[:12] if isinstance(value,dict) else None))
    print(json.dumps({'sources':sources,'topics':{s:'0x'+keccak(text=s).hex() for s in SIGNATURES}}))


def freeze():
    from eth_utils import keccak
    folder=ROOT/'data/paid-work-reference'
    sources={}
    for name,sha in PUBLISHED.items():
        raw=(folder/(sha+'.'+name+'.json')).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=sha: raise ValueError('Published artifact changed')
        sources[name]=json.loads(raw)
    if sources['config']['prize_pool']['prize_token'].lower()!=TOKEN: raise ValueError('Published asset changed')
    definitions=[]; deployments=[]
    for address,contract_type,names in [(POOL,'PrizePool',{'ClaimedPrize','IncreaseClaimRewards','WithdrawRewards','AllocateRewardFromReserve'}),
                                       (CLAIMER,'Claimer',{'ClaimError'})]:
        matches=[c for c in sources['abi']['contracts'] if c.get('chainId')==8453 and c.get('address','').lower()==address and c.get('type')==contract_type]
        if len(matches)!=1: raise ValueError('Published deployment mismatch')
        deployments.append(dict(address=address,type=contract_type,version=matches[0]['version']))
        selected=[event for event in matches[0]['abi'] if event.get('type')=='event' and event.get('name') in names]
        if len(selected)!=len(names): raise ValueError('Published event set mismatch')
        for event in selected:
            signature=event['name']+'('+','.join(field['type'] for field in event['inputs'])+')'
            if signature not in SIGNATURES or event.get('anonymous'): raise ValueError('Published ABI changed')
            definitions.append(dict(name=event['name'],address=address,signature=signature,topic='0x'+keccak(text=signature).hex(),
                                    inputs=[{k:f[k] for k in ('name','type','indexed')} for f in event['inputs']]))
    definitions.append(dict(name='Transfer',address=TOKEN,signature=SIGNATURES[-1],topic='0x'+keccak(text=SIGNATURES[-1]).hex(),
                            inputs=[dict(name='from',type='address',indexed=True),dict(name='to',type='address',indexed=True),dict(name='value',type='uint256',indexed=False)]))
    result=dict(schemaVersion=1,chainId=8453,pool=POOL,claimer=CLAIMER,prizeToken=TOKEN,
                publishedArtifactSha256=PUBLISHED,publishedDeployments=deployments,liveBytecodeVerified=False,liveTokenDecimalsVerified=False,
                sources=['https://github.com/GenerationSoftware/pt-v5-mainnet/blob/main/deployments/base/contracts.json',
                         'https://github.com/GenerationSoftware/pt-v5-mainnet/blob/main/config/base.json',
                         'https://github.com/GenerationSoftware/pt-v5-prize-pool/blob/main/src/PrizePool.sol'],events=definitions)
    target=ROOT/'tools/research/pooltogether-reference.json'
    target.write_text(json.dumps(result,indent=2),encoding='utf-8')
    print(json.dumps({'file':str(target),'events':len(definitions),'publishedArtifactsVerified':True,'liveBytecodeVerified':False}))


if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument('action',choices=['capture','freeze'],default='capture',nargs='?')
    {'capture':capture,'freeze':freeze}[parser.parse_args().action]()
