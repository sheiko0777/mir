import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLAIM_REFERENCE, BASE_WETH, encodeClaimRead, decodeClaimRead, scanPoolTogether,
  replayClaimCapture, validateClaimWatchlist } from '../packages/bots/pooltogether.mjs';
import { illustrativeClaimSession } from '../packages/bots/pooltogether-fixture.mjs';
import { createClaimRpc } from '../packages/adapters/pooltogether-rpc.mjs';
import { saveClaimCapture, loadClaimBot } from '../apps/server/pooltogether.mjs';
import { createMirServer } from '../apps/server/server.mjs';

const word = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
async function removeTemp(directory) {
  assert.equal(join(tmpdir(), directory.split(/[\\/]/).at(-1)), directory);
  await rm(directory, { recursive: true, force: true });
}
async function fixture() {
  const session = illustrativeClaimSession();
  await scanPoolTogether(session.read, session.watchlist, session.capturedAtMs);
  return { schemaVersion: 1, kind: 'pooltogether-claim-capture', capturedAtMs: session.capturedAtMs,
    watchlist: session.watchlist, records: session.records, source: session.source };
}

test('static ABI matches independently generated eth-abi vector and enforces canonical widths', () => {
  const vector = CLAIM_REFERENCE.encodingVector;
  assert.equal(encodeClaimRead(vector.method, vector.values), vector.data);
  assert.throws(() => encodeClaimRead(vector.method, [...vector.values.slice(0, 2), 256, 0]));
  assert.throws(() => encodeClaimRead('claimPrizes', []));
  assert.throws(() => decodeClaimRead(vector.method, word(2)), /boolean/);
  assert.throws(() => decodeClaimRead('pool.numberOfTiers()', word(256)), /overflow/);
  assert.throws(() => decodeClaimRead('pool.prizeToken()', word(2n ** 160n)), /address/);
});

test('watcher distinguishes winner, already claimed and non-winner; fee is credit, never cash', async () => {
  const capture = await fixture(), report = await replayClaimCapture(capture, capture.capturedAtMs);
  assert.equal(report.coverage.seedsChecked, 3);
  assert.deepEqual(report.observations.map(o => o.reason), [null, 'ALREADY_CLAIMED', 'NOT_A_WINNER']);
  assert.equal(report.batches.length, 1);
  assert.equal(report.batches[0].quotedRewardAtomic, '100');
  assert.equal(report.batches[0].scenario.netAtomic, '70');
  assert.equal(report.batches[0].scenario.doubledCostNetAtomic, '40');
  assert.equal(report.batches[0].scenario.survivesDoubleCost, true);
  assert.equal(report.status, 'illustrative-only');
  assert.equal(report.qualified, false);
  assert.equal(report.actualReceiptsAtomic, null);
  assert.equal(report.verifiedNetAtomic, null);
  assert.ok(report.batches[0].reasons.includes('CLAIM_EXECUTION_NOT_SIMULATED'));
});

test('missing cost is unknown, a losing stress case is retained, and arithmetic exceeds safe Number range', async () => {
  const capture = await fixture();
  capture.watchlist.costs.l1Wei = null;
  let report = await replayClaimCapture(capture, capture.capturedAtMs);
  assert.equal(report.batches[0].scenario.netAtomic, null);
  assert.deepEqual(report.batches[0].scenario.missing, ['l1Wei']);
  capture.watchlist.costs.l1Wei = '40';
  report = await replayClaimCapture(capture, capture.capturedAtMs);
  assert.equal(report.batches[0].scenario.netAtomic, '32');
  assert.equal(report.batches[0].scenario.doubledCostNetAtomic, '-36');
  const rewardRow = capture.records.find(r => r.params?.[0]?.data?.startsWith(CLAIM_REFERENCE.functions['claimer.computeTotalFees(uint8,uint256)'].selector));
  rewardRow.result = word(900719925474099312345n);
  report = await replayClaimCapture(capture, capture.capturedAtMs);
  assert.equal(report.batches[0].scenario.netAtomic, '900719925474099312277');
});

test('empty watchlist never invents opportunities; duplicate and oversized input are rejected', async () => {
  const session = illustrativeClaimSession(); session.watchlist.seeds = [];
  const report = await scanPoolTogether(session.read, session.watchlist, session.capturedAtMs);
  assert.deepEqual(report.batches, []);
  const watch = illustrativeClaimSession().watchlist;
  watch.seeds.push({ ...watch.seeds[0] });
  assert.throws(() => validateClaimWatchlist(watch), /Duplicate/);
  watch.seeds = Array(17).fill(watch.seeds[0]);
  assert.throws(() => validateClaimWatchlist(watch), /watchlist/);
});

test('block age uses reception time during live capture and retains stale/future rejection evidence', async () => {
  const session = illustrativeClaimSession();
  const report = await scanPoolTogether(session.read, session.watchlist, () => session.capturedAtMs);
  assert.equal(report.capturedAtMs, session.capturedAtMs);
  for (const [timestamp, reason] of [['0x1', 'STALE_BLOCK_TIME'], ['0x100000', 'FUTURE_BLOCK_TIME']]) {
    const capture = await fixture();
    capture.records = capture.records.slice(0, 2);
    capture.records[1].result.timestamp = timestamp;
    const rejected = await replayClaimCapture(capture, capture.capturedAtMs);
    assert.equal(rejected.status, 'rejected-evidence'); assert.equal(rejected.reason, reason);
    assert.deepEqual(rejected.batches, []);
  }
});

test('wrong network, relationship, decimals and malformed booleans fail closed', async () => {
  for (const [select, result] of [
    [r => r.method === 'eth_chainId', '0x1'],
    [r => r.params?.[0]?.data === encodeClaimRead('claimer.prizePool()'), word(BASE_WETH)],
    [r => r.params?.[0]?.data === encodeClaimRead('token.decimals()'), word(6)],
    [r => r.params?.[0]?.data?.startsWith(CLAIM_REFERENCE.functions['pool.isWinner(address,address,uint8,uint32)'].selector), word(3)]
  ]) {
    const capture = await fixture(); capture.records.find(select).result = result;
    await assert.rejects(replayClaimCapture(capture, capture.capturedAtMs));
  }
});

test('changed block, reordered transcript, missing code and future captures are rejected', async () => {
  let capture = await fixture(); capture.records.at(-1).result.hash = `0x${'cd'.repeat(32)}`;
  await assert.rejects(replayClaimCapture(capture, capture.capturedAtMs), /Canonical/);
  capture = await fixture(); [capture.records[0], capture.records[1]] = [capture.records[1], capture.records[0]];
  await assert.rejects(replayClaimCapture(capture, capture.capturedAtMs), /transcript/);
  capture = await fixture(); capture.records.find(r => r.method === 'eth_getCode').result = '0x';
  await assert.rejects(replayClaimCapture(capture, capture.capturedAtMs), /code/);
  capture = await fixture();
  await assert.rejects(replayClaimCapture(capture, capture.capturedAtMs - 1), /capture/);
});

test('stale public evidence stays stale and cached qualification fields cannot change recomputed output', async () => {
  const capture = await fixture();
  capture.source = { kind: 'public-rpc', url: 'https://base-rpc.publicnode.com' };
  capture.qualified = true; capture.verifiedNetAtomic = '100000';
  const report = await replayClaimCapture(capture, capture.capturedAtMs + 121000);
  assert.equal(report.status, 'stale-evidence');
  assert.equal(report.qualified, false); assert.equal(report.verifiedNetAtomic, null);
});

test('terminal source failure is explicit; extra records cannot hide after a failure', async () => {
  const capture = await fixture();
  capture.records = [{ method: 'eth_chainId', params: [], error: 'Public RPC HTTP 403' }];
  const report = await replayClaimCapture(capture, capture.capturedAtMs);
  assert.equal(report.status, 'source-unavailable'); assert.deepEqual(report.batches, []);
  assert.deepEqual(report.failure, { method: 'eth_chainId', classification: 'Public RPC HTTP 403' });
  capture.records.push({ method: 'eth_chainId', params: [], result: '0x2105' });
  await assert.rejects(replayClaimCapture(capture, capture.capturedAtMs));
});

test('transport rejects writes, arbitrary selectors, unpinned reads and state overrides before networking', async () => {
  let calls = 0;
  const rpc = createClaimRpc({ fetchImpl: async () => { calls++; throw new Error('unexpected network'); } });
  const pin = { blockHash: `0x${'ab'.repeat(32)}`, requireCanonical: true };
  for (const [method, params] of [
    ['eth_sendRawTransaction', ['0x1234']], ['eth_estimateGas', [{}]],
    ['eth_call', [{ to: CLAIM_REFERENCE.pool, data: '0x12345678' }, pin]],
    ['eth_call', [{ to: CLAIM_REFERENCE.pool, data: encodeClaimRead('pool.prizeToken()') }, 'latest']],
    ['eth_call', [{ to: CLAIM_REFERENCE.pool, data: encodeClaimRead('pool.prizeToken()') }, pin, {}]],
    ['eth_getCode', [BASE_WETH, 'latest']]
  ]) await assert.rejects(rpc.read(method, params), /allowlisted/);
  assert.equal(calls, 0);
});

test('transport stops at first HTTP denial without retry and enforces request budget', async () => {
  let calls = 0;
  const denied = createClaimRpc({ fetchImpl: async () => { calls++; return new Response('', { status: 403 }); } });
  await assert.rejects(denied.read('eth_chainId', []), /403/);
  assert.equal(calls, 1); assert.equal(denied.records[0].error, 'Public RPC HTTP 403');
  const rpc = createClaimRpc({ fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: '0x2105' }));
  } });
  for (let i = 0; i < 128; i++) await rpc.read('eth_chainId', []);
  await assert.rejects(rpc.read('eth_chainId', []), /budget/);
  assert.equal(rpc.records.length, 128);
});

test('stored captures are verified; latest public failure is not replaced by illustrative success', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mir-claims-'));
  try {
    const capture = await fixture();
    const id = await saveClaimCapture(directory, capture);
    assert.equal((await loadClaimBot(directory, capture.capturedAtMs)).status, 'illustrative-only');
    const failed = structuredClone(capture);
    failed.source = { kind: 'public-rpc', url: 'https://base-rpc.publicnode.com' };
    failed.capturedAtMs++;
    failed.records = [{ method: 'eth_chainId', params: [], error: 'Public RPC HTTP 403' }];
    await saveClaimCapture(directory, failed);
    assert.equal((await loadClaimBot(directory, failed.capturedAtMs)).status, 'source-unavailable');
    const file = join(directory, id + '.json');
    await writeFile(file, (await readFile(file, 'utf8')) + ' ');
    await assert.rejects(loadClaimBot(directory, failed.capturedAtMs), /hash/);
  } finally { await removeTemp(directory); }
});

test('MIR serves recomputed bot evidence through read-only API and platform catalogue', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mir-claim-api-'));
  const claimDirectory = join(directory, 'claims');
  const capture = await fixture(); await saveClaimCapture(claimDirectory, capture);
  const server = createMirServer({ claimDirectory, labDirectory: join(directory, 'lab'),
    researchDirectory: join(directory, 'research'), now: () => capture.capturedAtMs });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const report = await (await fetch(base + '/api/bots/pooltogether')).json();
    assert.equal(report.status, 'illustrative-only');
    assert.equal((await fetch(base + '/api/bots/pooltogether', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/api/bots/pooltogether', { method: 'HEAD' })).status, 200);
    const catalogue = await (await fetch(base + '/api/bots')).json();
    assert.equal(catalogue.bots.find(b => b.id === 'pooltogether-claimer').worker.status, 'illustrative-only');
    await writeFile(join(claimDirectory, report.evidenceId + '.json'), '{}');
    const broken = await fetch(base + '/api/bots/pooltogether');
    assert.equal(broken.status, 503);
    assert.deepEqual((await broken.json()).batches, []);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await removeTemp(directory);
  }
});
