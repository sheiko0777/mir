import { assessRoute } from './index.mjs';

// Historical research output deliberately has no paper-ledger eligible interface.
export function compareMarkets(snapshot, inputQuote, nowMs = Date.now()) {
  const pools = snapshot.pools;
  if (!Array.isArray(pools) || pools.length > 10) throw new Error('Invalid pool collection');
  const routes = [];
  for (let i = 0; i < pools.length; i++) for (let j = 0; j < pools.length; j++) {
    if (i === j) continue;
    const buy = pools[i];
    const sell = pools[j];
    if (!buy.blockHash || buy.blockHash !== sell.blockHash || buy.blockHash !== snapshot.blockHash ||
        buy.blockNumber !== sell.blockNumber || buy.blockNumber !== snapshot.blockNumber) throw new Error('Mixed block snapshots');
    if (!Number.isInteger(buy.quoteDecimals) || buy.quoteDecimals < 0 || buy.quoteDecimals > 255 ||
        buy.quoteDecimals !== sell.quoteDecimals || buy.baseDecimals !== sell.baseDecimals) throw new Error('Token decimals mismatch');
    const result = assessRoute(buy, sell, inputQuote, { gasQuote: 0n, bufferQuote: 0n },
      { nowMs, maxAgeMs: 30 * 60_000, maxBlockLag: 0, maxInputBps: 100, minNetQuote: 0n });
    const grossAfterPoolFeesQuote = result.quoteOut - result.input;
    const reasons = result.reasons.filter(r => r !== 'NET_BELOW_THRESHOLD');
    if (grossAfterPoolFeesQuote <= 0n) reasons.push('NO_GROSS_SPREAD');
    reasons.push('GAS_VALUATION_UNAVAILABLE', 'UNCERTAINTY_BUFFER_UNSET', 'HISTORICAL_RESEARCH_ONLY');
    if (buy.finality !== 'finalized' || sell.finality !== 'finalized') reasons.push('FINALITY_UNVERIFIED');
    routes.push({ buyVenue: buy.venue, sellVenue: sell.venue, buyPool: buy.address, sellPool: sell.address,
      quoteToken: buy.quoteToken, quoteDecimals: buy.quoteDecimals, inputQuote, baseOut: result.baseOut,
      outputQuote: result.quoteOut, grossAfterPoolFeesQuote, netQuote: null,
      status: 'unqualified', reasons: [...new Set(reasons)] });
  }
  return { schemaVersion: 1, brand: 'WADJ', platform: 'MIR', engine: 'LXR',
    mode: 'historical-read-only-research', blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash,
    capturedAtMs: snapshot.capturedAtMs, evaluatedAtMs: nowMs, poolCount: pools.length,
    qualifiedOpportunities: 0, exclusions: snapshot.excluded ?? [], routes };
}
