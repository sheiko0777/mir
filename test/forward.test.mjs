import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, open, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { VENUES } from '../packages/adapters/uniswap-v2.mjs';
import { normalizeResearch, saveResearch } from '../apps/server/research.mjs';
import { emptyForwardJournal, advanceForward, summarizeForward, validateForwardJournal, MAX_EXPERIMENTS } from '../packages/paper/forward.mjs';

// Entirely invented reserves, headers and wall clock; no network or real token-risk evidence.
const start = 1000000;
function fixture(block = 100, time = start, spread = 30) {
  const hash = `0x${block.toString(16).padStart(64, '0')}`;
  return { snapshot: { schemaVersion: 1, chainId: 1, mode: 'read-only', blockNumber: block,
    blockHash: hash, capturedAtMs: time, observedAtMs: time,
    gas: { blockNumber: block, blockHash: hash, source: 'pinned-rpc-header', baseFeePerGasWei: '1000000000' },
    pools: Object.entries(VENUES).map(([venue, factory], i) => ({ chainId: 1, venue, factory,
      source: `ethereum-${venue}-rpc`, address: `0x${String(i + 1).repeat(40)}`,
      baseToken: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      quoteToken: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', baseDecimals: 6, quoteDecimals: 18,
      baseReserve: '1000000000000', quoteReserve: String(BigInt(1000 + i * spread) * 10n ** 18n),
      blockNumber: block, blockHash: hash, capturedAtMs: time, observedAtMs: time,
      model: 'constant-product', feeBps: 30, finality: 'finalized', tokenChecksPassed: true })) },
    sizingInputs: { schemaVersion: 1, inputsQuote: ['100000000000000000', '1000000000000000000'],
      gasUnits: '300000', priorityFeeWei: '1000000000', bufferBps: 50, baseFeeFactorBps: 10000,
      budgetQuote: null, minNetQuote: '0' } };
}
const advance = (state, source, nowMs, options = {}) => advanceForward(state, source,
  { nowMs, delayMs: 1000, horizonMs: 100000, ...options });

test('forward experiment freezes pre-observation size, direction and cost policy across an adverse later block', () => {
  const initial = advance(emptyForwardJournal(), fixture(), start);
  const original = summarizeForward(initial.journal).records[0];
  assert.ok(BigInt(original.initialScenarioNetQuote) > 0n);
  const later = fixture(101, start + 2000, -50);
  later.sizingInputs.gasUnits = '1'; later.sizingInputs.bufferBps = 0;
  later.sizedReport = { bestScenario: { qualified: true, scenarioNetQuote: '999999999999' } };
  const result = advance(initial.journal, later, start + 2000);
  const row = summarizeForward(result.journal).records[0];
  assert.equal(row.status, 'observed');
  assert.equal(row.inputQuote, original.inputQuote); assert.equal(row.buyPool, original.buyPool);
  assert.ok(BigInt(row.laterScenarioNetQuote) < 0n);
  assert.equal(row.scenarioChangeQuote, (BigInt(row.laterScenarioNetQuote) - BigInt(original.initialScenarioNetQuote)).toString());
  assert.equal(row.actualNetQuote, null); assert.equal(row.qualified, false);
  assert.equal(result.journal.records[0].outcomeArchive.sizingInputs.gasUnits, '300000');
  assert.equal(result.journal.records[0].outcomeArchive.sizingInputs.bufferBps, 50);
  assert.equal(summarizeForward(result.journal).paperFills, 0);
  assert.deepEqual(initial.journal.records[0].status, 'pending'); // Pure update, original is unchanged.
});
test('a later capture cannot masquerade as a later on-chain observation; replay waits for the registered delay', () => {
  const initial = advance(emptyForwardJournal(), fixture(), start).journal;
  const tooEarly = fixture(101, start + 2000); tooEarly.snapshot.observedAtMs = start + 999;
  tooEarly.snapshot.pools.forEach(p => p.observedAtMs = start + 999);
  const waiting = advance(initial, tooEarly, start + 2000).journal;
  assert.equal(waiting.records[0].status, 'pending');
  const later = advance(waiting, fixture(102, start + 3000), start + 3000).journal;
  assert.equal(later.records[0].status, 'observed');
  assert.equal(summarizeForward(later).records[0].observedDelayMs, 3000);
});
test('same block deduplicates even with new policy; conflicts and malformed evidence fail without mutating memory', () => {
  const initial = advance(emptyForwardJournal(), fixture(), start).journal, before = JSON.stringify(initial);
  const changed = fixture(); changed.sizingInputs.bufferBps++;
  assert.equal(advance(initial, changed, start + 1).reason, 'DUPLICATE_BLOCK');
  assert.equal(advance(initial, changed, start + 1).journal.records.length, 1);
  const conflict = fixture(); conflict.snapshot.blockHash = `0x${'f'.repeat(64)}`;
  conflict.snapshot.gas.blockHash = conflict.snapshot.blockHash;
  conflict.snapshot.pools.forEach(p => p.blockHash = conflict.snapshot.blockHash);
  assert.throws(() => advance(initial, conflict, start), /conflict/);
  const malformed = fixture(101, start + 2000); malformed.snapshot.pools[0].source = 'sample';
  assert.throws(() => advance(initial, malformed, start + 2000));
  assert.equal(JSON.stringify(initial), before);
});
test('unknown costs, stale/future captures and unavailable input never create imaginary experiments', () => {
  const unknown = fixture(); unknown.sizingInputs.gasUnits = null;
  assert.equal(advance(emptyForwardJournal(), unknown, start).reason, 'NO_COSTED_ENTRY');
  for (const now of [start - 1, start + 1800001]) {
    const result = advance(emptyForwardJournal(), fixture(), now);
    assert.equal(result.reason, 'STALE_OR_FUTURE_CAPTURE'); assert.equal(result.journal.records.length, 0);
  }
  const initial = advance(emptyForwardJournal(), fixture(), start).journal;
  const expired = advance(initial, null, start + 100001).journal;
  assert.equal(expired.records[0].status, 'expired');
  assert.equal(summarizeForward(expired).records[0].laterScenarioNetQuote, null);
});
test('unavailable routes or incompatible units cannot close an existing hypothesis', () => {
  const initial = advance(emptyForwardJournal(), fixture(), start).journal;
  const absent = fixture(101, start + 2000); absent.snapshot.pools.pop();
  assert.equal(advance(initial, absent, start + 2000).journal.records[0].status, 'pending');
  const units = fixture(101, start + 2000); units.snapshot.pools.forEach(p => p.baseDecimals = 18);
  assert.equal(advance(initial, units, start + 2000).journal.records[0].status, 'pending');
});
test('journal validation recomputes entries and outcomes and rejects corruption or altered frozen assumptions', () => {
  const initial = advance(emptyForwardJournal(), fixture(), start).journal;
  const completed = advance(initial, fixture(101, start + 2000), start + 2000).journal;
  for (const mutate of [j => j.records[0].entryArchive.sizingInputs.gasUnits = '1',
    j => j.records[0].outcomeArchive.sizingInputs.bufferBps = 0,
    j => j.records[0].closedAtMs = start,
    j => j.records[0].status = 'pending', j => j.lastSource = null,
    j => j.lastSource.blockHash = `0x${'f'.repeat(64)}`]) {
    const damaged = structuredClone(completed); mutate(damaged); assert.throws(() => validateForwardJournal(damaged));
  }
  assert.throws(() => advance(initial, fixture(), start, { horizonMs: 1000 }), /timing/);
  assert.throws(() => advance(initial, fixture(), start - 1), /clock regression/);
});
test('bounded journal preserves full history and still resolves outstanding experiments at capacity', () => {
  let journal = emptyForwardJournal();
  for (let i = 0; i < MAX_EXPERIMENTS; i++) journal = advance(journal, fixture(100 + i, start + i), start + i).journal;
  assert.equal(journal.records.length, MAX_EXPERIMENTS);
  const result = advance(journal, fixture(200, start + 3000), start + 3000);
  assert.equal(result.reason, 'JOURNAL_CAPACITY_REACHED');
  assert.equal(result.journal.records.length, MAX_EXPERIMENTS);
  assert.equal(summarizeForward(result.journal).counts.observed, MAX_EXPERIMENTS);
});
test('CLI persists across restarts, deduplicates, and preserves journal bytes on lock or corruption failure', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'mir-forward-test-'));
  t.after(async () => {
    if (path.dirname(path.resolve(dir)) !== path.resolve(tmpdir()) || !path.basename(dir).startsWith('mir-forward-test-')) throw new Error('Unsafe cleanup');
    await rm(dir, { recursive: true, force: true });
  });
  await saveResearch(path.join(dir, 'data/research'), fixture(100, Date.now()));
  const script = fileURLToPath(new URL('../apps/monitor/forward.mjs', import.meta.url));
  const run = () => promisify(execFile)(process.execPath, [script], { cwd: dir, timeout: 20000, windowsHide: true });
  assert.equal(JSON.parse((await run()).stdout).counts.pending, 1);
  const file = path.join(dir, 'data/forward/journal.json'), before = await readFile(file, 'utf8');
  assert.equal(JSON.parse((await run()).stdout).reason, 'DUPLICATE_BLOCK');
  assert.equal(await readFile(file, 'utf8'), before);
  const lockPath = path.join(dir, 'data/forward/run.lock'), lock = await open(lockPath, 'wx');
  try { await assert.rejects(run()); } finally { await lock.close(); await unlink(lockPath); }
  assert.equal(await readFile(file, 'utf8'), before);
  await writeFile(file, '{'); await assert.rejects(run()); assert.equal(await readFile(file, 'utf8'), '{');
});
