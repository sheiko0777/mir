import test from 'node:test';
import assert from 'node:assert/strict';
import { measureRpc } from '../packages/adapters/rpc-metrics.mjs';

test('RPC timing retains failures and nearest-rank tail latency without payloads', async () => {
  let time = 0, index = 0;
  const original = new Error('transport failed');
  const { rpc, metrics } = measureRpc(async value => {
    time += [10, 20, 300][index++];
    if (index === 3) throw original;
    return value;
  }, { clock: () => time });
  assert.equal(await rpc('private-input'), 'private-input');
  await rpc('second');
  await assert.rejects(rpc('third'), error => error === original);
  const result = metrics();
  assert.equal(result.admitted, 3); assert.equal(result.succeeded, 2); assert.equal(result.failed, 1);
  assert.equal(result.p50Ms, 20); assert.equal(result.p95Ms, 300);
  assert.equal(result.completedCallMs, 330); assert.equal(result.inFlight, 0);
  assert.equal(result.networkAttempts, null); assert.equal(result.eventToCaptureMs, null);
  assert.ok(!JSON.stringify(result).includes('private-input'));
});
test('budgets prevent transport calls and report no fabricated empty quantiles', async () => {
  let time = 0, calls = 0;
  const measured = measureRpc(async () => { calls++; }, { maxCalls: 1, maxElapsedMs: 10, clock: () => time });
  assert.equal(measured.metrics().p50Ms, null);
  await measured.rpc();
  await assert.rejects(measured.rpc(), /budget/);
  assert.equal(calls, 1); assert.equal(measured.metrics().budgetRejected, 1);
  const expired = measureRpc(async () => { calls++; }, { maxElapsedMs: 10, clock: () => time });
  time = 10;
  await assert.rejects(expired.rpc(), /budget/);
  assert.equal(expired.metrics().admitted, 0); assert.equal(calls, 1);
});
test('in-flight requests remain visible and may finish after the admission deadline', async () => {
  let time = 0, finish;
  const measured = measureRpc(() => new Promise(resolve => { finish = resolve; }),
    { maxElapsedMs: 10, clock: () => time });
  const pending = measured.rpc();
  assert.equal(measured.metrics().inFlight, 1);
  time = 20;
  await assert.rejects(measured.rpc(), /budget/);
  finish(42);
  assert.equal(await pending, 42);
  assert.equal(measured.metrics().maxMs, 20);
  assert.equal(measured.metrics().inFlight, 0);
});
