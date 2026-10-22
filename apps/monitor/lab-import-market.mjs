import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { validateDataset, saveObject } from '../../packages/lab/index.mjs';
const file = process.argv[2];
if (!file || process.argv.length !== 3) throw new Error('Usage: node apps/monitor/lab-import-market.mjs <market-capture.json>');
if ((await stat(file)).size > 8 * 1024 * 1024) throw new Error('Input too large');
const report = JSON.parse(await readFile(file, 'utf8'));
if (report.kind !== 'public-market-capture') throw new Error('Unsupported report');
const dataset = validateDataset({ schemaVersion: 1, kind: 'market-snapshot', source: 'https://api.hyperliquid.xyz/info',
  adapter: report.adapter, capturedAtMs: report.capturedAtMs, captureMode: report.captureMode ?? 'sequential',
  markets: report.markets, evidence: report.evidence });
const id = await saveObject(resolve('data/lab'), 'datasets', dataset);
console.log(JSON.stringify({ id, kind: dataset.kind, qualified: false, experimentsCreated: 0 }));
