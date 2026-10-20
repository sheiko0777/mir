import { compareMarkets } from './research.mjs';

export const QUOTE_TOKENS = Object.freeze([
  { address: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', label: 'WETH', decimals: 18, input: 10n ** 17n },
  { address: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', label: 'USDC', decimals: 6, input: 100n * 10n ** 6n }
]);

export function analyzeDiscoveredPair(snapshot, { minGapBps = 100, nowMs = Date.now() } = {}) {
  if (!Number.isSafeInteger(minGapBps) || minGapBps < 0 || minGapBps > 1_000_000) throw new Error('Invalid gap threshold');
  const result = { status: 'unqualified', qualified: false, poolCount: snapshot.pools.length,
    spotGapBps: null, gapThresholdBps: minGapBps, gapDetected: false, prices: [], research: null,
    reasons: ['TOKEN_AGE_UNKNOWN', 'TOKEN_CHECKS_UNKNOWN', 'HISTORICAL_RESEARCH_ONLY'] };
  if (!snapshot.pools.length) { result.reasons.push('NO_FUNDED_POOL'); return result; }
  const first = snapshot.pools[0];
  const quote = QUOTE_TOKENS.find(q => [first.baseToken, first.quoteToken].includes(q.address));
  if (!quote) { result.reasons.push('UNSUPPORTED_QUOTE_TOKEN'); return result; }
  result.quoteToken = quote.address;
  result.quoteLabel = quote.label;
  const pools = snapshot.pools.map(pool => {
    if (pool.quoteToken === quote.address) return { ...pool };
    if (pool.baseToken !== quote.address) throw new Error('Incompatible discovered token pairs');
    return { ...pool, baseToken: pool.quoteToken, quoteToken: pool.baseToken,
      baseReserve: pool.quoteReserve, quoteReserve: pool.baseReserve,
      baseDecimals: pool.quoteDecimals, quoteDecimals: pool.baseDecimals };
  });
  for (const pool of pools) {
    if (pool.blockHash !== snapshot.blockHash || pool.blockNumber !== snapshot.blockNumber ||
        pool.baseToken !== pools[0].baseToken || pool.quoteToken !== quote.address ||
        !Number.isInteger(pool.baseDecimals) || pool.baseDecimals < 0 || pool.baseDecimals > 255 ||
        pool.quoteDecimals !== quote.decimals || pool.baseDecimals !== pools[0].baseDecimals ||
        typeof pool.baseReserve !== 'bigint' || pool.baseReserve <= 0n ||
        typeof pool.quoteReserve !== 'bigint' || pool.quoteReserve <= 0n) throw new Error('Invalid discovered market snapshot');
    result.prices.push({ venue: pool.venue, pool: pool.address, baseToken: pool.baseToken,
      quoteToken: quote.address, quoteReserve: pool.quoteReserve,
      // Exact human-unit quote/base ratio, no floating point or USD assumption.
      priceNumerator: pool.quoteReserve * 10n ** BigInt(pool.baseDecimals),
      priceDenominator: pool.baseReserve * 10n ** BigInt(pool.quoteDecimals) });
  }
  if (pools.length < 2) { result.reasons.push('NO_CROSS_VENUE_POOL'); return result; }
  result.research = compareMarkets({ ...snapshot, pools }, quote.input, nowMs);
  const sorted = [...result.prices].sort((a, b) => {
    const difference = a.priceNumerator * b.priceDenominator - b.priceNumerator * a.priceDenominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  });
  const low = sorted[0];
  const high = sorted.at(-1);
  const numerator = (high.priceNumerator * low.priceDenominator - low.priceNumerator * high.priceDenominator) * 10_000n;
  const denominator = low.priceNumerator * high.priceDenominator;
  result.spotGapBps = numerator / denominator;
  result.gapDetected = numerator >= BigInt(minGapBps) * denominator;
  result.reasons.push('SPOT_GAP_EXCLUDES_FEES_SIZE_AND_GAS');
  if (!result.gapDetected) result.reasons.push('GAP_BELOW_THRESHOLD');
  return result;
}
