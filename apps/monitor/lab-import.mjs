import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateDataset, saveObject, evaluateExperiment } from '../../packages/lab/index.mjs';

const file = process.argv[2];
if (!file || process.argv.length !== 3) throw new Error('Usage: node apps/monitor/lab-import.mjs <funding-report.json>');
if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error('Input too large');
const report = JSON.parse(await readFile(file, 'utf8'));
if (report.mode !== 'funding-only-diagnostic' || !Array.isArray(report.assets) || report.assets.length > 3)
  throw new Error('Unsupported source report');
const datasets = report.assets.filter(a => Array.isArray(a.raw) && a.raw.length).map(a => validateDataset({
  schemaVersion: 1, kind: 'funding-history', source: report.source, asset: a.raw[0].coin,
  startMs: report.startInclusiveMs, endMs: report.endExclusiveMs, capturedAtMs: report.capturedAtMs,
  rows: a.raw.filter(r => r.time >= report.startInclusiveMs && r.time < report.endExclusiveMs) }));
if (!datasets.length) throw new Error('No raw funding data; saved analysis is never imported as evidence');
const root = resolve('data/lab'), registeredAtMs = Date.now(), imported = [];
for (const dataset of datasets) {
  const datasetId = await saveObject(root, 'datasets', dataset);
  for (const capitalUsd of ['500', '5000', '50000']) {
    const experiment = { schemaVersion: 1, model: 'funding-diagnostic-v1', datasetId, capitalUsd, registeredAtMs };
    evaluateExperiment(experiment, dataset);
    imported.push(await saveObject(root, 'experiments', experiment));
  }
}
console.log(JSON.stringify({ datasets: datasets.length, experiments: imported, mode: 'historical-diagnostic', qualified: 0 }));
