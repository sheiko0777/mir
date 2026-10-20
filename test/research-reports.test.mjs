import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { normalizeResearch, loadResearch, saveResearch } from '../apps/server/research.mjs';
import { createMirServer } from '../apps/server/server.mjs';
import { planAgentCycle, emptyAgentState } from '../packages/agent/index.mjs';
import { VENUES } from '../packages/adapters/uniswap-v2.mjs';

// Invented test reserves/header only. No RPC, wallet or production data is used.
const hash = `0x${'a'.repeat(64)}`, nowMs = 100000;
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const weth = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
function archive(time = nowMs) {
  return { snapshot: { schemaVersion: 1, chainId: 1, mode: 'read-only', blockNumber: 100,
    blockHash: hash, capturedAtMs: time, observedAtMs: time,
    gas: { blockNumber: 100, blockHash: hash, source: 'pinned-rpc-header', baseFeePerGasWei: '1000000000' },
    pools: Object.entries(VENUES).map(([venue, factory], i) => ({ chainId: 1, venue, factory,
      source: `ethereum-${venue}-rpc`, address: `0x${String(i + 1).repeat(40)}`,
      baseToken: usdc, quoteToken: weth, baseDecimals: 6, quoteDecimals: 18,
      baseReserve: '1000000000000', quoteReserve: String(BigInt(1000 + i * 30) * 10n ** 18n),
      blockNumber: 100, blockHash: hash, observedAtMs: time, capturedAtMs: time,
      model: 'constant-product', feeBps: 30, finality: 'finalized', tokenChecksPassed: true })) },
    sizingInputs: { schemaVersion: 1, inputsQuote: ['100000000000000000', '1000000000000000000'],
      gasUnits: '300000', priorityFeeWei: '1000000000', bufferBps: 50, baseFeeFactorBps: 10000,
      budgetQuote: null, minNetQuote: '0' },
    sizedReport: { bestScenario: { scenarioNetQuote: '999999999999999999999999', qualified: true } } };
}
async function temporary(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mir-research-test-'));
  t.after(async () => {
    if (path.dirname(path.resolve(dir)) !== path.resolve(tmpdir()) || !path.basename(dir).startsWith('mir-research-test-')) throw new Error('Unsafe cleanup');
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}
test('saved winners and token safety flags are not trusted; research is recomputed in exact units', () => {
  const normalized = normalizeResearch(archive(), nowMs);
  assert.equal(normalized.dataset, 'saved-research');
  assert.equal(normalized.analysis.candidates.length, 4);
  assert.notEqual(normalized.sizing.bestScenarioNetQuote, '999999999999999999999999');
  assert.ok(normalized.analysis.candidates.every(c => c.netQuote === null && c.qualified === false &&
    c.reasons.includes('TOKEN_CHECKS_UNKNOWN_OR_FAILED')));
  assert.equal(normalized.analysis.netProfitKnown, false);
});
test('missing assumptions stay unknown; stale and future captures cannot supply an agent winner', () => {
  const unknown = archive(); unknown.sizingInputs.gasUnits = null; unknown.sizingInputs.priorityFeeWei = null;
  assert.equal(normalizeResearch(unknown, nowMs).sizing.bestScenarioNetQuote, null);
  const stale = normalizeResearch(archive(), nowMs + 1800001);
  assert.equal(stale.freshness, 'stale'); assert.equal(stale.analysis.bestScenario, null);
  assert.equal(planAgentCycle(stale, emptyAgentState(), { nowMs: nowMs + 1800001 }).report.status, 'blocked');
  assert.equal(normalizeResearch(archive(nowMs + 1), nowMs).freshness, 'invalid-time');
});
test('mixed hashes, sources, factories, units and policy types reject the whole research archive', () => {
  for (const mutate of [a => a.snapshot.gas.blockHash = `0x${'b'.repeat(64)}`,
    a => a.snapshot.pools[0].factory = weth, a => a.snapshot.pools[0].source = 'synthetic-fixture',
    a => a.snapshot.pools[0].quoteDecimals = 6, a => a.snapshot.pools[0].capturedAtMs++,
    a => a.snapshot.pools[0].baseReserve = '1e10', a => a.sizingInputs.gasUnits = 300000,
    a => a.sizingInputs.inputsQuote = Array(65).fill('1')]) {
    const data = archive(); mutate(data); assert.throws(() => normalizeResearch(data, nowMs));
  }
});
test('only the atomically committed research pointer is read; arbitrary archives are not fallback data', async t => {
  const dir = await temporary(t);
  await writeFile(path.join(dir, 'uncommitted.json'), JSON.stringify(archive()));
  assert.equal((await loadResearch(dir, nowMs)).available, false);
  const file = await saveResearch(dir, archive());
  const pointer = JSON.parse(await readFile(path.join(dir, 'checkpoint.json'), 'utf8'));
  assert.equal(pointer.lastReport, path.basename(file));
  assert.equal((await loadResearch(dir, nowMs)).analysis.candidates.length, 4);
  await writeFile(path.join(dir, 'checkpoint.json'), JSON.stringify({ ...pointer, lastReport: '../package.json' }));
  await assert.rejects(loadResearch(dir, nowMs), /checkpoint/);
});
test('publishing rejects regression and concurrent writers without advancing the committed pointer', async t => {
  const dir = await temporary(t); await saveResearch(dir, archive());
  const before = await readFile(path.join(dir, 'checkpoint.json'), 'utf8');
  const regressed = archive(nowMs + 1); regressed.snapshot.blockNumber = 99;
  regressed.snapshot.gas.blockNumber = 99; regressed.snapshot.pools.forEach(p => p.blockNumber = 99);
  await assert.rejects(saveResearch(dir, regressed), /regression/);
  const lockPath = path.join(dir, 'publish.lock'), lock = await open(lockPath, 'wx');
  try { await assert.rejects(saveResearch(dir, archive(nowMs + 2)), /EEXIST/); }
  finally { await lock.close(); await unlink(lockPath); }
  assert.equal(await readFile(path.join(dir, 'checkpoint.json'), 'utf8'), before);
});
test('agent reviews sized positive and losing scenarios without qualifying them or ignoring the threshold', () => {
  const view = normalizeResearch(archive(), nowMs);
  const first = planAgentCycle(view, emptyAgentState(), { nowMs });
  assert.equal(first.report.decisions[0].priority, 3);
  assert.ok(first.report.decisions[0].tasks.includes('VALIDATE_GAS_ASSUMPTIONS'));
  assert.equal(first.report.decisions[0].qualified, false);
  assert.equal(first.report.decisions[0].netQuote, null);
  assert.equal(planAgentCycle(view, first.state, { nowMs }).report.decisions.length, 0);
  const expensive = archive(); expensive.sizingInputs.priorityFeeWei = '1000000000000';
  const loss = planAgentCycle(normalizeResearch(expensive, nowMs), first.state, { nowMs });
  assert.equal(loss.report.decisions[0].priority, 0);
  assert.ok(loss.report.decisions[0].tasks.includes('REFRESH_RESEARCH'));
  const threshold = archive(); threshold.sizingInputs.minNetQuote = '99999999999999999999';
  assert.equal(planAgentCycle(normalizeResearch(threshold, nowMs), emptyAgentState(), { nowMs }).report.decisions[0].priority, 0);
});
test('agent rejects sizing evidence from another block or discovery namespace', () => {
  const view = normalizeResearch(archive(), nowMs);
  view.sizing.blockHash = `0x${'b'.repeat(64)}`;
  assert.throws(() => planAgentCycle(view, emptyAgentState(), { nowMs }), /sizing/);
  const discovery = { ...normalizeResearch(archive(), nowMs), dataset: 'saved-onchain' };
  assert.throws(() => planAgentCycle(discovery, emptyAgentState(), { nowMs }), /discovery block/);
});
test('research endpoint is read-only, uses recomputation and clears corrupt or missing data', async t => {
  const dir = await temporary(t);
  const server = createMirServer({ researchDirectory: dir, now: () => nowMs });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/research`;
  assert.equal((await (await fetch(url)).json()).available, false);
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
  await saveResearch(dir, archive());
  const result = await (await fetch(url)).json();
  assert.equal(result.agentPreview.previewOnly, true);
  assert.equal(result.agentPreview.decisions[0].qualified, false);
  assert.equal(await (await fetch(url, { method: 'HEAD' })).text(), '');
  await writeFile(path.join(dir, 'checkpoint.json'), '{');
  const failed = await fetch(url); assert.equal(failed.status, 503);
  assert.equal((await failed.json()).analysis, null);
});
test('agent CLI persists research memory across restarts independently of discovery block height', async t => {
  const dir = await temporary(t), researchDir = path.join(dir, 'data/research');
  await mkdir(researchDir, { recursive: true }); await saveResearch(researchDir, archive(Date.now()));
  const script = fileURLToPath(new URL('../apps/monitor/agent.mjs', import.meta.url));
  const run = promisify(execFile);
  const first = JSON.parse((await run(process.execPath, [script], { cwd: dir, timeout: 10000 })).stdout);
  assert.equal(first.research.decisions.length, 1);
  const file = path.join(dir, 'data/agent/journal.json');
  const journal = JSON.parse(await readFile(file, 'utf8'));
  journal.state.lastBlockNumber = 200; journal.state.lastBlockHash = hash;
  await writeFile(file, JSON.stringify(journal));
  const second = JSON.parse((await run(process.execPath, [script], { cwd: dir, timeout: 10000 })).stdout);
  assert.equal(second.research.decisions.length, 0);
  assert.equal(second.research.duplicateDecisions, 1);
  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.researchState.lastBlockNumber, 100);
  assert.equal(saved.state.lastBlockNumber, 200);
  assert.equal(saved.researchHistory.length, 1);
});
