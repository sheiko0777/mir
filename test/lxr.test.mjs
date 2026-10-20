import test from 'node:test';
import assert from 'node:assert/strict';
import { amountOut, assessRoute } from '../packages/lxr/index.mjs';
import { fixturePools } from '../packages/adapters/fixture.mjs';
import { PaperLedger } from '../packages/paper/index.mjs';

const nowMs = 100_000;
const [buy, sell] = fixturePools(nowMs);
const costs = { gasQuote: 2_000_000n, bufferQuote: 1_000_000n };
const policy = { nowMs, maxAgeMs: 30_000, maxBlockLag: 0, maxInputBps: 100, minNetQuote: 1_000_000n };
const assess = (b = buy, s = sell, p = policy, c = costs) => assessRoute(b, s, 1_000_000_000n, c, p);

test('constant product output includes fee and floors in atomic units', () => {
  assert.equal(amountOut(100n, 1000n, 1000n, 30), 90n);
  assert.equal(amountOut(100n, 1000n, 1000n, 0), 90n);
  assert.equal(amountOut(1000n, 1000n, 1000n, 30), 499n);
  assert.throws(() => amountOut(1n, 0n, 1n, 30));
  assert.throws(() => amountOut(1n, 1n, 1n, 10000));
});
test('both directions are calculated and costs reconcile', () => {
  const result = assess();
  assert.equal(result.eligible, true);
  assert.equal(result.netQuote, result.quoteOut - result.input - costs.gasQuote - costs.bufferQuote);
  assert.equal(assess(sell, buy).eligible, false);
  assert.equal(assess(buy, sell, policy, { ...costs, gasQuote: 100_000_000n }).eligible, false);
});
test('stale, future, mismatched blocks and unknown token checks fail closed', () => {
  for (const [patch, reason] of [
    [{ observedAtMs: 0 }, 'STALE_OR_FUTURE_SNAPSHOT'],
    [{ observedAtMs: nowMs + 1 }, 'STALE_OR_FUTURE_SNAPSHOT'],
    [{ blockNumber: 99 }, 'BLOCK_MISMATCH'],
    [{ tokenChecksPassed: undefined }, 'TOKEN_CHECKS_UNKNOWN_OR_FAILED']
  ]) assert.ok(assess({ ...buy, ...patch }).reasons.includes(reason));
});
test('size cap and pair identity are enforced', () => {
  assert.ok(assess(buy, sell, { ...policy, maxInputBps: 1 }).reasons.includes('BUY_SIZE_LIMIT'));
  assert.throws(() => assess(buy, { ...sell, chainId: 2 }));
  assert.throws(() => assess(buy, buy));
  assert.throws(() => assess(buy, { ...sell, quoteToken: `0x${'c'.repeat(40)}` }));
  assert.throws(() => assess(buy, sell, { ...policy, maxAgeMs: NaN }));
});
test('paper ledger reconciles, rejects duplicates, rejected routes and overspending', () => {
  const result = assess();
  const ledger = new PaperLedger(10_000_000_000n);
  ledger.record('snapshot-1', result);
  assert.equal(ledger.balanceQuote, 10_000_000_000n + result.netQuote);
  assert.throws(() => ledger.record('snapshot-1', result));
  assert.throws(() => ledger.record('rejected', assess(sell, buy)));
  assert.throws(() => new PaperLedger(0n).record('poor', result));
  assert.throws(() => ledger.record('tampered', { ...result, netQuote: 100n }));
  const entries = ledger.entries;
  entries.pop();
  assert.equal(ledger.entries.length, 1);
});
