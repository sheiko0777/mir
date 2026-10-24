import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {openForkReplay} from '../tools/evm/fork-replay.mjs';
import {PUBLIC_RPC} from '../packages/adapters/uniswap-v2.mjs';
const hash=raw=>createHash('sha256').update(raw).digest('hex');
test('Recorded fork state requires a digest and rejects conflicts, changes and absent reads',async()=>{
  const root=await mkdtemp(join(tmpdir(),'mir-replay-'));
  const data={source:PUBLIC_RPC,sourceChainId:1,finishedAtMs:110000,
    block:{number:'0x123',hash:'0x'+'a'.repeat(64),timestamp:'0x64'},
    sourceRequests:[{method:'eth_chainId',params:[],response:'0x1',requestedAtMs:100000,capturedAtMs:100010},
      {method:'eth_getCode',params:['0x'+'1'.repeat(40),{blockHash:'0x'+'a'.repeat(64),requireCanonical:true}],response:'0x1234',requestedAtMs:100000,capturedAtMs:100010}]};
  const file=join(root,'state.json');
  try{
    const raw=JSON.stringify(data);await writeFile(file,raw);
    const replay=await openForkReplay(file,hash(raw));
    assert.equal(replay.lookup('eth_chainId',[]),'0x1');
    assert.equal(replay.lookup('eth_getCode',['0x'+'1'.repeat(40),{requireCanonical:true,blockHash:'0x'+'a'.repeat(64)}]),'0x1234');
    assert.throws(()=>replay.lookup('eth_getBalance',[]));
    await assert.rejects(openForkReplay(file,'b'.repeat(64)));
    data.sourceRequests.push({method:'eth_chainId',params:[],response:'0x2',requestedAtMs:100000,capturedAtMs:100010});
    const conflict=JSON.stringify(data);await writeFile(file,conflict);
    await assert.rejects(openForkReplay(file,hash(conflict)),/Conflicting/);
    data.sourceRequests.pop();data.sourceRequests[0].capturedAtMs=99999;
    const badTime=JSON.stringify(data);await writeFile(file,badTime);
    await assert.rejects(openForkReplay(file,hash(badTime)),/capture time/);
  }finally{await rm(root,{recursive:true,force:true});}
});
