import test from 'node:test';
import assert from 'node:assert/strict';
import { fixturePools } from '../packages/adapters/fixture.mjs';
import { compareMarkets } from '../packages/lxr/research.mjs';
import { PaperLedger } from '../packages/paper/index.mjs';

const nowMs = 100_000;
const hash = `0x${'a'.repeat(64)}`;
function snapshot() {
  return { blockNumber: 100, blockHash: hash, capturedAtMs: nowMs,
    pools: fixturePools(nowMs).map((p, i) => ({ ...p, blockHash: hash, venue: ['uniswap-v2', 'sushiswap-v2'][i],
      baseDecimals: 18, quoteDecimals: 6, finality: 'finalized', tokenChecksPassed: null })) };
}
test('positive gross spread never becomes a net profit or qualified paper fill', () => {
  const report = compareMarkets(snapshot(), 1_000_000_000n, nowMs);
  assert.equal(report.routes.length, 2);
  const positive = report.routes.find(r => r.grossAfterPoolFeesQuote > 0n);
  assert.ok(positive);
  assert.equal(positive.netQuote, null);
  assert.equal(positive.status, 'unqualified');
  assert.ok(positive.reasons.includes('TOKEN_CHECKS_UNKNOWN_OR_FAILED'));
  assert.ok(positive.reasons.includes('GAS_VALUATION_UNAVAILABLE'));
  assert.equal(report.qualifiedOpportunities, 0);
  assert.throws(() => new PaperLedger(9_000_000_000n).record('live', positive));
  assert.ok(report.routes.some(r => r.reasons.includes('NO_GROSS_SPREAD')));
});
test('mixed block hashes and decimal mismatches prevent research comparisons', () => {
  const mixed = snapshot();
  mixed.pools[1].blockHash = `0x${'b'.repeat(64)}`;
  assert.throws(() => compareMarkets(mixed, 1n, nowMs), /Mixed block/);
  const decimals = snapshot();
  decimals.pools[1].quoteDecimals = 18;
  assert.throws(() => compareMarkets(decimals, 1n, nowMs), /decimals/);
});
test('aged snapshots remain visibly rejected; incomplete venue coverage has no routes', () => {
  const stale = compareMarkets(snapshot(), 1_000_000_000n, nowMs + 1_800_001);
  assert.ok(stale.routes.every(r => r.reasons.includes('STALE_OR_FUTURE_SNAPSHOT')));
  const missing = snapshot();
  missing.pools.pop();
  missing.excluded = [{ venue: 'sushiswap-v2', reason: 'PAIR_NOT_FOUND' }];
  const result = compareMarkets(missing, 1n, nowMs);
  assert.equal(result.routes.length, 0);
  assert.deepEqual(result.exclusions, missing.excluded);
});
