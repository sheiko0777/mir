import { open, realpath } from 'node:fs/promises';
import path from 'node:path';

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const REPORT_NAME = /^\d+-\d+-\d+\.json$/;
const QUOTES = new Map([
  ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', { label: 'WETH', decimals: 18 }],
  ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', { label: 'USDC', decimals: 6 }]
]);
export const MAX_CAPTURE_AGE_MS = 30 * 60_000;
const integer = n => Number.isSafeInteger(n) && n >= 0;
function atomic(value) {
  if (typeof value !== 'string' || !/^\d{1,512}$/.test(value)) throw new Error('Invalid numeric report field');
  return value;
}
async function readJson(file, directory) {
  const resolved = await realpath(file);
  const base = await realpath(directory);
  if (path.dirname(resolved) !== base) throw new Error('Invalid report location');
  const handle = await open(resolved, 'r');
  try {
    if ((await handle.stat()).size > 8 * 1024 * 1024) throw new Error('Report exceeds size limit');
    const content = await handle.readFile('utf8');
    if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error('Report exceeds size limit');
    return JSON.parse(content);
  } finally { await handle.close(); }
}

export function normalizeDiscovery(report, nowMs = Date.now()) {
  if (!report || report.schemaVersion !== 1 || report.engine !== 'LXR' || report.mode !== 'read-only-new-pools' ||
      !integer(report.blockNumber) || !HASH.test(report.blockHash) || !integer(report.capturedAtMs) ||
      !integer(nowMs) || !Array.isArray(report.discoveries) || !Array.isArray(report.followUps ?? []) ||
      report.discoveries.length + (report.followUps?.length ?? 0) > 200 || report.finality !== 'finalized') {
    throw new Error('Invalid discovery report');
  }
  const ageMs = nowMs - report.capturedAtMs;
  const freshness = ageMs < 0 ? 'invalid-time' : ageMs > MAX_CAPTURE_AGE_MS ? 'stale' : 'recent-capture';
  const observations = new Map();
  const unpricedPairs = [];
  for (const entry of [...report.discoveries, ...(report.followUps ?? [])]) {
    const tokens = entry.tokens ?? [entry.baseToken, entry.quoteToken];
    if (!Array.isArray(tokens) || tokens.length !== 2 || tokens.some(t => !ADDRESS.test(t)) ||
        tokens[0].toLowerCase() === tokens[1].toLowerCase()) throw new Error('Invalid report token pair');
    const analysis = entry.analysis;
    if (analysis && (!Array.isArray(analysis.prices) || analysis.prices.length > 10)) throw new Error('Invalid market analysis');
    const originalPool = entry.pool ?? entry.address;
    const prices = analysis?.prices ?? [];
    const selected = originalPool ? prices.filter(p => p.pool?.toLowerCase() === originalPool.toLowerCase()) : prices;
    const markets = selected.length ? selected : [{ pool: originalPool, venue: entry.venue }];
    const reasons = [...new Set([...(analysis?.reasons ?? entry.reasons ?? []), 'TOKEN_CHECKS_UNKNOWN', 'GAS_VALUATION_UNAVAILABLE'])];
    if (reasons.some(r => typeof r !== 'string' || !/^[A-Z_]{1,80}$/.test(r))) throw new Error('Invalid report reasons');
    if (!originalPool && !selected.length) {
      unpricedPairs.push({ tokens: tokens.map(t => t.toLowerCase()), reasons, qualified: false });
      continue;
    }
    for (const market of markets) {
      if (!ADDRESS.test(market.pool) || !['uniswap-v2', 'sushiswap-v2'].includes(market.venue)) throw new Error('Invalid pool provenance');
      const quote = QUOTES.get(market.quoteToken?.toLowerCase());
      if (market.quoteToken && !tokens.some(t => t.toLowerCase() === market.quoteToken.toLowerCase())) throw new Error('Quote token does not match observation');
      const spotGapBps = analysis?.spotGapBps == null ? null : atomic(analysis.spotGapBps);
      const quoteReserve = quote && market.quoteReserve != null ? atomic(market.quoteReserve) : null;
      const pool = market.pool.toLowerCase();
      observations.set(pool, { id: `1:${pool}`, chainId: 1, pool, tokens: tokens.map(t => t.toLowerCase()),
        venue: market.venue, quoteToken: quote ? market.quoteToken.toLowerCase() : null,
        quoteLabel: quote?.label ?? null, quoteDecimals: quote?.decimals ?? null, quoteReserve,
        spotGapBps, reasons, evidence: reasons.includes('EMPTY_RESERVES') ? 'blocked' : 'unknown',
        tokenAge: 'unknown', blockNumber: report.blockNumber, blockHash: report.blockHash,
        capturedAtMs: report.capturedAtMs, freshness, qualified: false, netQuote: null,
        classification: entry.classification === 'NEW_SINCE_CHECKPOINT' ? 'NEW_SINCE_CHECKPOINT' : 'FOLLOW_UP' });
    }
  }
  return { schemaVersion: 1, available: true, dataset: 'saved-onchain', freshness,
    capturedAtMs: report.capturedAtMs, captureAgeMs: Math.max(0, ageMs),
    // Collection time is not a block timestamp or evidence of current market state.
    observedAtMs: null, blockNumber: report.blockNumber, blockHash: report.blockHash,
    finality: 'finalized', qualifiedOpportunities: 0, netProfitKnown: false,
    observations: [...observations.values()], unpricedPairs, coverage: Array.isArray(report.coverage) ? report.coverage : [],
    pendingPairCount: integer(report.pendingPairCount) ? report.pendingPairCount : null };
}

export async function loadDiscovery(directory, nowMs = Date.now()) {
  let checkpoint;
  try { checkpoint = await readJson(path.join(directory, 'checkpoint.json'), directory); }
  catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, available: false, dataset: 'saved-onchain', freshness: 'unavailable', observations: [], qualifiedOpportunities: 0 };
    throw error;
  }
  if (!checkpoint?.state || checkpoint.state.chainId !== 1 || !REPORT_NAME.test(checkpoint.lastReport)) throw new Error('Invalid report checkpoint');
  const report = await readJson(path.join(directory, checkpoint.lastReport), directory);
  if (report.blockNumber !== checkpoint.state.blockNumber || report.blockHash !== checkpoint.state.blockHash) throw new Error('Checkpoint and report disagree');
  return normalizeDiscovery(report, nowMs);
}
