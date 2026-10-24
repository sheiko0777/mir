import test from 'node:test';
import assert from 'node:assert/strict';
import { validateForkRead, validPin } from '../tools/evm/fork-policy.mjs';
const target='0x'+'1'.repeat(40),pin={number:'0x123',hash:'0x'+'a'.repeat(64)},addresses=new Set([target]);
test('Fork source allows pinned reads and rejects transactions, resets, changed targets and state overrides',()=>{
  for(const [method,params] of [['eth_chainId',[]],['eth_getCode',[target,pin.number]],
    ['eth_getStorageAt',[target,'0x0',pin.number]],['eth_getBlockByNumber',[pin.number,true]],
    ['eth_getBalance',[target,{blockHash:pin.hash}]],
    ['eth_call',[{to:target,data:'0x0902f1ac'},pin.number]]])
    assert.doesNotThrow(()=>validateForkRead(method,params,pin,addresses));
  for(const [method,params] of [['eth_sendRawTransaction',['0x1234']],['anvil_reset',[]],
    ['eth_getStorageAt',[target,'0x0','latest']],['eth_getBalance',['0x'+'2'.repeat(40),pin.number]],
    ['eth_call',[{to:target,data:'0x0902f1ac',from:target},pin.number]],
    ['eth_call',[{to:target,data:'0x095ea7b3'},pin.number]],
    ['eth_call',[{to:target,data:'0x0902f1ac'},pin.number,{}]],
    ['eth_getBlockByNumber',['latest',true]],
    ['eth_getBalance',[target,{blockHash:'0x'+'b'.repeat(64)}]],
    ['eth_getBalance',[target,{blockHash:pin.hash,requireCanonical:false}]]])
    assert.throws(()=>validateForkRead(method,params,pin,addresses));
});
test('Fork source requires a fresh finalized header and a pin before state reads',()=>{
  assert.doesNotThrow(()=>validateForkRead('eth_getBlockByNumber',['finalized',false],null,addresses));
  assert.throws(()=>validateForkRead('eth_getCode',[target,'latest'],null,addresses));
  const header={...pin,timestamp:'0x64'};
  assert.equal(validPin(header,110000),header);
  assert.throws(()=>validPin(header,1000));assert.throws(()=>validPin(header,2000000));
  assert.equal(validPin(header,2000000,true),header);
  assert.throws(()=>validPin(header,1000,true));
  assert.doesNotThrow(()=>validateForkRead('eth_getBlockByNumber',[pin.number,false],null,addresses,{bootstrapBlock:pin.number}));
  assert.throws(()=>validateForkRead('eth_getBlockByNumber',['latest',false],null,addresses,{bootstrapBlock:'latest'}));
});
