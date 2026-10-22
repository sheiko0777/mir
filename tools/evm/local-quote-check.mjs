import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { amountOut } from '../../packages/lxr/index.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'tools/evm/anvil-resource.json'), 'utf8'));
const binary = join(root, 'tools/evm/.bin', manifest.version, 'anvil.exe');
const binaryHash = createHash('sha256').update(await readFile(binary)).digest('hex');
if (binaryHash !== manifest.executableSha256) throw new Error('Unreviewed Anvil binary');
const probe = createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
const port = probe.address().port; await new Promise(r => probe.close(r));
const child = spawn(binary, ['--silent', '--accounts', '0', '--host', '127.0.0.1', '--port', String(port),
  '--chain-id', '31337', '--no-mining'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
let failure, diagnostics = '', sequence = 0;
child.on('error', error => { failure = error; });
child.stderr.on('data', chunk => { diagnostics = (diagnostics + chunk).slice(-8000); });
const delay = ms => new Promise(r => setTimeout(r, ms));
const latencies = [], address = '0x0000000000000000000000000000000000001000';
// Original arithmetic fixture, NOT deployed Uniswap bytecode. Calldata: input, reserveIn, reserveOut.
// out=floor(input*997*reserveOut/(reserveIn*1000+input*997)), on the positive uint112 domain.
const fixture = '0x6000356103e5028060403502906020356103e80201900460005260206000f3';
async function rpc(method, params = []) {
  if (!['web3_clientVersion', 'eth_chainId', 'eth_accounts', 'eth_call'].includes(method)) throw new Error('Read-only local method required');
  const began = performance.now(), id = ++sequence;
  const response = await fetch(`http://127.0.0.1:${port}`, { method: 'POST', signal: AbortSignal.timeout(2000),
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  if (!response.ok) throw new Error('Local RPC failed');
  const body = await response.json();
  if (body.id !== id || body.error || body.result === undefined) throw new Error(`Invalid local result: ${JSON.stringify(body.error)}`);
  latencies.push(performance.now() - began); return body.result;
}
try {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    if (failure || child.exitCode !== null) throw failure ?? new Error(diagnostics || 'Anvil exited');
    try { ready = /anvil/i.test(await rpc('web3_clientVersion')); if (ready) break; } catch {}
    await delay(100);
  }
  if (!ready || await rpc('eth_chainId') !== '0x7a69' || (await rpc('eth_accounts')).length !== 0)
    throw new Error('Local zero-account chain readiness failed');
  const maximum = (1n << 112n) - 1n;
  const vectors = [[10000n, 1000000n, 1000000n], [1n, maximum, 1n], [maximum, maximum, maximum],
    [1000000n, 1000000000n, 1000n * 10n ** 18n]];
  for (let n = 1n; n <= 32n; n++) vectors.push([n * 1234567n, n * 987654321n, maximum / n]);
  const cases = [];
  for (const [input, a, b] of vectors) for (const [reserveIn, reserveOut] of [[a, b], [b, a]]) {
    const calldata = '0x' + [input, reserveIn, reserveOut].map(n => n.toString(16).padStart(64, '0')).join('');
    const actual = BigInt(await rpc('eth_call', [{ to: address, data: calldata }, 'latest', { [address]: { code: fixture } }]));
    const expected = amountOut(input, reserveIn, reserveOut, 30);
    if (actual !== expected) throw new Error(`Arithmetic mismatch: ${actual} != ${expected}`);
    cases.push({ input, reserveIn, reserveOut, output: actual });
  }
  latencies.sort((a, b) => a - b);
  const report = { schemaVersion: 1, mode: 'local-evm-arithmetic-fixture', anvilVersion: manifest.version,
    binarySha256: binaryHash, fixture, chainId: 31337, accounts: 0, transactionSubmissions: 0,
    externalRpcRequests: 0, cases, matched: cases.length, qualified: false, netUsd: null,
    latencyP50Ms: latencies[Math.ceil(latencies.length * .5) - 1], latencyP95Ms: latencies[Math.ceil(latencies.length * .95) - 1],
    limitations: ['Synthetic arithmetic fixture, not actual Uniswap contracts or a mainnet fork.',
      'No token transfer, sellability, taxes, gas economics, ordering or profitable strategy verified.'] };
  await mkdir(join(root, 'outputs/evm'), { recursive: true });
  await writeFile(join(root, 'outputs/evm/local-quote-check.json'), JSON.stringify(report, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2));
  console.log(JSON.stringify({ matched: cases.length, chainId: 31337, accounts: 0, transactionSubmissions: 0, externalRpcRequests: 0 }));
} finally {
  if (child.exitCode === null) {
    child.kill();
    await Promise.race([new Promise(r => child.once('exit', r)), delay(3000)]);
  }
}
