import { compareMarkets } from './research.mjs';
import { gasScenario, ceilDiv } from './costs.mjs';

const blocked = new Set(['STALE_OR_FUTURE_SNAPSHOT', 'BUY_SIZE_LIMIT', 'SELL_SIZE_LIMIT',
  'DUST_OUTPUT', 'FINALITY_UNVERIFIED', 'SCENARIO_BUDGET_EXCEEDED', 'STALE_OR_FUTURE_CAPTURE']);

export function compareSizes(snapshot, { inputsQuote, gasUnits = null, priorityFeeWei = null,
  baseFeeFactorBps = 10000, fxPool = null, bufferBps = 50, budgetQuote = null,
  minNetQuote = 0n } = {}, nowMs = Date.now()) {
  if (!snapshot || snapshot.chainId !== 1 || !Number.isSafeInteger(snapshot.blockNumber) || snapshot.blockNumber < 0 ||
      !/^0x[0-9a-f]{64}$/.test(snapshot.blockHash) ||
      !Number.isSafeInteger(snapshot.capturedAtMs) || snapshot.capturedAtMs < 0 ||
      !Number.isSafeInteger(nowMs) || nowMs < 0 ||
      !Array.isArray(inputsQuote) || !inputsQuote.length || inputsQuote.length > 64 ||
      inputsQuote.some(x => typeof x !== 'bigint' || x <= 0n || x >= 2n ** 256n) ||
      !Number.isInteger(bufferBps) || bufferBps < 0 || bufferBps > 10000 ||
      typeof minNetQuote !== 'bigint' || minNetQuote < 0n ||
      budgetQuote !== null && (typeof budgetQuote !== 'bigint' || budgetQuote <= 0n)) throw new Error('Invalid size search policy');
  const inputs = [...new Set(inputsQuote)].sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  // Reuse validated LXR quote/risk behavior; no RPC is performed during the search.
  const reports = inputs.map(input => compareMarkets(snapshot, input, nowMs));
  const first = snapshot.pools[0];
  const cost = first ? gasScenario(snapshot, { quoteToken: first.quoteToken, quoteDecimals: first.quoteDecimals,
    gasUnits, priorityFeeWei, baseFeeFactorBps, fxPool }) : null;
  const candidates = reports.flatMap(report => report.routes.map(route => {
    const reasons = route.reasons.filter(r => !cost?.available || !['GAS_VALUATION_UNAVAILABLE', 'UNCERTAINTY_BUFFER_UNSET'].includes(r));
    if (nowMs < snapshot.capturedAtMs || nowMs - snapshot.capturedAtMs > 1800000) reasons.push('STALE_OR_FUTURE_CAPTURE');
    const bufferQuote = ceilDiv(route.inputQuote * BigInt(bufferBps), 10000n);
    const scenarioNetQuote = cost?.available ? route.grossAfterPoolFeesQuote - cost.gasQuote - bufferQuote : null;
    if (cost?.available) reasons.push(...cost.reasons, 'BUFFER_POLICY_ASSUMED');
    if (scenarioNetQuote !== null && scenarioNetQuote <= minNetQuote) reasons.push('SCENARIO_NET_BELOW_THRESHOLD');
    if (budgetQuote !== null && (cost?.available ? route.inputQuote + cost.gasQuote + bufferQuote > budgetQuote :
      route.inputQuote > budgetQuote)) reasons.push('SCENARIO_BUDGET_EXCEEDED');
    return { ...route, gasQuoteScenario: cost?.gasQuote ?? null, bufferQuoteScenario: bufferQuote,
      scenarioNetQuote, netQuote: null, qualified: false, status: 'unqualified',
      reasons: [...new Set(reasons)], withinResearchConstraints: !reasons.some(r => blocked.has(r)) };
  }));
  const ranked = candidates.filter(c => c.scenarioNetQuote !== null && c.withinResearchConstraints)
    .sort((a, b) => a.scenarioNetQuote === b.scenarioNetQuote ?
      a.inputQuote < b.inputQuote ? -1 : a.inputQuote > b.inputQuote ? 1 :
        `${a.buyPool}:${a.sellPool}`.localeCompare(`${b.buyPool}:${b.sellPool}`) :
      a.scenarioNetQuote > b.scenarioNetQuote ? -1 : 1);
  const bestScenario = ranked[0] ?? null;
  return { schemaVersion: 1, platform: 'MIR', engine: 'LXR', mode: 'costed-size-research',
    blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash, capturedAtMs: snapshot.capturedAtMs,
    evaluatedAtMs: nowMs, qualifiedOpportunities: 0, netProfitKnown: false, paperFills: 0,
    quoteToken: first?.quoteToken ?? null, quoteDecimals: first?.quoteDecimals ?? null,
    policy: { strategy: 'explicit-grid-not-global-optimization', inputsQuote: inputs, bufferBps,
      budgetQuote, minNetQuote, maxInputBps: 100, maximumQuoteEvaluations: 64 * 10 * 9 },
    costScenario: cost, candidates, bestScenario,
    status: !bestScenario ? 'no-costed-candidate' : bestScenario.scenarioNetQuote > minNetQuote ?
      'positive-under-assumptions' : 'no-positive-scenario',
    limitations: ['Historical scenario, not an executable opportunity or realized profit.',
      'Best means best of this bounded input grid, not a global optimum.',
      'Gas units and priority fee are assumptions; no transaction simulation or inclusion check.',
      'Token behavior, MEV, failed attempts, approvals and future state remain unmodeled.'] };
}
