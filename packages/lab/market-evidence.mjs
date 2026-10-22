const integer = n => Number.isSafeInteger(n) && n >= 0;
const coinPattern = /^(?:[A-Z0-9]{1,20}|@[0-9]{1,6}|PURR\/USDC)$/;
const positive = value => typeof value === 'string' && /^\d{1,20}(?:\.\d{1,20})?$/.test(value) && /[1-9]/.test(value);
function validLevels(levels) {
  return Array.isArray(levels) && levels.length === 2 && levels.every(side =>
    Array.isArray(side) && side.length > 0 && side.length <= 20 && side.every(row => positive(row?.px) && positive(row?.sz)));
}
export function validateMarketDataset(dataset) {
  if (dataset?.schemaVersion !== 1 || dataset.kind !== 'market-snapshot' ||
      dataset.source !== 'https://api.hyperliquid.xyz/info' || dataset.adapter !== 'ccxt/4.5.89' ||
      !integer(dataset.capturedAtMs) || !Array.isArray(dataset.evidence) ||
      dataset.evidence.length < 1 || dataset.evidence.length > 20 ||
      !Array.isArray(dataset.markets) || dataset.markets.length > 8)
    throw new Error('Invalid market dataset');
  for (const market of dataset.markets) {
    if (!market || typeof market.id !== 'string' || market.id.length > 100 ||
        typeof market.symbol !== 'string' || market.symbol.length > 100 ||
        typeof market.spot !== 'boolean' || typeof market.swap !== 'boolean' || market.spot === market.swap)
      throw new Error('Invalid market identity metadata');
  }
  for (const record of dataset.evidence) {
    if (!integer(record.requestedAtMs) || !integer(record.capturedAtMs) ||
        record.requestedAtMs > record.capturedAtMs || record.capturedAtMs > dataset.capturedAtMs)
      throw new Error('Invalid market capture timestamps');
    const request = record.request;
    if (!request || typeof request !== 'object') throw new Error('Missing public request');
    const metadata = ['meta', 'spotMeta', 'metaAndAssetCtxs', 'spotMetaAndAssetCtxs'].includes(request.type) && Object.keys(request).length === 1;
    const book = request.type === 'l2Book' && Object.keys(request).length === 2 && coinPattern.test(request.coin);
    if (!metadata && !book) throw new Error('Unsupported market evidence request');
    if (record.error === undefined && record.response === undefined) throw new Error('Missing response or failure');
  }
  return dataset;
}
export function summarizeMarket(dataset) {
  validateMarketDataset(dataset);
  const books = dataset.evidence.filter(r => r.request.type === 'l2Book');
  const latencies = dataset.evidence.map(r => r.capturedAtMs - r.requestedAtMs).sort((a, b) => a - b);
  const percentile = p => latencies[Math.max(0, Math.ceil(latencies.length * p) - 1)];
  return { requests: dataset.evidence.length, latencyP50Ms: percentile(.5), latencyP95Ms: percentile(.95),
    books: books.map(record => {
      const response = record.response;
      let reason = null;
      if (record.error !== undefined) reason = 'SOURCE_REQUEST_FAILED';
      else if (response?.coin !== record.request.coin) reason = 'MARKET_IDENTITY_MISMATCH';
      else if (!integer(response.time) || response.time > record.capturedAtMs) reason = 'INVALID_SOURCE_TIME';
      else if (record.capturedAtMs - response.time > 5000) reason = 'STALE_SNAPSHOT';
      else if (!validLevels(response.levels)) reason = 'INVALID_DEPTH';
      return { coin: record.request.coin, sourceTimeMs: response?.time ?? null,
        capturedAtMs: record.capturedAtMs, ageMs: integer(response?.time) ? record.capturedAtMs - response.time : null,
        status: reason ? 'rejected' : 'capture-checks-passed', reason };
    }), qualified: false, netUsd: null,
    reasons: ['SEQUENTIAL_SNAPSHOTS_NOT_SYNCHRONIZED', 'HEDGE_IDENTITY_UNVERIFIED', 'COST_POLICY_MISSING', 'NO_HOLDOUT_OR_FORWARD_RESULT'] };
}
