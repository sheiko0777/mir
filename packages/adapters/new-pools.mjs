import { VENUES, factoryPairCount, collectPoolWindow, collectPairMarkets } from './uniswap-v2.mjs';
import { analyzeDiscoveredPair, QUOTE_TOKENS } from '../lxr/discovery.mjs';

const hashPattern = /^0x[0-9a-f]{64}$/i;
const quantity = value => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) throw new Error('Invalid block number');
  const number = Number(BigInt(value));
  if (!Number.isSafeInteger(number)) throw new Error('Block number too large');
  return number;
};

export async function scanNewPools(rpc, { state = null, limit = 2, minGapBps = 100, nowMs = Date.now() } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10 || !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Number.isSafeInteger(minGapBps) || minGapBps < 0 || minGapBps > 1_000_000) throw new Error('Invalid scanner settings');
  if (await rpc('eth_chainId') !== '0x1') throw new Error('Expected Ethereum mainnet');
  const header = await rpc('eth_getBlockByNumber', ['finalized', false]);
  if (!header || !hashPattern.test(header.hash)) throw new Error('Finalized block unavailable');
  const blockNumber = quantity(header.number);
  const blockTime = quantity(header.timestamp) * 1000;
  if (!Number.isSafeInteger(blockTime) || nowMs < blockTime || nowMs - blockTime > 1_800_000) throw new Error('Finalized block is stale or future');
  if (state) {
    if (state.schemaVersion !== 1 || state.chainId !== 1 || !Number.isSafeInteger(state.blockNumber) ||
        state.blockNumber < 0 || state.blockNumber > blockNumber || !hashPattern.test(state.blockHash) ||
        !state.offsets || !state.knownTokens || typeof state.knownTokens !== 'object' || Array.isArray(state.knownTokens) ||
        Object.values(VENUES).some(f => !Number.isSafeInteger(state.offsets[f]) || state.offsets[f] < 0)) {
      throw new Error('Invalid discovery checkpoint');
    }
    if (state.pendingPairs !== undefined && (!Array.isArray(state.pendingPairs) || state.pendingPairs.some(p =>
      !Array.isArray(p.tokens) || p.tokens.length !== 2 || p.tokens.some(t => !/^0x[0-9a-f]{40}$/.test(t)) ||
      p.tokens[0] === p.tokens[1] || !Number.isSafeInteger(p.firstObservedBlock) || p.firstObservedBlock < 0))) {
      throw new Error('Invalid pending pair checkpoint');
    }
    const checkpoint = await rpc('eth_getBlockByNumber', [`0x${state.blockNumber.toString(16)}`, false]);
    if (checkpoint?.hash !== state.blockHash) throw new Error('Discovery checkpoint is no longer canonical; explicit rescan required');
  }
  const next = { schemaVersion: 1, chainId: 1, blockNumber, blockHash: header.hash,
    offsets: { ...state?.offsets }, knownTokens: { ...state?.knownTokens } };
  const discoveries = [];
  const coverage = [];
  const analyzed = new Map();
  const pending = new Map((state?.pendingPairs ?? []).map(p => [p.tokens.join(':'), { ...p, tokens: [...p.tokens] }]));
  const followUps = [];
  const trackTokens = tokens => {
    const unseen = tokens.filter(t => !Object.hasOwn(next.knownTokens, t));
    for (const token of unseen) next.knownTokens[token] = { firstObservedBlock: blockNumber };
    return unseen;
  };
  const queue = tokens => {
    if (!tokens.some(token => QUOTE_TOKENS.some(q => q.address === token))) return;
    const key = tokens.join(':');
    if (!pending.has(key)) pending.set(key, { tokens, firstObservedBlock: blockNumber });
  };
  const inspect = async tokens => {
    const key = tokens.join(':');
    if (!analyzed.has(key)) {
      const markets = await collectPairMarkets(rpc, tokens, header, nowMs);
      analyzed.set(key, analyzeDiscoveredPair(markets, { minGapBps, nowMs }));
    }
    const analysis = analyzed.get(key);
    if (analysis.poolCount < 2) queue(tokens);
    else pending.delete(key);
    return analysis;
  };
  for (const [venue, factory] of Object.entries(VENUES)) {
    const total = await factoryPairCount(rpc, factory, header);
    const start = state ? state.offsets[factory] : Math.max(0, total - limit);
    if (start > total) throw new Error('Factory count decreased; explicit rescan required');
    const end = Math.min(total, start + limit);
    coverage.push({ venue, factory, total, fromIndex: start, toIndexExclusive: end,
      remaining: total - end, bootstrapSkipped: state ? 0 : start });
    if (end > start) {
      const window = await collectPoolWindow(rpc, { venue, startIndex: start, count: end - start, nowMs }, header);
      for (const empty of window.excluded) {
        const tokens = [empty.baseToken, empty.quoteToken];
        queue(tokens);
        discoveries.push({ id: `1:${factory}:${empty.address}`, venue, factory,
          ...empty, classification: state ? 'NEW_SINCE_CHECKPOINT' : 'BOOTSTRAP_RECENT_FACTORY_ENTRY',
          firstObservedLocally: trackTokens(tokens), status: 'unqualified', tokenAge: 'unknown',
          reasons: ['EMPTY_RESERVES', 'TOKEN_AGE_UNKNOWN'] });
      }
      for (const pool of window.pools) {
        const tokens = [pool.baseToken, pool.quoteToken];
        const firstObservedTokens = trackTokens(tokens);
        discoveries.push({ id: `1:${factory}:${pool.address}`, venue, factory, pool: pool.address,
          tokens, classification: state ? 'NEW_SINCE_CHECKPOINT' : 'BOOTSTRAP_RECENT_FACTORY_ENTRY',
          tokenAge: 'unknown', firstObservedLocally: firstObservedTokens, analysis: await inspect(tokens) });
      }
    }
    next.offsets[factory] = end;
  }
  // Revisit old empty/one-venue pairs in rotating bounded batches, even if no pool was created.
  for (const previous of (state?.pendingPairs ?? []).slice(0, limit)) {
    const key = previous.tokens.join(':');
    if (analyzed.has(key)) continue;
    pending.delete(key);
    const analysis = await inspect(previous.tokens);
    if (pending.has(key)) pending.set(key, { ...previous });
    followUps.push({ tokens: previous.tokens, firstObservedBlock: previous.firstObservedBlock, analysis });
  }
  next.pendingPairs = [...pending.values()];
  const finalHeader = await rpc('eth_getBlockByNumber', [header.number, false]);
  if (finalHeader?.hash !== header.hash) throw new Error('Canonical block changed during scan');
  return { state: next, report: { schemaVersion: 1, brand: 'WADJ', platform: 'MIR', engine: 'LXR',
    mode: 'read-only-new-pools', blockNumber, blockHash: header.hash, capturedAtMs: nowMs,
    finality: 'finalized', bootstrap: !state, qualifiedOpportunities: 0, coverage, discoveries,
    pendingPairCount: next.pendingPairs.length, followUps } };
}
