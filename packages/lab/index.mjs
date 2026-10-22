import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { validateMarketDataset, summarizeMarket } from './market-evidence.mjs';

const HOUR = 3600000, SCALE = 10n ** 18n;
const idPattern = /^[a-f0-9]{64}$/;
const digest = text => createHash('sha256').update(text).digest('hex');
const integer = n => Number.isSafeInteger(n) && n >= 0;
function rate(value) {
  if (typeof value !== 'string' || !/^-?\d{1,2}(?:\.\d{1,18})?$/.test(value)) throw new Error('Invalid funding decimal');
  const negative = value.startsWith('-');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const result = BigInt(whole) * SCALE + BigInt(fraction.padEnd(18, '0'));
  if (result > SCALE * 4n / 100n) throw new Error('Funding out of bounds');
  return negative ? -result : result;
}
function decimal(value) {
  const sign = value < 0n ? '-' : ''; const n = value < 0n ? -value : value;
  return `${sign}${n / SCALE}.${(n % SCALE).toString().padStart(18, '0')}`;
}
export function validateDataset(dataset) {
  if (dataset?.kind === 'market-snapshot') return validateMarketDataset(dataset);
  if (dataset?.schemaVersion !== 1 || dataset.kind !== 'funding-history' ||
      dataset.source !== 'https://api.hyperliquid.xyz/info' || !['BTC', 'ETH', 'SOL'].includes(dataset.asset) ||
      !integer(dataset.startMs) || !integer(dataset.endMs) || !integer(dataset.capturedAtMs) ||
      dataset.startMs % HOUR || dataset.endMs % HOUR || dataset.endMs <= dataset.startMs ||
      dataset.endMs > dataset.capturedAtMs || dataset.endMs - dataset.startMs > 366 * 24 * HOUR ||
      !Array.isArray(dataset.rows) || dataset.rows.length !== (dataset.endMs - dataset.startMs) / HOUR)
    throw new Error('Invalid funding dataset');
  const seen = new Set();
  for (const row of dataset.rows) {
    if (row.coin !== dataset.asset || !integer(row.time) || row.time < dataset.startMs || row.time >= dataset.endMs)
      throw new Error('Invalid funding identity/time');
    const bucket = Math.floor(row.time / HOUR);
    if (seen.has(bucket)) throw new Error('Duplicate funding interval');
    seen.add(bucket); rate(row.fundingRate);
  }
  return dataset;
}
export function evaluateExperiment(experiment, dataset) {
  validateDataset(dataset);
  if (dataset.kind !== 'funding-history' || experiment?.schemaVersion !== 1 || experiment.model !== 'funding-diagnostic-v1' ||
      !idPattern.test(experiment.datasetId) || !['500', '5000', '50000'].includes(experiment.capitalUsd) ||
      !integer(experiment.registeredAtMs) || experiment.registeredAtMs < dataset.capturedAtMs)
    throw new Error('Invalid experiment');
  const rates = dataset.rows.map(row => rate(row.fundingRate));
  const total = rates.reduce((a, b) => a + b, 0n);
  return { schemaVersion: 1, model: experiment.model, decision: 'insufficient-evidence',
    qualified: false, netUsd: null, returnOnCapital: null, drawdown: null, actualFills: 0,
    capitalUsd: experiment.capitalUsd, intervals: rates.length,
    normalizedShortFundingBps: decimal(total * 10000n),
    positiveIntervals: rates.filter(r => r > 0n).length, negativeIntervals: rates.filter(r => r < 0n).length,
    reasons: ['SPOT_PERP_PRICES_MISSING', 'EXECUTION_COSTS_UNKNOWN', 'COLLATERAL_MODEL_MISSING',
      'HISTORICAL_DIAGNOSTIC_NOT_OUT_OF_SAMPLE', 'NO_FORWARD_OBSERVATIONS'],
    nextTasks: ['COLLECT_SYNCHRONIZED_PRICES', 'COLLECT_DEPTH', 'SPECIFY_COST_POLICY', 'REGISTER_HOLDOUT'] };
}
async function boundedRead(file) {
  if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error('Lab object too large');
  return readFile(file, 'utf8');
}
export async function saveObject(root, type, object) {
  if (!['datasets', 'experiments'].includes(type)) throw new Error('Unknown object type');
  const text = JSON.stringify(object), id = digest(text);
  if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error('Lab object too large');
  await mkdir(join(root, type), { recursive: true });
  const target = join(root, type, `${id}.json`);
  try { await writeFile(target, text, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST' || await boundedRead(target) !== text) throw error; }
  return id;
}
export async function loadObject(root, type, id) {
  if (!['datasets', 'experiments'].includes(type) || !idPattern.test(id)) throw new Error('Invalid lab object ID');
  const text = await boundedRead(join(root, type, `${id}.json`));
  if (digest(text) !== id) throw new Error('Lab integrity failure');
  return JSON.parse(text);
}
async function ids(root, type) {
  let names;
  try { names = await readdir(join(root, type)); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  if (names.length > 1000) throw new Error('Lab listing exceeds bound');
  return names.filter(n => /^[a-f0-9]{64}\.json$/.test(n)).map(n => n.slice(0, -5)).sort();
}
export async function experimentView(root, id) {
  const experiment = await loadObject(root, 'experiments', id);
  const dataset = await loadObject(root, 'datasets', experiment.datasetId);
  return { id, experiment, asset: dataset.asset, startMs: dataset.startMs, endMs: dataset.endMs,
    result: evaluateExperiment(experiment, dataset) };
}
export async function labView(root, type, id = null) {
  if (id) return experimentView(root, id);
  const list = await ids(root, type), items = [];
  for (const itemId of list) {
    if (type === 'experiments') items.push(await experimentView(root, itemId));
    else {
      const dataset = validateDataset(await loadObject(root, type, itemId));
      if (dataset.kind === 'market-snapshot') {
        items.push({ id: itemId, schemaVersion: 1, kind: dataset.kind, source: dataset.source,
          capturedAtMs: dataset.capturedAtMs, adapter: dataset.adapter,
          markets: dataset.markets.map(m => ({ id: m.id, symbol: m.symbol, spot: m.spot, swap: m.swap })),
          quality: summarizeMarket(dataset), coverage: 'point-in-time-market-snapshot' });
        continue;
      }
      const { rows, ...metadata } = dataset;
      items.push({ id: itemId, ...metadata, intervals: rows.length, coverage: 'complete-hourly-funding-only' });
    }
  }
  return { schemaVersion: 1, available: items.length > 0, items, mode: 'read-only-research-lab' };
}
