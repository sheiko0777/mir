import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {PUBLIC_RPC} from '../../packages/adapters/uniswap-v2.mjs';
import {validPin} from './fork-policy.mjs';
function canonical(value,depth=0){
  if(depth>16)throw new Error('Replay input nesting exceeds bound');
  if(Array.isArray(value))return value.map(v=>canonical(v,depth+1));
  if(value && typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(k=>[k,canonical(value[k],depth+1)]));
  return value;
}
const key=(method,params)=>JSON.stringify([method,canonical(params)]);
export async function openForkReplay(path,expectedSha256){
  if(!/^[a-f0-9]{64}$/.test(expectedSha256??''))throw new Error('Expected archive SHA-256 required');
  if((await stat(path)).size>16*1024*1024)throw new Error('Replay archive too large');
  const raw=await readFile(path);
  if(createHash('sha256').update(raw).digest('hex')!==expectedSha256)throw new Error('Replay archive integrity mismatch');
  const archive=JSON.parse(raw.toString('utf8'));
  if(archive.source!==PUBLIC_RPC || archive.sourceChainId!==1 || !Array.isArray(archive.sourceRequests) ||
      archive.sourceRequests.length>100 || !Number.isSafeInteger(archive.finishedAtMs) || archive.finishedAtMs<0 || archive.finishedAtMs>Date.now())
    throw new Error('Unsupported replay provenance');
  validPin(archive.block,Date.now(),true);
  validPin(archive.block,archive.finishedAtMs,true);
  const responses=new Map();
  for(const record of archive.sourceRequests){
    if(record.error || !Object.hasOwn(record,'response'))continue;
    if(!Number.isSafeInteger(record.requestedAtMs) || !Number.isSafeInteger(record.capturedAtMs) ||
        record.requestedAtMs<0 || record.requestedAtMs>record.capturedAtMs || record.capturedAtMs>archive.finishedAtMs)
      throw new Error('Invalid recorded capture time');
    if(typeof record.method!=='string' || !Array.isArray(record.params))throw new Error('Invalid recorded request');
    const id=key(record.method,record.params),value=JSON.stringify(canonical(record.response));
    if(responses.has(id) && responses.get(id)!==value)throw new Error('Conflicting recorded responses');
    responses.set(id,value);
  }
  return {block:structuredClone(archive.block),capturedAtMs:archive.finishedAtMs,sha256:expectedSha256,
    lookup(method,params){
      const value=responses.get(key(method,params));
      if(value===undefined)throw new Error('Read absent from recorded state; no network fallback');
      return JSON.parse(value);
    }};
}
