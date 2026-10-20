import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadRpc, discoverSnapshots, collectWatchlist, VENUES, FACTORY } from '../packages/adapters/uniswap-v2.mjs';

const hash = `0x${'a'.repeat(64)}`;
const pool = `0x${'1'.repeat(40)}`;
const token0 = `0x${'2'.repeat(40)}`;
const token1 = `0x${'3'.repeat(40)}`;
const encode = (...numbers) => `0x${numbers.map(n => BigInt(n).toString(16).padStart(64, '0')).join('')}`;
const header = { hash, number: '0x64', timestamp: '0x3e8' };

function mockRpc(overrides = {}) {
  const calls = [];
  const rpc = async (method, params = []) => {
    calls.push({ method, params });
    if (overrides.handler) {
      const custom = overrides.handler(method, params);
      if (custom !== undefined) return custom;
    }
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getBlockByNumber') return header;
    const [{ to, data }] = params;
    const selector = data.slice(0, 10);
    return ({
      '0x574f2ba3': encode(1), '0x1e3dd18b': encode(pool), '0xc45a0155': encode(FACTORY),
      '0x0dfe1681': encode(token0), '0xd21220a7': encode(token1), '0xe6a43905': encode(pool),
      '0x0902f1ac': encode(10n ** 18n, 2000n * 10n ** 6n, 900),
      '0x313ce567': encode(to === token0 ? 18 : 6)
    })[selector];
  };
  return { rpc, calls };
}
const options = { count: 1, nowMs: 1_010_000 };

test('selected pair uses two verified factories at one hash, without enumerating unrelated pools', async () => {
  const sushiPool = `0x${'4'.repeat(40)}`;
  const { rpc, calls } = mockRpc({ handler: (method, params) => {
    if (method !== 'eth_call') return;
    const { to, data } = params[0];
    if (data.startsWith('0xe6a43905')) return encode(to === FACTORY ? pool : sushiPool);
    if (data === '0xc45a0155') return encode(to === pool ? FACTORY : VENUES['sushiswap-v2']);
  } });
  const result = await collectWatchlist(rpc, { tokens: [token0, token1], nowMs: options.nowMs });
  assert.equal(result.pools.length, 2);
  assert.equal(result.pools[1].address, sushiPool);
  assert.equal(result.pools[1].venue, 'sushiswap-v2');
  assert.equal(calls.filter(c => c.method === 'eth_getBlockByNumber' && c.params[0] === 'finalized').length, 1);
  assert.equal(calls.some(c => c.method === 'eth_call' && c.params[0].data.startsWith('0x1e3dd18b')), false);
  assert.ok(calls.filter(c => c.method === 'eth_call').every(c => c.params[1].blockHash === hash));
});
test('selected tokens must match returned pool and missing pairs are explicit', async () => {
  await assert.rejects(collectWatchlist(mockRpc().rpc, { tokens: [token0, `0x${'5'.repeat(40)}`], nowMs: options.nowMs }), /Selected token mismatch/);
  const { rpc } = mockRpc({ handler: (m, p) => m === 'eth_call' && p[0].data.startsWith('0xe6a43905') ? encode(0) : undefined });
  const result = await collectWatchlist(rpc, { tokens: [token0, token1], nowMs: options.nowMs });
  assert.equal(result.pools.length, 0);
  assert.equal(result.excluded.length, 2);
  await assert.rejects(collectWatchlist(mockRpc({ handler: m => m === 'eth_getBlockByNumber' ? null : undefined }).rpc,
    { tokens: [token0, token1], nowMs: options.nowMs }), /Finalized/);
});
test('research retains the base fee at the same pinned block and rejects malformed header fees', async () => {
  const sushiPool = `0x${'4'.repeat(40)}`;
  const { rpc } = mockRpc({ handler: (m, p) => {
    if (m === 'eth_getBlockByNumber') return { ...header, baseFeePerGas: '0x3b9aca00' };
    if (m !== 'eth_call') return;
    const { to, data } = p[0];
    if (data.startsWith('0xe6a43905')) return encode(to === FACTORY ? pool : sushiPool);
    if (data === '0xc45a0155') return encode(to === pool ? FACTORY : VENUES['sushiswap-v2']);
  } });
  const result = await collectWatchlist(rpc, { tokens: [token0, token1], nowMs: options.nowMs });
  assert.deepEqual(result.gas, { blockNumber: 100, blockHash: hash, baseFeePerGasWei: 1000000000n, source: 'pinned-rpc-header' });
  assert.equal(result.chainId, 1);
  assert.equal(result.observedAtMs, 1000000);
  const bad = mockRpc({ handler: m => m === 'eth_getBlockByNumber' ? { ...header, baseFeePerGas: '0x00' } : undefined });
  await assert.rejects(collectWatchlist(bad.rpc, { tokens: [token0, token1], nowMs: options.nowMs }), /base fee/);
});

test('discovery pins all reads to one canonical hash and normalizes atomic units', async () => {
  const { rpc, calls } = mockRpc();
  const result = await discoverSnapshots(rpc, options);
  assert.equal(result.pools[0].baseReserve, 10n ** 18n);
  assert.equal(result.pools[0].quoteDecimals, 6);
  assert.equal(result.pools[0].observedAtMs, 1_000_000);
  assert.equal(result.pools[0].tokenChecksPassed, null);
  for (const call of calls.filter(c => c.method === 'eth_call')) {
    assert.deepEqual(call.params[1], { blockHash: hash, requireCanonical: true });
  }
});
test('wrong network, stale head and changed canonical hash reject entire collection', async () => {
  await assert.rejects(discoverSnapshots(mockRpc({ handler: m => m === 'eth_chainId' ? '0x89' : undefined }).rpc, options), /mainnet/);
  await assert.rejects(discoverSnapshots(mockRpc().rpc, { ...options, nowMs: 9_000_000 }), /stale/);
  const changed = mockRpc({ handler: (m, p) => m === 'eth_getBlockByNumber' && p[0] === '0x64' ? { ...header, hash: `0x${'b'.repeat(64)}` } : undefined });
  await assert.rejects(discoverSnapshots(changed.rpc, options), /Canonical/);
});
test('factory mismatch, malformed reserves, and invalid decimals are rejected', async () => {
  for (const [selector, answer] of [
    ['0xc45a0155', encode(token0)], ['0x0902f1ac', '0x01'],
    ['0x0902f1ac', encode(2n ** 112n, 2, 1)], ['0x313ce567', encode(256)],
    ['0xe6a43905', encode(token0)]
  ]) {
    const { rpc } = mockRpc({ handler: (m, p) => m === 'eth_call' && p[0].data.slice(0, 10) === selector ? answer : undefined });
    await assert.rejects(discoverSnapshots(rpc, options));
  }
});
test('empty pools are excluded and discovery bounds are enforced', async () => {
  const { rpc } = mockRpc({ handler: (m, p) => m === 'eth_call' && p[0].data === '0x0902f1ac' ? encode(0, 0, 0) : undefined });
  const result = await discoverSnapshots(rpc, options);
  assert.equal(result.pools.length, 0);
  assert.equal(result.excluded[0].reason, 'EMPTY_RESERVES');
  await assert.rejects(discoverSnapshots(rpc, { ...options, count: 11 }));
});
test('RPC transport prohibits sending transactions and unpinned or write-selector calls', async () => {
  let requests = 0;
  const rpc = createReadRpc({ pause: async () => {}, fetchImpl: async () => { requests++; } });
  await assert.rejects(rpc('eth_sendRawTransaction', ['0x00']), /allowlisted/);
  await assert.rejects(rpc('eth_call', [{ to: pool, data: '0x0902f1ac' }, 'latest']), /pinned/);
  await assert.rejects(rpc('eth_call', [{ to: pool, data: '0x095ea7b3' }, { blockHash: hash, requireCanonical: true }]), /allowlisted/);
  assert.equal(requests, 0);
  assert.throws(() => createReadRpc({ url: 'https://example.org/?key=hidden' }), /credentials/);
});
test('RPC retries transient failures with a bound and validates response IDs', async () => {
  let requests = 0;
  const rpc = createReadRpc({ pause: async () => {}, fetchImpl: async (_url, init) => {
    requests++;
    const request = JSON.parse(init.body);
    return requests < 3 ? { status: 429, ok: false } :
      { ok: true, json: async () => ({ jsonrpc: '2.0', id: request.id, result: '0x1' }) };
  } });
  assert.equal(await rpc('eth_chainId'), '0x1');
  assert.equal(requests, 3);
  const bad = createReadRpc({ pause: async () => {}, fetchImpl: async () => ({ ok: true,
    json: async () => ({ jsonrpc: '2.0', id: -1, result: '0x1' }) }) });
  await assert.rejects(bad('eth_chainId'), /validation/);
});
