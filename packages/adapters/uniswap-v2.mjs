import { setTimeout as delay } from 'node:timers/promises';

export const FACTORY = '0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f';
export const VENUES = Object.freeze({
  'uniswap-v2': FACTORY,
  'sushiswap-v2': '0xc0aee478e3658e2610c5f7a4a2e1777ce9e4f2ac'
});
export const PUBLIC_RPC = 'https://ethereum-rpc.publicnode.com';
const hashPattern = /^0x[0-9a-fA-F]{64}$/;
const addressPattern = /^0x[0-9a-fA-F]{40}$/;
const reads = new Map([
  ['0x574f2ba3', 10], ['0x1e3dd18b', 74], ['0xc45a0155', 10],
  ['0x0dfe1681', 10], ['0xd21220a7', 10], ['0x0902f1ac', 10],
  ['0x313ce567', 10], ['0xe6a43905', 138]
]);
const word = value => value.toString(16).padStart(64, '0');
const addressWord = value => value.slice(2).padStart(64, '0');
function quantity(value) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/.test(value)) throw new Error('Invalid RPC quantity');
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number)) throw new Error('RPC quantity too large');
  return number;
}
function words(value, count) {
  if (typeof value !== 'string' || !new RegExp(`^0x[0-9a-fA-F]{${64 * count}}$`).test(value)) throw new Error('Invalid ABI response');
  return Array.from({ length: count }, (_, i) => BigInt(`0x${value.slice(2 + i * 64, 66 + i * 64)}`));
}
function decodeAddress(value) {
  const [number] = words(value, 1);
  if (number === 0n || number >= 2n ** 160n) throw new Error('Invalid contract address');
  return `0x${number.toString(16).padStart(40, '0')}`;
}

export function createReadRpc({ url = PUBLIC_RPC, fetchImpl = fetch, pause = delay } = {}) {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('Use an HTTPS public RPC URL without credentials or query parameters');
  }
  let id = 0;
  return async (method, params = []) => {
    if (!['eth_chainId', 'eth_getBlockByNumber', 'eth_call'].includes(method)) throw new Error('RPC method is not read-only allowlisted');
    if (method === 'eth_call') {
      const [call, block] = params;
      if (!call || !addressPattern.test(call.to) || Object.keys(call).some(k => !['to', 'data'].includes(k)) ||
          typeof call.data !== 'string' || reads.get(call.data.slice(0, 10)) !== call.data.length ||
          !/^0x[0-9a-f]+$/i.test(call.data) || !hashPattern.test(block?.blockHash) || block.requireCanonical !== true) {
        throw new Error('Only pinned, allowlisted contract reads are permitted');
      }
    }
    const requestId = ++id;
    for (let attempt = 0; attempt < 3; attempt++) {
      await pause(attempt ? 250 * 2 ** attempt : 100);
      let response;
      try {
        response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
      } catch {
        if (attempt < 2) continue;
        throw new Error('RPC transport unavailable or timed out');
      }
      if ((response.status === 429 || response.status >= 500) && attempt < 2) continue;
      if (!response.ok) throw new Error(`RPC HTTP ${response.status}`);
      let payload;
      try { payload = await response.json(); } catch { throw new Error('Invalid RPC JSON'); }
      if (payload?.jsonrpc !== '2.0' || payload.id !== requestId || payload.error || !Object.hasOwn(payload, 'result')) {
        throw new Error('RPC response failed validation');
      }
      return payload.result;
    }
  };
}

async function collectSnapshots(rpc, { startIndex = 0, count = 3, nowMs = Date.now(),
  venue = 'uniswap-v2', tokens = null } = {}, pinnedHeader = null) {
  if (!Number.isSafeInteger(startIndex) || startIndex < 0 || !Number.isSafeInteger(count) || count < 1 || count > 10 ||
      !Number.isSafeInteger(startIndex + count) || !Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error('Invalid discovery window');
  if (!Object.hasOwn(VENUES, venue)) throw new Error('Unsupported venue');
  const factory = VENUES[venue];
  if (tokens && (!Array.isArray(tokens) || tokens.length !== 2 ||
      tokens.some(t => !addressPattern.test(t) || BigInt(t) === 0n) || tokens[0].toLowerCase() === tokens[1].toLowerCase())) {
    throw new Error('Invalid selected token pair');
  }
  if (quantity(await rpc('eth_chainId')) !== 1) throw new Error('Expected Ethereum mainnet');
  const header = pinnedHeader ?? await rpc('eth_getBlockByNumber', ['finalized', false]);
  if (!header || !hashPattern.test(header.hash)) throw new Error('Finalized block unavailable');
  const blockNumber = quantity(header.number);
  const observedAtMs = quantity(header.timestamp) * 1000;
  if (!Number.isSafeInteger(observedAtMs) || nowMs - observedAtMs < 0 || nowMs - observedAtMs > 30 * 60_000) {
    throw new Error('Finalized block timestamp is stale or in the future');
  }
  const pin = { blockHash: header.hash, requireCanonical: true };
  const call = (to, data) => rpc('eth_call', [{ to, data }, pin]);
  const [totalPairs] = words(await call(factory, '0x574f2ba3'), 1);
  const pools = [];
  const excluded = [];
  const selected = tokens ? await call(factory, `0xe6a43905${tokens.map(addressWord).join('')}`) : null;
  if (selected && words(selected, 1)[0] === 0n) excluded.push({ venue, reason: 'PAIR_NOT_FOUND' });
  for (let i = startIndex; tokens ? (i === startIndex && excluded.length === 0) : (BigInt(i) < totalPairs && i < startIndex + count); i++) {
    const address = decodeAddress(selected ?? await call(factory, `0x1e3dd18b${word(BigInt(i))}`));
    if (decodeAddress(await call(address, '0xc45a0155')) !== factory) throw new Error('Pool factory mismatch');
    const baseToken = decodeAddress(await call(address, '0x0dfe1681'));
    const quoteToken = decodeAddress(await call(address, '0xd21220a7'));
    if (BigInt(baseToken) >= BigInt(quoteToken)) throw new Error('Invalid token ordering');
    if (tokens && ![baseToken, quoteToken].every(t => tokens.some(selectedToken => selectedToken.toLowerCase() === t))) throw new Error('Selected token mismatch');
    if (decodeAddress(await call(factory, `0xe6a43905${addressWord(baseToken)}${addressWord(quoteToken)}`)) !== address) {
      throw new Error('Factory pair lookup mismatch');
    }
    const [baseReserve, quoteReserve, reserveTimestamp] = words(await call(address, '0x0902f1ac'), 3);
    if (baseReserve >= 2n ** 112n || quoteReserve >= 2n ** 112n || reserveTimestamp >= 2n ** 32n) throw new Error('Invalid reserve widths');
    if (!baseReserve || !quoteReserve) { excluded.push({ address, baseToken, quoteToken, reason: 'EMPTY_RESERVES' }); continue; }
    const [baseDecimals] = words(await call(baseToken, '0x313ce567'), 1);
    const [quoteDecimals] = words(await call(quoteToken, '0x313ce567'), 1);
    if (baseDecimals > 255n || quoteDecimals > 255n) throw new Error('Invalid token decimals');
    pools.push({ chainId: 1, address, factory, venue, model: 'constant-product', baseToken, quoteToken,
      baseDecimals: Number(baseDecimals), quoteDecimals: Number(quoteDecimals), baseReserve, quoteReserve,
      reserveTimestamp: Number(reserveTimestamp), feeBps: 30, blockNumber, blockHash: header.hash,
      observedAtMs, capturedAtMs: nowMs, finality: 'finalized', tokenChecksPassed: null,
      riskReasons: ['TOKEN_CHECKS_UNKNOWN', 'GAS_VALUATION_UNAVAILABLE'], source: `ethereum-${venue}-rpc` });
  }
  const confirmed = await rpc('eth_getBlockByNumber', [header.number, false]);
  if (!confirmed || confirmed.hash !== header.hash) throw new Error('Canonical block changed during collection');
  return { schemaVersion: 1, mode: 'read-only', chainId: 1, factory, venue,
    blockNumber, blockHash: header.hash, observedAtMs, capturedAtMs: nowMs,
    startIndex, requestedCount: count, totalPairs: totalPairs.toString(), pools, excluded };
}

export async function discoverSnapshots(rpc, options) {
  return collectSnapshots(rpc, options);
}

export async function collectWatchlist(rpc, { tokens, nowMs = Date.now() } = {}) {
  if (!tokens) throw new Error('Selected token pair required');
  const header = await rpc('eth_getBlockByNumber', ['finalized', false]);
  if (!header || !hashPattern.test(header.hash)) throw new Error('Finalized block unavailable');
  return collectPairMarkets(rpc, tokens, header, nowMs);
}

export async function collectPairMarkets(rpc, tokens, header, nowMs) {
  if (!header || !hashPattern.test(header.hash)) throw new Error('Pinned block unavailable');
  const markets = [];
  for (const venue of Object.keys(VENUES)) {
    markets.push(await collectSnapshots(rpc, { tokens, nowMs, count: 1, venue }, header));
  }
  const confirmed = await rpc('eth_getBlockByNumber', [header.number, false]);
  if (confirmed?.hash !== header.hash) throw new Error('Canonical block changed across venues');
  return { schemaVersion: 1, mode: 'read-only', blockNumber: markets[0].blockNumber,
    blockHash: header.hash, capturedAtMs: nowMs,
    pools: markets.flatMap(m => m.pools), excluded: markets.flatMap(m => m.excluded) };
}

// Used by bounded factory discovery; all contract reads still require a canonical hash.
export async function collectPoolWindow(rpc, options, header) {
  if (!header || !hashPattern.test(header.hash)) throw new Error('Pinned block unavailable');
  return collectSnapshots(rpc, options, header);
}

export async function factoryPairCount(rpc, factory, header) {
  if (!Object.values(VENUES).includes(factory) || !hashPattern.test(header?.hash)) throw new Error('Invalid factory count request');
  const value = await rpc('eth_call', [{ to: factory, data: '0x574f2ba3' }, { blockHash: header.hash, requireCanonical: true }]);
  const [count] = words(value, 1);
  if (count > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Factory count too large');
  return Number(count);
}
