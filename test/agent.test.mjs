import test from 'node:test';
import assert from 'node:assert/strict';
import { planAgentCycle, emptyAgentState } from '../packages/agent/index.mjs';

const token = n => `0x${String(n).padStart(40, '0')}`;
const hash = `0x${'a'.repeat(64)}`;
const nowMs = 100000;
function view() {
  return { available: true, dataset: 'saved-onchain', blockNumber: 100, blockHash: hash,
    capturedAtMs: nowMs, finality: 'finalized', observations: [{
      chainId: 1, pool: token(3), tokens: [token(1), token(2)], blockNumber: 100,
      blockHash: hash, capturedAtMs: nowMs, spotGapBps: '200', reasons: ['TOKEN_AGE_UNKNOWN']
    }] };
}
test('agent prioritizes evidence for a gap without converting it into profit or a fill', () => {
  const result = planAgentCycle(view(), emptyAgentState(), { nowMs });
  assert.equal(result.report.decisions[0].priority, 3);
  assert.deepEqual(result.report.decisions[0].tasks, ['CHECK_TOKEN_BEHAVIOR', 'VALUE_GAS', 'REPLAY_SIZED_QUOTES']);
  assert.equal(result.report.decisions[0].netQuote, null);
  assert.equal(result.report.decisions[0].qualified, false);
  assert.equal(result.report.paperFills, 0);
  assert.equal(result.report.nextPollMs, 15000);
});
test('memory survives JSON persistence; repeated evidence produces no duplicate decision', () => {
  const first = planAgentCycle(view(), emptyAgentState(), { nowMs });
  const second = planAgentCycle(view(), JSON.parse(JSON.stringify(first.state)), { nowMs });
  assert.equal(second.report.decisions.length, 0);
  assert.equal(second.report.duplicateDecisions, 1);
  assert.equal(second.state.decisions, 1);
  assert.equal(second.state.cycles, 2);
  const changed = view(); changed.observations[0].spotGapBps = '20';
  assert.equal(planAgentCycle(changed, second.state, { nowMs }).report.decisions.length, 1);
});
test('missing and old observations block action; sample data is never accepted as on-chain', () => {
  assert.equal(planAgentCycle({ available: false }, emptyAgentState(), { nowMs }).report.status, 'waiting-for-data');
  assert.equal(planAgentCycle(view(), emptyAgentState(), { nowMs: nowMs + 1800001 }).report.status, 'blocked');
  assert.equal(planAgentCycle(view(), emptyAgentState(), { nowMs: nowMs - 1 }).report.status, 'blocked');
  const sample = view(); sample.dataset = 'mock-sample';
  assert.throws(() => planAgentCycle(sample, emptyAgentState(), { nowMs }), /observations/);
});
test('block regressions and same-height conflicting hashes do not replace trusted memory', () => {
  const first = planAgentCycle(view(), emptyAgentState(), { nowMs });
  for (const next of [{ ...view(), blockNumber: 99 }, { ...view(), blockHash: `0x${'b'.repeat(64)}` }]) {
    const result = planAgentCycle(next, first.state, { nowMs });
    assert.equal(result.report.status, 'blocked');
    assert.equal(result.state.lastBlockHash, hash);
    assert.equal(result.state.decisions, 1);
  }
});
test('mixed provenance, malformed amounts and corrupted memory fail closed', () => {
  for (const mutate of [v => v.observations[0].blockHash = `0x${'b'.repeat(64)}`,
    v => v.observations[0].tokens = [token(1), token(1)], v => v.observations[0].spotGapBps = 'NaN']) {
    const data = view(); mutate(data);
    assert.throws(() => planAgentCycle(data, emptyAgentState(), { nowMs }), /observation/);
  }
  assert.throws(() => planAgentCycle(view(), { ...emptyAgentState(), seen: ['corrupt'] }, { nowMs }), /memory/);
});
test('decision budget defers work and does not mark deferred pairs as already processed', () => {
  const data = view();
  data.observations.push({ ...data.observations[0], pool: token(6), tokens: [token(4), token(5)], spotGapBps: null });
  const first = planAgentCycle(data, emptyAgentState(), { nowMs, maxDecisions: 1 });
  assert.equal(first.report.decisions[0].priority, 3);
  assert.equal(first.report.deferredDecisions, 1);
  const second = planAgentCycle(data, first.state, { nowMs, maxDecisions: 1 });
  assert.equal(second.report.decisions.length, 1);
  assert.equal(second.report.decisions[0].priority, 1);
  assert.deepEqual(second.report.decisions[0].tasks, ['FIND_SECOND_VENUE']);
});
