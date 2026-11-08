"""Generate source-reviewed Liquity read interfaces. No network or contract execution."""
import json
from pathlib import Path
from eth_utils import keccak

ROOT = Path(__file__).resolve().parents[2]
COMMIT = 'd262669ef3c4d37bf0544df3bb2624c07b8a5ee0'
result = {'schemaVersion': 1, 'chainId': 1,
          'registry': '0xf949982b91c8c61e952b3ba942cbbfaef5386684',
          'manager': '0x7bcb64b2c9206a5b699ed43363f6f98d4776cf5a',
          'collateral': '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2',
          'helper': '0xfa61db085510c64b83056db3a7acf3b6f631d235',
          'settings': '0x20f7c9ad66983f6523a0881d0f82406541417526',
          'sorted': '0xa25269e41bd072513849f2e64ad221e84f3063f4',
          'price': '0xcc5f8102eb670c89a4a3c567c13851260303c24f',
          'sourceCommit': COMMIT, 'sourceRepository': 'https://github.com/liquity/bold',
          'basis': 'reviewed Solidity public getters and published addresses; not compiled or bytecode-matched',
          'functions': {}}
for role, signature, output in [
    ('registry', 'getTroveManager(uint256)', 'address'), ('registry', 'getToken(uint256)', 'address'),
    ('manager', 'shutdownTime()', 'uint256'), ('manager', 'getTroveIdsCount()', 'uint256')]:
    result['functions'][role + '.' + signature] = {
        'selector': '0x' + keccak(text=signature).hex()[:8], 'inputs': ['uint256'] if '(uint256)' in signature else [], 'output': output, 'outputs': [output]}
combined = '(' + ','.join(['uint256'] * 12 + ['address'] + ['uint256'] * 3) + ')[]'
for role, signature, inputs, outputs in [
    ('helper', 'collateralRegistry()', [], ['address']),
    ('helper', 'getMultipleSortedTroves(uint256,int256,uint256)', ['uint256', 'int256', 'uint256'], [combined]),
    ('manager', 'sortedTroves()', [], ['address']), ('sorted', 'getSize()', [], ['uint256']),
    ('settings', 'troveManager()', [], ['address']), ('settings', 'collToken()', [], ['address']),
    ('settings', 'priceFeed()', [], ['address']), ('settings', 'MCR()', [], ['uint256']),
    ('price', 'priceSource()', [], ['uint8']), ('price', 'ethUsdOracle()', [], ['address', 'uint256', 'uint8']),
    ('oracle', 'latestRoundData()', [], ['uint80', 'int256', 'uint256', 'uint256', 'uint80']),
    ('oracle', 'decimals()', [], ['uint8'])]:
    result['functions'][role + '.' + signature] = {'selector': '0x' + keccak(text=signature).hex()[:8],
        'inputs': inputs, 'outputs': outputs, 'output': outputs[0] if len(outputs) == 1 else None}
target = ROOT / 'tools/research/liquity-read-reference.json'
target.write_text(json.dumps(result, indent=2) + '\n', encoding='utf-8')
print(json.dumps({'file': str(target), 'methods': len(result['functions']), 'sourceCommit': COMMIT}))
