import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { createServer as netServer } from 'node:net';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { amountOut } from '../../packages/lxr/index.mjs';
import { FACTORY, PUBLIC_RPC } from '../../packages/adapters/uniswap-v2.mjs';
import { watchlist } from '../../config/watchlist.mjs';
import { validateForkRead, validPin } from './fork-policy.mjs';
import { openForkReplay } from './fork-replay.mjs';

const root = fileURLToPath(new URL('../../',import.meta.url));
const {values}=parseArgs({options:{block:{type:'string'},replay:{type:'string'},sha256:{type:'string'}}});
if(values.replay && values.block)throw new Error('Select replay or a live fixed block');
const replay=values.replay?await openForkReplay(values.replay,values.sha256):null;
if(values.block!==undefined && (!/^(?:0x[0-9a-f]+|[1-9][0-9]*)$/i.test(values.block) ||
    BigInt(values.block)>BigInt(Number.MAX_SAFE_INTEGER)))throw new Error('Use a numeric fixed block');
const requestedBlock=replay?.block.number??(values.block===undefined?null:'0x'+BigInt(values.block).toString(16));
const router = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
const zero = '0x'+'0'.repeat(40), [usdc,weth] = watchlist.tokens;
const addresses = new Set([FACTORY,router,usdc,weth,zero]);
const word = n => n.toString(16).padStart(64,'0');
const addressWord = a => a.slice(2).padStart(64,'0');
const digest = data => createHash('sha256').update(data).digest('hex');
const decode = data => {
  if (typeof data !== 'string' || !/^0x(?:[a-f0-9]{64})+$/i.test(data)) throw new Error('Invalid ABI result');
  return data.slice(2).match(/.{64}/g).map(w=>BigInt('0x'+w));
};
const decodeAddress = data => {
  const values=decode(data); if(values.length!==1 || values[0]<=0n || values[0]>=1n<<160n) throw new Error('Invalid address result');
  return '0x'+values[0].toString(16).padStart(40,'0');
};
const report = {schemaVersion:1,mode:replay?'archived-rpc-replay-view-quotes':requestedBlock?'historical-mainnet-fork-view-quotes':'pinned-mainnet-fork-view-quotes',startedAtMs:Date.now(),
  requestedBlock:requestedBlock??'finalized',historical:requestedBlock!==null,
  externalRpcRequests:0,sourceCaptureTimeMs:replay?.capturedAtMs??null,sourceEvidenceSha256:replay?.sha256??null,
  canonicalCheck:replay?'recorded-at-original-capture':'live-before-and-after',
  source:PUBLIC_RPC,sourceChainId:1,localChainId:31337,router,factory:FACTORY,
  cases:[],sourceRequests:[],qualified:false,netUsd:null,gasCostUsd:null,transactionSubmissions:0,
  limitations:['Read-only Router02 view quotes, not swaps or actual fills.',
    'No token tax, sellability, transfer behavior or full-swap gas evaluation.',
    'One public state provider; canonical hash rechecked, independent proof validation not established.',
    'Token balances, storage and code are not overridden or funded.']};
let pin, sequence=0, child, proxy, failure, diagnostics='', localId=0, sourceBytes=0, nextAdmissionMs=0;
async function source(method, params=[]) {
  validateForkRead(method,params,pin,addresses,{bootstrapBlock:requestedBlock??'finalized'});
  if(report.sourceRequests.length>=100 || Date.now()-report.startedAtMs>180000) throw new Error('Source request/time budget exhausted');
  const queuedAtMs=Date.now(),admittedAtMs=Math.max(queuedAtMs,nextAdmissionMs);nextAdmissionMs=admittedAtMs+250;
  const record={method,params,queuedAtMs,requestedAtMs:null}; report.sourceRequests.push(record);
  try {
    await new Promise(resolve=>setTimeout(resolve,Math.max(0,admittedAtMs-Date.now())));
    if(Date.now()-report.startedAtMs>180000)throw new Error('Source request/time budget exhausted');
    record.requestedAtMs=Date.now();
    if(replay){
      const result=replay.lookup(method,params),size=Buffer.byteLength(JSON.stringify(result));
      sourceBytes+=size;record.responseBytes=size;
      if(size>2*1024*1024 || sourceBytes>8*1024*1024)throw new Error('Recorded response budget exhausted');
      record.response=result;record.responseOrigin='captured-archive';return result;
    }
    const id=++sequence;
    report.externalRpcRequests++;
    const response=await fetch(PUBLIC_RPC,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),
      headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
    record.httpStatus=response.status;
    if(!response.ok){
      const reader=response.body?.getReader();if(reader){const first=await reader.read();record.sourceErrorExcerpt=Buffer.from(first.value??[]).toString('utf8').slice(0,1024);await reader.cancel();}
      throw new Error(`Source HTTP ${response.status}`);
    }
    const chunks=[];let size=0;
    for await(const chunk of response.body){size+=chunk.length;if(size>2*1024*1024)throw new Error('Source response exceeds budget');chunks.push(chunk);}
    sourceBytes+=size;record.responseBytes=size;
    if(sourceBytes>8*1024*1024)throw new Error('Total source response budget exhausted');
    const body=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if(body.id!==id || body.jsonrpc!=='2.0' || body.error || !Object.hasOwn(body,'result')) throw new Error('Source RPC error or invalid envelope');
    record.response=body.result;return body.result;
  } catch(error){record.error=error.message;throw error;}
  finally{record.capturedAtMs=Date.now();}
}
const listen = server => new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});
const delay = ms => new Promise(r=>setTimeout(r,ms));
let localPort;
async function local(method,params=[]) {
  if(!['web3_clientVersion','eth_chainId','eth_accounts','eth_getBlockByNumber','eth_getCode','eth_call'].includes(method)) throw new Error('Local view method only');
  const id=++localId;
  const response=await fetch(`http://127.0.0.1:${localPort}`,{method:'POST',signal:AbortSignal.timeout(15000),
    headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});
  const body=await response.json();if(!response.ok || body.id!==id || body.error || body.result===undefined){report.localFailure={method,error:body.error??null};throw new Error('Local fork call failed');}return body.result;
}
try {
  const manifest=JSON.parse(await readFile(join(root,'tools/evm/anvil-resource.json'),'utf8'));
  const binary=join(root,'tools/evm/.bin',manifest.version,'anvil.exe');
  if(digest(await readFile(binary))!==manifest.executableSha256)throw new Error('Unreviewed Anvil binary');
  report.anvilVersion=manifest.version;
  if(await source('eth_chainId')!=='0x1')throw new Error('Source chain mismatch');
  pin=validPin(await source('eth_getBlockByNumber',[requestedBlock??'finalized',false]),Date.now(),requestedBlock!==null);report.block=pin;
  if(!/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(pin.baseFeePerGas))throw new Error('Pinned base fee missing');
  report.localGasPriceSettingWei=BigInt(pin.baseFeePerGas).toString();
  report.limitations.push('Local gas price set to pinned base fee only; priority fee and full swap gas cost remain unknown.');
  const read=(to,data)=>source('eth_call',[{to,data},pin.number]);
  const pair=decodeAddress(await read(FACTORY,'0xe6a43905'+addressWord(usdc)+addressWord(weth)));
  addresses.add(pair);report.pair=pair;
  if(decodeAddress(await read(pair,'0xc45a0155'))!==FACTORY ||
     decodeAddress(await read(pair,'0x0dfe1681'))!==usdc || decodeAddress(await read(pair,'0xd21220a7'))!==weth ||
     decodeAddress(await read(router,'0xc45a0155'))!==FACTORY || decodeAddress(await read(router,'0xad5c4648'))!==weth)
    throw new Error('Factory/router/token identity mismatch');
  const reserveData=await read(pair,'0x0902f1ac'),reserves=decode(reserveData);
  if(reserves.length!==3 || reserves[0]<=0n || reserves[1]<=0n || reserves.slice(0,2).some(n=>n>=(1n<<112n)) || reserves[2]>=(1n<<32n))throw new Error('Invalid reserves');
  report.reserves=reserves.map(String);
  proxy=httpServer(async(request,response)=>{
    let body,id=null;
    try {
      if(request.method!=='POST' || request.url!=='/')throw new Error('RPC POST only');
      const chunks=[];let size=0;
      for await(const chunk of request){size+=chunk.length;if(size>64000)throw new Error('Request exceeds budget');chunks.push(chunk);}
      body=JSON.parse(Buffer.concat(chunks).toString('utf8'));id=body.id;
      if(!body || Array.isArray(body) || body.jsonrpc!=='2.0')throw new Error('Individual RPC envelope required');
      const result=await source(body.method,body.params??[]);
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify({jsonrpc:'2.0',id,result}));
    }catch(error){report.proxyRejections??=[];report.proxyRejections.push({method:body?.method??null,params:body?.params??null,reason:error.message});
      response.setHeader('Content-Type','application/json');response.end(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32600,message:'Source read rejected or unavailable'}}));}
  });
  const proxyPort=await listen(proxy);
  const probe=netServer();localPort=await listen(probe);await new Promise(r=>probe.close(r));
  child=spawn(binary,['--silent','--accounts','0','--host','127.0.0.1','--port',String(localPort),'--chain-id','31337',
    '--gas-price',report.localGasPriceSettingWei,
    '--no-mining','--no-storage-caching','--no-fork-node-info','--fork-url',`http://127.0.0.1:${proxyPort}`,
    '--fork-block-number',String(BigInt(pin.number))],{windowsHide:true,stdio:['ignore','ignore','pipe']});
  child.on('error',e=>{failure=e;});child.stderr.on('data',c=>{diagnostics=(diagnostics+c).slice(-6000);});
  let ready=false;
  for(let i=0;i<100 && Date.now()-report.startedAtMs<180000;i++){
    if(failure || child.exitCode!==null)throw failure??new Error('Fork initialization failed');
    try{ready=/anvil/i.test(await local('web3_clientVersion'));if(ready)break;}catch{}
    await delay(100);
  }
  if(!ready || await local('eth_chainId')!=='0x7a69' || (await local('eth_accounts')).length)throw new Error('Local fork identity/account mismatch');
  if((await local('eth_getBlockByNumber',[pin.number,false]))?.hash!==pin.hash)throw new Error('Fork block hash mismatch');
  report.codeHashes={};report.codeHashAlgorithm='SHA-256';
  for(const address of [router,FACTORY,pair]){
    const remote=await source('eth_getCode',[address,pin.number]),forked=await local('eth_getCode',[address,'latest']);
    if(!/^0x[0-9a-f]+$/i.test(remote) || remote==='0x' || remote!==forked)throw new Error('Fork runtime code mismatch');
    report.codeHashes[address]=digest(Buffer.from(remote.slice(2),'hex'));
  }
  if(await local('eth_call',[{to:pair,data:'0x0902f1ac'},'latest'])!==reserveData)throw new Error('Fork reserves mismatch');
  for(const [tokenIn,tokenOut,reserveIn,reserveOut,inputs] of [
    [usdc,weth,reserves[0],reserves[1],[1000000n,500000000n,5000000000n,50000000000n]],
    [weth,usdc,reserves[1],reserves[0],[10n**14n,10n**16n,10n**17n,10n**18n]]]){
    for(const input of inputs){
      const data='0xd06ca61f'+word(input)+word(64n)+word(2n)+addressWord(tokenIn)+addressWord(tokenOut);
      const raw=await local('eth_call',[{to:router,data},'latest']),values=decode(raw);
      if(values.length!==4 || values[0]!==32n || values[1]!==2n || values[2]!==input || values[3]!==amountOut(input,reserveIn,reserveOut,30))throw new Error('Router quote differs from LXR');
      report.cases.push({tokenIn,tokenOut,input:input.toString(),output:values[3].toString(),matched:true});
    }
  }
  if((await source('eth_getBlockByNumber',[pin.number,false]))?.hash!==pin.hash)throw new Error('Canonical source block changed');
  report.status='matched-view-quotes';report.matched=report.cases.length;
}catch(error){report.status='unavailable-or-rejected';report.reason=error.message;report.diagnostics=diagnostics;process.exitCode=1;}
finally{
  if(child?.exitCode===null){child.kill();await Promise.race([new Promise(r=>child.once('exit',r)),delay(3000)]);}
  if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}
  report.finishedAtMs=Date.now();
  report.sourceResponseBytes=sourceBytes;
  await mkdir(join(root,'data/evm/fork-checks'),{recursive:true});await mkdir(join(root,'outputs/evm'),{recursive:true});
  const text=JSON.stringify(report,null,2),archive=join(root,'data/evm/fork-checks',`${report.startedAtMs}.json`);
  await writeFile(archive,text,{flag:'wx'});await writeFile(join(root,'outputs/evm/fork-quote-check.json'),text);
  console.log(JSON.stringify({status:report.status,reason:report.reason,matched:report.matched??0,sourceRequests:report.sourceRequests.length,archive,qualified:false,netUsd:null}));
}
