import { QUOTE_TOKENS, analyzeDiscoveredPair } from './discovery.mjs';
import { compareSizes } from './sizing.mjs';

// Research only: retain unsuccessful pairs and never treat unknown costs as zero.
export function searchDiscoveredMarket(snapshot, nowMs = Date.now()) {
  const discovery = analyzeDiscoveredPair(snapshot, { nowMs });
  const first = snapshot.pools[0];
  const quote = QUOTE_TOKENS.find(q => first && [first.baseToken, first.quoteToken].includes(q.address));
  if (!quote || snapshot.pools.length < 2) return { discovery, sizing: null,
    status: !quote ? 'unsupported-or-empty-pair' : 'missing-second-venue' };
  const pools = snapshot.pools.map(pool => pool.quoteToken === quote.address ? { ...pool } : {
    ...pool, baseToken: pool.quoteToken, quoteToken: pool.baseToken,
    baseReserve: pool.quoteReserve, quoteReserve: pool.baseReserve,
    baseDecimals: pool.quoteDecimals, quoteDecimals: pool.baseDecimals,
  });
  const inputsQuote = [1n, 2n, 4n, 8n, 16n, 32n, 64n, 128n].map(n => quote.input * n / 8n);
  const sizing = compareSizes({ ...snapshot, pools }, { inputsQuote,
    gasUnits: 300000n, priorityFeeWei: 1000000000n, bufferBps: 50 }, nowMs);
  return { discovery, sizing, status: sizing.status };
}
