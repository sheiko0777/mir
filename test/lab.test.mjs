import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDataset, saveObject, labView, evaluateExperiment } from '../packages/lab/index.mjs';
import { createMirServer } from '../apps/server/server.mjs';
import { summarizeMarket } from '../packages/lab/market-evidence.mjs';
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
test('Market snapshots preserve failed/stale/mismatched evidence without qualifying a trade', async () => {
  const dataset = { schemaVersion: 1, kind: 'market-snapshot', source: 'https://api.hyperliquid.xyz/info',
    adapter: 'ccxt/4.5.89', capturedAtMs: 10000, markets: [{ id: 'BTC', symbol: 'BTC/USDC:USDC', spot: false, swap: true }],
    evidence: [{ request: { type: 'l2Book', coin: 'BTC' }, requestedAtMs: 9000, capturedAtMs: 10000,
      response: { coin: 'BTC', time: 9500, levels: [[{ px: '100', sz: '1' }], [{ px: '101', sz: '1' }]] } }] };
  const good = summarizeMarket(dataset);
  assert.equal(good.books[0].status, 'capture-checks-passed');
  assert.equal(good.netUsd, null); assert.equal(good.latencyP95Ms, 1000);
  for (const [change, reason] of [
    [r => { r.response.time = 1000; }, 'STALE_SNAPSHOT'],
    [r => { r.response.coin = 'ETH'; }, 'MARKET_IDENTITY_MISMATCH'],
    [r => { r.error = 'timeout'; delete r.response; }, 'SOURCE_REQUEST_FAILED'],
    [r => { r.response.levels[0][0].sz = 'NaN'; }, 'INVALID_DEPTH']]) {
    const copy = structuredClone(dataset); change(copy.evidence[0]);
    assert.equal(summarizeMarket(copy).books[0].reason, reason);
  }
  const root = await mkdtemp(join(tmpdir(), 'mir-market-'));
  try {
    await saveObject(root, 'datasets', dataset);
    const view = await labView(root, 'datasets');
    assert.equal(view.items[0].evidence, undefined);
    assert.equal(view.items[0].quality.qualified, false);
  } finally { await rm(root, { recursive: true, force: true }); }
  assert.throws(() => validateDataset({ ...dataset, source: 'https://unverified.invalid' }));
  assert.throws(() => evaluateExperiment({}, dataset));
  const concurrent = structuredClone(dataset);
  concurrent.captureMode = 'parallel-2';
  concurrent.markets[0].id = '0'; concurrent.markets[0].info = { name: 'BTC' };
  concurrent.markets[0].base = 'BTC';
  concurrent.evidence[0].marketSymbol = 'BTC/USDC:USDC';
  assert.equal(summarizeMarket(concurrent).captureMode, 'parallel-2');
  concurrent.markets.push({ id: '@142', symbol: 'BTC/USDC', base: 'BTC', spot: true, swap: false });
  const spotBook = structuredClone(concurrent.evidence[0]);
  spotBook.request.coin = '@142'; spotBook.response.coin = '@142'; spotBook.marketSymbol = 'BTC/USDC';
  spotBook.response.time = 9400; concurrent.evidence.push(spotBook);
  assert.equal(summarizeMarket(concurrent).candidatePairs[0].sourceSkewMs, 100);
  assert.equal(summarizeMarket(concurrent).candidatePairs[0].hedgeIdentityVerified, false);
  concurrent.evidence[0].marketSymbol = 'ETH/USDC:USDC';
  assert.throws(() => validateDataset(concurrent));
});
