import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { planBotResearch } from '../packages/bots/index.mjs';
import { createMirServer } from '../apps/server/server.mjs';
import { saveObject, validateDataset } from '../packages/lab/index.mjs';

test('multi-bot planner keeps capability, evidence and qualification separate and task IDs stable', () => {
  const research = { available: false, freshness: 'unavailable', qualified: true };
  const datasets = { items: [] };
  const plan = planBotResearch(research, datasets, 100);
  assert.equal(plan.bots.length, 4);
  assert.equal(plan.tasks.length, 5);
  assert.equal(new Set(plan.tasks.map(task => task.id)).size, 5);
  assert.deepEqual(plan.tasks.map(task => task.id), planBotResearch(research, datasets, 200).tasks.map(task => task.id));
  assert.equal(plan.executionEnabled, false);
  assert.equal(plan.qualifiedStrategies, 0);
  assert.ok(plan.bots.every(bot => bot.netUsd === null && bot.qualified === false));
  assert.equal(plan.bots.find(bot => bot.id === 'kronos-forecast').status, 'awaiting-integration');
});

test('HYPE funding is accepted as diagnostic evidence and never supplies missing return inputs', () => {
  const dataset = { schemaVersion: 1, kind: 'funding-history', source: 'https://api.hyperliquid.xyz/info',
    asset: 'HYPE', startMs: 0, endMs: 3600000, capturedAtMs: 3600001,
    rows: [{ coin: 'HYPE', time: 1, fundingRate: '0.001' }] };
  assert.equal(validateDataset(dataset), dataset);
  const plan = planBotResearch({ available: false }, { items: [{ ...dataset, id: 'a'.repeat(64) }] }, 3600002);
  const carry = plan.bots.find(bot => bot.id === 'carry-funding');
  assert.equal(carry.status, 'research-evidence-available');
  assert.equal(carry.netUsd, null);
  assert.ok(carry.reasons.includes('SYNCHRONIZED_PRICE_HISTORY_REQUIRED'));
  assert.throws(() => validateDataset({ ...dataset, asset: 'BTC' }));
});

test('bot endpoint recomputes saved evidence, rejects writes and clears corrupt source data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mir-bots-'));
  const labDirectory = join(root, 'lab');
  const server = createMirServer({ labDirectory, researchDirectory: join(root, 'research'), now: () => 10000 });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/api/bots`;
    assert.equal((await (await fetch(url)).json()).bots.length, 4);
    assert.equal((await fetch(url, { method: 'POST' })).status, 405);
    assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
    const id = await saveObject(labDirectory, 'datasets', { kind: 'forged-winner', qualified: true });
    const response = await fetch(url);
    assert.equal(response.status, 503);
    assert.deepEqual((await response.json()).bots, []);
    await writeFile(join(labDirectory, 'datasets', `${id}.json`), '{}');
    assert.equal((await fetch(url)).status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
    assert.equal(join(tmpdir(), root.split(/[\\/]/).at(-1)), root);
    await rm(root, { recursive: true, force: true });
  }
});
