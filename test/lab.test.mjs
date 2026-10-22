import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDataset, saveObject, labView, evaluateExperiment } from '../packages/lab/index.mjs';
import { createMirServer } from '../apps/server/server.mjs';
const sample = () => ({ schemaVersion: 1, kind: 'funding-history', source: 'https://api.hyperliquid.xyz/info',
  asset: 'BTC', startMs: 0, endMs: 7200000, capturedAtMs: 7200001,
  rows: [{ coin: 'BTC', time: 15, fundingRate: '0.001' }, { coin: 'BTC', time: 3600007, fundingRate: '-0.002' }] });
test('Lab exact diagnostics reject gaps and never turn capital into a guessed profit', () => {
  const d = sample();
  const e = { schemaVersion: 1, model: 'funding-diagnostic-v1', datasetId: 'a'.repeat(64), capitalUsd: '500', registeredAtMs: 7200002 };
  const result = evaluateExperiment(e, d);
  assert.equal(result.normalizedShortFundingBps, '-10.000000000000000000');
  assert.equal(result.netUsd, null); assert.equal(result.qualified, false);
  for (const change of [x => x.rows.pop(), x => { x.rows[1].time = 16; },
    x => { x.rows[0].coin = 'ETH'; }, x => { x.rows[0].fundingRate = 'NaN'; },
    x => { x.capturedAtMs = 1; }]) {
    const bad = sample(); change(bad); assert.throws(() => validateDataset(bad));
  }
  assert.throws(() => evaluateExperiment({ ...e, model: 'guaranteed-profit' }, d));
});
test('Lab APIs recompute immutable evidence and fail closed on tampering; writes are rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mir-lab-'));
  const server = createMirServer({ labDirectory: root });
  try {
    assert.equal((await labView(root, 'datasets')).available, false);
    const d = sample(), id = await saveObject(root, 'datasets', d);
    assert.equal(await saveObject(root, 'datasets', d), id);
    const e = { schemaVersion: 1, model: 'funding-diagnostic-v1', datasetId: id, capitalUsd: '5000', registeredAtMs: 7200002 };
    const experimentId = await saveObject(root, 'experiments', e);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    const datasetView = await (await fetch(`${base}/api/lab/datasets`)).json();
    assert.equal(datasetView.items.length, 1); assert.equal(datasetView.items[0].rows, undefined);
    const result = await (await fetch(`${base}/api/lab/experiments/${experimentId}`)).json();
    assert.equal(result.result.netUsd, null);
    assert.equal((await fetch(`${base}/api/lab/experiments`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/api/lab/experiments/not-an-id`)).status, 404);
    await writeFile(join(root, 'datasets', `${id}.json`), JSON.stringify({ ...d, asset: 'ETH' }));
    assert.equal((await fetch(`${base}/api/lab/experiments/${experimentId}`)).status, 503);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
