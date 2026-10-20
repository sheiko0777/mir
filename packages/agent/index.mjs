import { createHash } from 'node:crypto';

const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const atomic = value => typeof value === 'string' && /^(0|[1-9]\d{0,77})$/.test(value);
function validateSizing(view) {
  const s = view.sizing;
  if (view.dataset !== 'saved-research') {
    if (s != null) throw new Error('Research evidence cannot be attached to a discovery block');
    return null;
  }
  if (s === null && !view.observations.length) return null;
  if (!s || s.blockHash !== view.blockHash || s.blockNumber !== view.blockNumber ||
      !address.test(s.quoteToken) || !Number.isInteger(s.quoteDecimals) || s.quoteDecimals < 0 || s.quoteDecimals > 255 ||
      !integer(s.candidateCount) || s.candidateCount > 5760 || typeof s.costAvailable !== 'boolean' ||
      !atomic(s.minNetQuote) || typeof s.aboveThreshold !== 'boolean' ||
      !Array.isArray(s.reasons) || s.reasons.some(r => typeof r !== 'string' || !/^[A-Z_]{1,80}$/.test(r)) ||
      !(s.bestInputQuote === null && s.bestScenarioNetQuote === null || atomic(s.bestInputQuote) && BigInt(s.bestInputQuote) > 0n &&
        typeof s.bestScenarioNetQuote === 'string' && /^-?(0|[1-9]\d{0,127})$/.test(s.bestScenarioNetQuote)) ||
      !s.costAvailable && s.bestScenarioNetQuote !== null ||
      s.aboveThreshold !== (s.bestScenarioNetQuote !== null && BigInt(s.bestScenarioNetQuote) > BigInt(s.minNetQuote)) ||
      view.observations.some(o => s.pair !== `1:${[...o.tokens].sort().join(':')}` || !o.tokens.includes(s.quoteToken))) {
    throw new Error('Invalid agent sizing evidence');
  }
  return s;
}
export const emptyAgentState = () => ({ schemaVersion: 1, cycles: 0, decisions: 0,
  lastBlockNumber: null, lastBlockHash: null, seen: [] });

// Auditable rules-based planner. No LLM, signer or transaction transport is implied.
export function planAgentCycle(view, state = emptyAgentState(), { nowMs = Date.now(), maxDecisions = 20 } = {}) {
  if (!integer(nowMs) || !Number.isInteger(maxDecisions) || maxDecisions < 1 || maxDecisions > 100 ||
      state?.schemaVersion !== 1 || !integer(state.cycles) || !integer(state.decisions) ||
      !Array.isArray(state.seen) || state.seen.length > 2048 || state.seen.some(id => !/^[a-f0-9]{64}$/.test(id)) ||
      !(state.lastBlockNumber === null && state.lastBlockHash === null || integer(state.lastBlockNumber) && hash.test(state.lastBlockHash))) {
    throw new Error('Invalid agent policy or memory');
  }
  const next = { ...state, seen: [...state.seen], cycles: state.cycles + 1 };
  const report = { schemaVersion: 1, platform: 'MIR', engine: 'LXR', agent: 'evidence-planner-v1',
    mode: 'read-only-agent', evaluatedAtMs: nowMs, available: view?.available === true,
    status: 'waiting-for-data', decisions: [], qualifiedOpportunities: 0, paperFills: 0,
    netProfitKnown: false, nextPollMs: 120000, reasons: [], capabilities: [
      'saved-pool-observations', 'price-gap-triage', 'risk-evidence-planning', 'durable-deduplication'
    ] };
  if (!view || typeof view.available !== 'boolean') throw new Error('Invalid observation envelope');
  if (!view.available) { report.reasons.push(view.dataset === 'saved-research' ? 'RESEARCH_UNAVAILABLE' : 'DISCOVERY_UNAVAILABLE'); return { state: next, report }; }
  if (!['saved-onchain', 'saved-research'].includes(view.dataset) || !integer(view.blockNumber) || !hash.test(view.blockHash) ||
      !integer(view.capturedAtMs) || !Array.isArray(view.observations) || view.observations.length > 200 ||
      view.finality !== 'finalized') throw new Error('Invalid agent observations');
  report.source = { dataset: view.dataset, blockNumber: view.blockNumber, blockHash: view.blockHash, capturedAtMs: view.capturedAtMs };
  if (state.lastBlockNumber !== null && (view.blockNumber < state.lastBlockNumber ||
      view.blockNumber === state.lastBlockNumber && view.blockHash !== state.lastBlockHash)) {
    report.status = 'blocked'; report.reasons.push('BLOCK_REGRESSION_OR_HASH_CONFLICT'); return { state: next, report };
  }
  const age = nowMs - view.capturedAtMs;
  if (age < 0 || age > 30 * 60000) {
    report.status = 'blocked'; report.reasons.push('STALE_OR_FUTURE_CAPTURE'); return { state: next, report };
  }
  const pairs = new Map();
  for (const item of view.observations) {
    if (item.chainId !== 1 || !address.test(item.pool) || !Array.isArray(item.tokens) || item.tokens.length !== 2 ||
        item.tokens.some(t => !address.test(t)) || item.tokens[0] === item.tokens[1] ||
        item.blockNumber !== view.blockNumber || item.blockHash !== view.blockHash || item.capturedAtMs !== view.capturedAtMs ||
        !Array.isArray(item.reasons) || item.reasons.some(r => typeof r !== 'string' || !/^[A-Z_]{1,80}$/.test(r)) ||
        item.spotGapBps !== null && (typeof item.spotGapBps !== 'string' || !/^\d{1,512}$/.test(item.spotGapBps))) {
      throw new Error('Invalid agent observation');
    }
    const tokens = [...item.tokens].sort();
    const key = `1:${tokens.join(':')}`;
    const pair = pairs.get(key) ?? { pair: key, tokens, pools: new Set(), reasons: new Set(), gapBps: null };
    pair.pools.add(item.pool);
    item.reasons.forEach(reason => pair.reasons.add(reason));
    if (item.spotGapBps !== null && (pair.gapBps === null || BigInt(item.spotGapBps) > BigInt(pair.gapBps))) pair.gapBps = item.spotGapBps;
    pairs.set(key, pair);
  }
  const sizingEvidence = validateSizing(view);
  if (view.dataset === 'saved-research') report.capabilities.push('costed-size-triage');
  const candidates = [...pairs.values()].map(pair => {
    // Rank evidence collection, never financial confidence; unknown costs always block qualification.
    const crossVenue = pair.gapBps !== null && !pair.reasons.has('NO_CROSS_VENUE_POOL');
    let tasks = pair.reasons.has('EMPTY_RESERVES') ? ['WAIT_FOR_LIQUIDITY'] :
      !crossVenue ? ['FIND_SECOND_VENUE'] : ['CHECK_TOKEN_BEHAVIOR', 'VALUE_GAS', 'REPLAY_SIZED_QUOTES'];
    let score = pair.reasons.has('EMPTY_RESERVES') ? 0 : crossVenue ?
      pair.gapBps !== null && BigInt(pair.gapBps) >= 100n ? 3 : 2 : 1;
    const reasons = [...new Set([...pair.reasons, 'TOKEN_CHECKS_UNKNOWN', 'GAS_VALUATION_UNAVAILABLE', 'NET_PROFIT_UNKNOWN'])].sort();
    const sizing = sizingEvidence;
    if (sizing) {
      tasks = !sizing.costAvailable ? ['VALUE_GAS', 'REPLAY_SIZED_QUOTES'] : sizing.bestScenarioNetQuote === null ?
        ['REVIEW_SIZE_CONSTRAINTS', 'REFRESH_RESEARCH'] : sizing.aboveThreshold ?
          ['CHECK_TOKEN_BEHAVIOR', 'VALIDATE_GAS_ASSUMPTIONS', 'PAPER_REPLAY_REQUIRED'] :
          ['REVIEW_COST_ASSUMPTIONS', 'REFRESH_RESEARCH'];
      score = sizing.aboveThreshold ? 3 : sizing.costAvailable ? 0 : 1;
      if (sizing.costAvailable) reasons.splice(reasons.indexOf('GAS_VALUATION_UNAVAILABLE'), 1);
      reasons.push(...sizing.reasons, 'SCENARIO_IS_NOT_ACTUAL_NET');
    }
    const decision = { pair: pair.pair, tokens: pair.tokens, pools: [...pair.pools].sort(),
      spotGapBps: pair.gapBps, priority: score, tasks, reasons: [...new Set(reasons)].sort(), qualified: false,
      ...(sizing ? { sizing } : {}),
      netQuote: null, action: 'COLLECT_EVIDENCE', blockNumber: view.blockNumber, blockHash: view.blockHash };
    const id = createHash('sha256').update(JSON.stringify(decision)).digest('hex');
    return { id, ...decision };
  }).sort((a, b) => b.priority - a.priority || a.pair.localeCompare(b.pair));
  const seen = new Set(state.seen);
  const unseen = candidates.filter(candidate => !seen.has(candidate.id));
  report.decisions = unseen.slice(0, maxDecisions);
  report.deferredDecisions = Math.max(0, unseen.length - maxDecisions);
  report.duplicateDecisions = candidates.length - unseen.length;
  report.status = report.decisions.length ? 'evidence-required' : 'observing';
  report.nextPollMs = candidates.some(c => c.priority === 3) ? 15000 : 60000;
  report.reasons.push('CAPTURE_TIME_IS_NOT_MARKET_FRESHNESS', 'RULES_BASED_PLANNER');
  next.lastBlockNumber = view.blockNumber; next.lastBlockHash = view.blockHash;
  next.decisions += report.decisions.length;
  next.seen = [...state.seen, ...report.decisions.map(d => d.id)].slice(-2048);
  return { state: next, report };
}
