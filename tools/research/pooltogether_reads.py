"""Derive the bot's static read ABI from the already pinned official artifact. Offline only."""
import hashlib
import json
from pathlib import Path

from eth_abi import encode
from eth_utils import keccak

ROOT = Path(__file__).resolve().parents[2]
SHA = '6f264ba14cbe0fca4df45f7ebfd842d334d376e4afc9ef309510257c6f9f1293'
POOL = '0x45b2010d8a4f08b53c9fa7544c51dfd9733732cb'
CLAIMER = '0xcdce635b774de77cdf791647601dba64a75547ba'
FUNCTIONS = {
    'pool': ['getLastAwardedDrawId()', 'numberOfTiers()', 'getTierPrizeCount(uint8)',
             'isWinner(address,address,uint8,uint32)', 'wasClaimed(address,address,uint8,uint32)', 'prizeToken()'],
    'claimer': ['prizePool()', 'computeTotalFees(uint8,uint256)'],
}


def main():
    raw = (ROOT / f'data/paid-work-reference/{SHA}.abi.json').read_bytes()
    if hashlib.sha256(raw).hexdigest() != SHA:
        raise ValueError('Published ABI changed')
    contracts = json.loads(raw)['contracts']
    result = {'schemaVersion': 1, 'sourceSha256': SHA, 'chainId': 8453,
              'pool': POOL, 'claimer': CLAIMER, 'functions': {}}
    for role, signatures in FUNCTIONS.items():
        matches = [c for c in contracts if c.get('chainId') == 8453 and
                   (c.get('address', '').lower() == {'pool': POOL, 'claimer': CLAIMER}.get(role)
                    if role != 'vault' else c.get('type') == 'PrizeVault')]
        if not matches:
            raise ValueError(f'Published {role} ABI missing')
        for signature in signatures:
            found = [f for f in matches[0]['abi'] if f.get('type') == 'function' and
                     f['name'] + '(' + ','.join(i['type'] for i in f['inputs']) + ')' == signature]
            if len(found) != 1 or found[0]['stateMutability'] not in ('view', 'pure') or len(found[0]['outputs']) != 1:
                raise ValueError(f'Invalid read: {role} {signature}')
            entry = found[0]
            result['functions'][role + '.' + signature] = {
                'selector': '0x' + keccak(text=signature).hex()[:8],
                'inputs': [i['type'] for i in entry['inputs']], 'output': entry['outputs'][0]['type']}
    result['functions']['token.decimals()'] = {'selector': '0x' + keccak(text='decimals()').hex()[:8],
                                             'inputs': [], 'output': 'uint8'}
    # Independent standard ABI encoding vector, used by the JS codec tests.
    signature = 'isWinner(address,address,uint8,uint32)'
    values = ['0x1111111111111111111111111111111111111111',
              '0x2222222222222222222222222222222222222222', 3, 17]
    result['encodingVector'] = {'method': 'pool.' + signature, 'values': values,
        'data': result['functions']['pool.' + signature]['selector'] + encode(['address', 'address', 'uint8', 'uint32'], values).hex()}
    target = ROOT / 'packages/bots/pooltogether-reads.json'
    target.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'file': str(target), 'functions': len(result['functions']), 'sourceSha256': SHA}))


if __name__ == '__main__':
    main()
