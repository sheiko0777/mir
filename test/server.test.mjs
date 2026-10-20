import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { normalizeDiscovery, loadDiscovery } from '../apps/server/reports.mjs';
import { createMirServer } from '../apps/server/server.mjs';

const weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const token = `0x${'1'.repeat(40)}`;
const pool = `0x${'2'.repeat(40)}`;
const hash = `0x${'a'.repeat(64)}`;
function report() {
  return { schemaVersion: 1, engine: 'LXR', mode: 'read-only-new-pools', finality: 'finalized',
    blockNumber: 100, blockHash: hash, capturedAtMs: 100_000, qualifiedOpportunities: 999,
    discoveries: [{ pool, venue: 'uniswap-v2', tokens: [token, weth], analysis: {
      spotGapBps: '124', reasons: ['TOKEN_AGE_UNKNOWN'], prices: [{ pool, venue: 'uniswap-v2',
        quoteToken: weth, quoteReserve: '12400000000000000000' }] } }], followUps: [] };
}
async function fixture(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mir-report-test-'));
  t.after(async () => {
    const base = path.resolve(tmpdir());
    if (path.dirname(path.resolve(dir)) !== base || !path.basename(dir).startsWith('mir-report-test-')) throw new Error('Unsafe cleanup target');
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
test('normalization distinguishes stale, recent capture and future time; never qualifies a route', () => {
  const current = normalizeDiscovery(report(), 100_001);
  assert.equal(current.freshness, 'recent-capture');
  assert.equal(current.observedAtMs, null);
  assert.equal(current.observations[0].quoteReserve, '12400000000000000000');
  assert.equal(current.observations[0].netQuote, null);
  assert.equal(current.observations[0].qualified, false);
  assert.equal(current.qualifiedOpportunities, 0);
  assert.equal(normalizeDiscovery(report(), 2_000_001).freshness, 'stale');
  assert.equal(normalizeDiscovery(report(), 0).freshness, 'invalid-time');
});
test('malformed provenance, amounts and mismatched quote identity are rejected', () => {
  for (const mutate of [
    r => r.mode = 'mock-sample', r => r.blockHash = 'invalid',
    r => r.discoveries[0].analysis.prices[0].quoteReserve = 'NaN',
    r => r.discoveries[0].analysis.prices[0].venue = 'unverified-venue',
    r => r.discoveries[0].tokens = [token, `0x${'3'.repeat(40)}`]
  ]) { const value = report(); mutate(value); assert.throws(() => normalizeDiscovery(value, 100_001)); }
});
test('zero funded follow-up markets retain their token pair without inventing a pool', () => {
  const value = report(); value.discoveries = []; value.followUps = [{ tokens: [token, weth], analysis: { prices: [], reasons: ['NO_FUNDED_POOL'] } }];
  const result = normalizeDiscovery(value, 100_001);
  assert.equal(result.observations.length, 0);
  assert.equal(result.unpricedPairs.length, 1);
});
test('loader uses only the committed report and handles missing data without sample fallback', async t => {
  const dir = await fixture(t);
  const empty = await loadDiscovery(dir, 100_001);
  assert.equal(empty.available, false); assert.equal(empty.dataset, 'saved-onchain');
  await writeFile(path.join(dir, '100-100000-1.json'), JSON.stringify(report()));
  await writeFile(path.join(dir, 'checkpoint.json'), JSON.stringify({ state: { chainId: 1, blockNumber: 100, blockHash: hash }, lastReport: '100-100000-1.json' }));
  assert.equal((await loadDiscovery(dir, 100_001)).observations.length, 1);
  await writeFile(path.join(dir, 'checkpoint.json'), JSON.stringify({ state: { chainId: 1 }, lastReport: '../package.json' }));
  await assert.rejects(loadDiscovery(dir), /checkpoint/);
});
test('HTTP API is read-only, does not expose project files and fails closed on corrupt reports', async t => {
  const dir = await fixture(t);
  const server = createMirServer({ dataDirectory: dir, now: () => 100_001 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/api/discovery')).status, 200);
  assert.equal((await fetch(base + '/api/discovery', { method: 'POST' })).status, 405);
  assert.equal((await fetch(base + '/package.json')).status, 404);
  assert.equal((await fetch(base + '/data/discovery/checkpoint.json')).status, 404);
  assert.equal((await fetch(base + '/brand/11-source/serve.cjs')).status, 404);
  assert.equal((await fetch(base + '/brand/01-logos/mir/mir-symbol-dark.svg')).status, 200);
  await writeFile(path.join(dir, 'checkpoint.json'), '{');
  const failed = await fetch(base + '/api/discovery');
  assert.equal(failed.status, 503);
  const value = await failed.json();
  assert.deepEqual(value.observations, []);
  assert.ok(value.error.includes('No sample data substituted'));
});
