import test from 'node:test';
import assert from 'node:assert/strict';
import { CLAIM_REFERENCE, encodeClaimRead, scanPoolTogether, replayClaimCapture } from '../packages/bots/pooltogether.mjs';
import { illustrativeClaimSession } from '../packages/bots/pooltogether-fixture.mjs';
import { createClaimRpc } from '../packages/adapters/pooltogether-rpc.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { saveClaimCapture } from '../apps/server/pooltogether.mjs';
import { loadBots } from '../apps/server/bots.mjs';

const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
function guarded({ shutdown = false, expired = false, drawId = 7, wrongPool = false, wrongClaimer = false,
  closesAt = expired ? 1000 : 1100, awardedAt = drawId ? 900 : 0 } = {}) {
  const session = illustrativeClaimSession();
  session.watchlist.viabilityChecks = true; session.watchlist.vaultChecks = true;
  const extra = new Map();
  for (const [method, args, value] of [
    ['pool.getLastAwardedDrawId()', [], drawId], ['pool.isShutdown()', [], Number(shutdown)],
    ['pool.lastAwardedDrawAwardedAt()', [], awardedAt], ['pool.claimCount()', [], 42],
    ['pool.isDrawFinalized(uint24)', [drawId], Number(expired)],
    ['pool.drawClosesAt(uint24)', [drawId + 1], closesAt],
    ['vault.claimer()', [], wrongClaimer ? '0x' + '55'.repeat(20) : CLAIM_REFERENCE.claimer]
  ]) extra.set(encodeClaimRead(method, args), word(value));
  const originalRead = session.read;
  session.read = async (method, params) => {
    let result = method === 'eth_call' ? extra.get(params[0].data) : undefined;
    if (method === 'eth_call' && params[0].to === session.watchlist.seeds[0].vault &&
        params[0].data === encodeClaimRead('vault.prizePool()')) result = word(wrongPool ? '0x' + '66'.repeat(20) : CLAIM_REFERENCE.pool);
    if (result === undefined) return originalRead(method, params);
    session.records.push({ method, params: structuredClone(params), result }); return result;
  };
  return session;
}

test('open claim window and matching vault getters still cannot establish execution or income', async () => {
  const session = guarded();
  const report = await scanPoolTogether(session.read, session.watchlist, session.capturedAtMs);
  assert.equal(report.viability.status, 'claim-window-open');
  assert.equal(report.viability.remainingAtBlockMs, 100000);
  assert.equal(report.viability.claimCount, '42');
  assert.equal(report.vaultChecks.length, 1); assert.equal(report.vaultChecks[0].relationshipMatched, true);
  assert.equal(report.vaultChecks[0].hooksSimulated, false);
  assert.equal(report.batches.length, 1); assert.equal(report.qualified, false); assert.equal(report.verifiedNetAtomic, null);
  assert.ok(report.batches[0].reasons.includes('VAULT_BYTECODE_AND_HOOKS_UNVERIFIED'));
  const replay = await replayClaimCapture({ schemaVersion: 1, kind: 'pooltogether-claim-capture',
    capturedAtMs: session.capturedAtMs, watchlist: session.watchlist, records: session.records, source: session.source }, session.capturedAtMs);
  assert.deepEqual(replay.viability, report.viability); assert.deepEqual(replay.vaultChecks, report.vaultChecks);
});

test('expired, shutdown and unawarded pools suppress winner checks, quotes and discovery', async () => {
  for (const [options, status] of [[{ expired: true }, 'claim-window-expired'], [{ shutdown: true }, 'shutdown'], [{ drawId: 0 }, 'no-awarded-draw']]) {
    const session = guarded(options);
    session.watchlist.discovery = { kind: 'recent-claim-participants', lookbackBlocks: 128 };
    const report = await scanPoolTogether(session.read, session.watchlist, session.capturedAtMs);
    assert.equal(report.viability.status, status); assert.equal(report.viability.claimingAllowed, false);
    assert.deepEqual(report.batches, []); assert.equal(report.coverage.discoverySkippedReason, status);
    assert.ok(report.observations.every(o => o.status === 'rejected'));
    assert.equal(session.records.some(row => row.method === 'eth_getLogs'), false);
    assert.equal(session.records.some(row => row.params?.[0]?.data?.startsWith(CLAIM_REFERENCE.functions['pool.isWinner(address,address,uint8,uint32)'].selector)), false);
  }
});

test('inconsistent finality and future award time fail rather than fabricating an open window', async () => {
  for (const options of [{ expired: false, closesAt: 1000 }, { awardedAt: 1001 }]) {
    const session = guarded(options);
    await assert.rejects(scanPoolTogether(session.read, session.watchlist, session.capturedAtMs), /finality|timestamp/);
  }
});

test('a vault linked to a different pool or claimer never supplies a quoted candidate', async () => {
  for (const options of [{ wrongPool: true }, { wrongClaimer: true }]) {
    const session = guarded(options);
    const report = await scanPoolTogether(session.read, session.watchlist, session.capturedAtMs);
    assert.deepEqual(report.batches, []);
    assert.equal(report.vaultChecks[0].relationshipMatched, false);
    assert.ok(report.observations.every(o => o.reason === 'VAULT_RELATIONSHIP_MISMATCH'));
  }
});

test('arbitrary vault targets expose only two pinned address getters, never transaction selectors', async () => {
  let requests = 0;
  const rpc = createClaimRpc({ fetchImpl: async (url, options) => {
    requests++; const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: word(CLAIM_REFERENCE.claimer) }));
  } });
  const target = '0x' + '11'.repeat(20), pin = { blockHash: '0x' + 'ab'.repeat(32), requireCanonical: true };
  await rpc.read('eth_call', [{ to: target, data: encodeClaimRead('vault.claimer()') }, pin]);
  await assert.rejects(rpc.read('eth_call', [{ to: target, data: encodeClaimRead('pool.prizeToken()') }, pin]), /allowlisted/);
  await assert.rejects(rpc.read('eth_call', [{ to: target, data: encodeClaimRead('vault.claimer()'), value: '0x1' }, pin]), /allowlisted/);
  await assert.rejects(rpc.read('eth_sendRawTransaction', ['0x1234']), /allowlisted/);
  assert.equal(requests, 1);
});

test('real-source closed-window evidence changes the next task; fictional controls cannot redirect research', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mir-protocol-gate-'));
  try {
    const session = guarded({ expired: true });
    await scanPoolTogether(session.read, session.watchlist, session.capturedAtMs);
    const capture = { schemaVersion: 1, kind: 'pooltogether-claim-capture', watchlist: session.watchlist,
      records: session.records, source: session.source, capturedAtMs: session.capturedAtMs };
    const claimDirectory = join(root, 'claims');
    await saveClaimCapture(claimDirectory, capture);
    const options = { claimDirectory, researchDirectory: join(root, 'research'), labDirectory: join(root, 'lab'), nowMs: session.capturedAtMs };
    let plan = await loadBots(options);
    assert.equal(plan.bots[0].status, 'research-evidence-available');
    assert.equal(plan.tasks[0].kind, 'review-protocol-claims');
    capture.source = { kind: 'public-rpc', url: 'https://base-rpc.publicnode.com' };
    await saveClaimCapture(claimDirectory, capture);
    plan = await loadBots(options);
    assert.equal(plan.bots[0].status, 'protocol-ineligible');
    assert.equal(plan.tasks[0].kind, 'select-active-protocol');
    assert.equal(plan.tasks[0].id, (await loadBots({ ...options, nowMs: options.nowMs + 1 })).tasks[0].id);
    assert.equal(plan.qualifiedStrategies, 0); assert.equal(plan.executionEnabled, false);
  } finally {
    assert.equal(join(tmpdir(), root.split(/[\\/]/).at(-1)), root);
    await rm(root, { recursive: true, force: true });
  }
});
