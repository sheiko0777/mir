import test from 'node:test';
import assert from 'node:assert/strict';
import { cachePinnedReads } from '../packages/adapters/pinned-cache.mjs';
const hash = `0x${'a'.repeat(64)}`;
const args = () => [{ to: `0x${'1'.repeat(40)}`, data: '0x313ce567' }, { blockHash: hash, requireCanonical: true }];
test('cache isolates hash, address and calldata while bypassing chain and header checks', async () => {
  let count = 0;
  const cache = cachePinnedReads(async () => { count++; return '0x12'; });
  await cache.rpc('eth_call', args());
  assert.equal(await cache.rpc('eth_call', args()), '0x12');
  for (const field of ['blockHash', 'to', 'data']) {
    const other = args();
    if (field === 'blockHash') other[1].blockHash = `0x${'b'.repeat(64)}`;
    if (field === 'to') other[0].to = `0x${'2'.repeat(40)}`;
    if (field === 'data') other[0].data = '0x0902f1ac';
    await cache.rpc('eth_call', other);
  }
  for (let n = 0; n < 2; n++) {
    await cache.rpc('eth_chainId');
    await cache.rpc('eth_getBlockByNumber', ['0x64', false]);
  }
  assert.equal(count, 8); assert.equal(cache.metrics().hits, 1);
  assert.equal(cache.metrics().bypasses, 4);
});
test('failed and malformed responses are retried and capacity never grows unbounded', async () => {
  let count = 0;
  const cache = cachePinnedReads(async () => {
    count++;
    if (count === 1) throw new Error('transport');
    return count === 2 ? { bad: true } : '0x12';
  }, { maxEntries: 1 });
  await assert.rejects(cache.rpc('eth_call', args()), /transport/);
  await cache.rpc('eth_call', args()); await cache.rpc('eth_call', args());
  await cache.rpc('eth_call', args());
  assert.equal(count, 3);
  const other = args(); other[0].data = '0x0902f1ac';
  await cache.rpc('eth_call', other); await cache.rpc('eth_call', other);
  assert.equal(count, 5); assert.equal(cache.metrics().entries, 1);
});
test('noncanonical, extended or unpinned calls cannot alias cached reads', async () => {
  let count = 0;
  const cache = cachePinnedReads(async () => { count++; return '0x12'; });
  await cache.rpc('eth_call', args());
  for (const modify of [p => { p[1].requireCanonical = false; },
    p => { p[0].from = p[0].to; }, p => { p[1] = 'latest'; }, p => { p.push({}); }]) {
    const p = args(); modify(p); await cache.rpc('eth_call', p);
  }
  assert.equal(count, 5); assert.equal(cache.metrics().hits, 0);
});
