import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { scanPoolTogether, replayClaimCapture, validateClaimWatchlist } from '../../packages/bots/pooltogether.mjs';
import { illustrativeClaimSession } from '../../packages/bots/pooltogether-fixture.mjs';
import { createClaimRpc } from '../../packages/adapters/pooltogether-rpc.mjs';
import { saveClaimCapture } from '../server/pooltogether.mjs';

const args = process.argv.slice(2);
if (!(args.length === 1 && args[0] === '--demo' || args.length === 1 && args[0] === '--live' ||
    args.length === 3 && args[0] === '--live' && args[1] === '--watchlist')) throw new Error('Usage: node apps/monitor/pooltogether.mjs --demo | --live [--watchlist local.json]');
const demo = args[0] === '--demo';
const session = demo ? illustrativeClaimSession() : createClaimRpc();
const raw = demo ? null : await readFile(resolve(args[2] ?? 'config/pooltogether-watchlist.json'));
if (raw && raw.byteLength > 65536) throw new Error('Watchlist budget exceeded');
const watchlist = validateClaimWatchlist(demo ? session.watchlist : JSON.parse(raw));
let capturedAtMs = demo ? session.capturedAtMs : Date.now();
try {
  const snapshot = await scanPoolTogether(session.read, watchlist, demo ? capturedAtMs : Date.now);
  capturedAtMs = snapshot.capturedAtMs;
}
catch (error) {
  if (!demo) capturedAtMs = Date.now();
  if (!session.records.some(row => row.error) && !['FUTURE_BLOCK_TIME', 'STALE_BLOCK_TIME'].includes(error.reason)) throw error;
}
const capture = { schemaVersion: 1, kind: 'pooltogether-claim-capture', capturedAtMs,
  watchlist, source: session.source, records: session.records };
const report = await replayClaimCapture(capture, Date.now());
const id = await saveClaimCapture(resolve('data/bots/pooltogether'), capture);
console.log(JSON.stringify({ evidenceId: id, status: report.status, illustrative: report.illustrative ?? false,
  seedsChecked: report.coverage?.seedsChecked ?? 0, coverage: report.coverage ?? null, batches: report.batches,
  failure: report.failure ?? null, viability: report.viability ?? null,
  source: report.source, requests: session.records.length, metrics: session.metrics?.(),
  executionEnabled: false, verifiedNetAtomic: null }));
