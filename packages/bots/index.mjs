import { createHash } from 'node:crypto';

export const BOT_DEFINITIONS = Object.freeze([
  { id: 'lxr-liquidity', name: 'LXR Liquidity', implementation: 'integrated-analysis',
    purpose: 'فحص سيولة البوولز ومقارنة أحجام المسارات',
    sources: ['https://github.com/Uniswap/v2-sdk'] },
  { id: 'carry-funding', name: 'Carry Research', implementation: 'integrated-analysis',
    purpose: 'بحث التمويل والتحوّط وتكاليف عمق السوق',
    sources: ['https://github.com/ccxt/ccxt'] },
  { id: 'kronos-forecast', name: 'Kronos Forecast', implementation: 'adapter-available',
    purpose: 'توليد مسارات أسعار واختبارها مقابل خط أساس',
    sources: ['https://github.com/shiyu-coder/Kronos'] },
  { id: 'prediction-markets', name: 'Prediction Markets', implementation: 'source-reviewed',
    purpose: 'بحث فروق تسعير أسواق التوقعات وتأخر البيانات',
    sources: ['https://github.com/Polymarket/ts-sdk', 'https://github.com/gregyoung14/openmarket'] }
]);

function task(botId, kind, evidenceIds, reasons, priority) {
  const identity = JSON.stringify([botId, kind, [...evidenceIds].sort()]);
  return { id: createHash('sha256').update(identity).digest('hex'), botId, kind,
    evidenceIds, reasons, priority, state: 'proposed', requiresLocalCommand: true };
}

// Inputs are recomputed by MIR's existing loaders before this planner is called.
export function planBotResearch(research, datasets, nowMs = Date.now()) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0 || !Array.isArray(datasets?.items) ||
      typeof research?.available !== 'boolean') throw new Error('Invalid bot research inputs');
  const tasks = [];
  const funding = datasets.items.filter(item => item.kind === 'funding-history');
  const markets = datasets.items.filter(item => item.kind === 'market-snapshot');
  const latestMarket = [...markets].sort((a, b) => b.capturedAtMs - a.capturedAtMs)[0];
  const researchIds = research.available ? [research.blockHash] : [];
  tasks.push(task('lxr-liquidity', research.available ? 'review-route-evidence' : 'collect-pinned-pools',
    researchIds, research.available ? ['TOKEN_TRANSFER_CHECKS_REQUIRED', 'COST_POLICY_AND_FRESHNESS_REVIEW'] :
      ['POOL_EVIDENCE_MISSING'], 1));
  tasks.push(task('carry-funding', latestMarket ? 'review-depth-and-hedge-identity' : 'collect-spot-perp-depth',
    latestMarket ? [latestMarket.id] : [], ['SYNCHRONIZED_PRICE_HISTORY_REQUIRED', 'COMPLETE_COST_PROVENANCE_REQUIRED'], 2));
  tasks.push(task('carry-funding', funding.length ? 'freeze-prospective-carry-policy' : 'collect-funding-history',
    funding.map(item => item.id), ['FUNDING_HISTORY_ALONE_CANNOT_ESTABLISH_RETURN', 'INDEPENDENT_HOLDOUT_REQUIRED'], 3));
  tasks.push(task('kronos-forecast', 'prepare-offline-model-and-context', [],
    ['PINNED_LOCAL_WEIGHTS_AND_RUNTIME_REQUIRED', 'TIMESTAMPED_FORECAST_AND_BASELINE_REQUIRED'], 4));
  tasks.push(task('prediction-markets', 'review-public-feed-adapter', [],
    ['FEED_ADAPTER_AND_CLOCK_ALIGNMENT_REQUIRED', 'SETTLEMENT_AND_DEPTH_MODEL_REQUIRED'], 5));
  const bots = BOT_DEFINITIONS.map(definition => {
    let evidence = [], reasons = [], status = 'awaiting-integration';
    if (definition.id === 'lxr-liquidity') {
      evidence = researchIds;
      status = research.available ? 'research-evidence-available' : 'awaiting-data';
      reasons = research.available ? ['TOKEN_TRANSFER_CHECKS_REQUIRED', 'INDEPENDENT_VALIDATION_REQUIRED'] : ['POOL_EVIDENCE_MISSING'];
    } else if (definition.id === 'carry-funding') {
      evidence = [...funding.map(item => item.id), ...(latestMarket ? [latestMarket.id] : [])];
      status = evidence.length ? 'research-evidence-available' : 'awaiting-data';
      reasons = ['SYNCHRONIZED_PRICE_HISTORY_REQUIRED', 'COMPLETE_COST_PROVENANCE_REQUIRED'];
    } else if (definition.id === 'kronos-forecast') {
      reasons = ['LOCAL_MODEL_RUN_AND_FORECAST_EVALUATION_PENDING'];
    } else {
      reasons = ['PUBLIC_FEED_INTEGRATION_PENDING'];
    }
    return { ...definition, mode: 'research', status, evidenceIds: evidence, reasons,
      qualified: false, netUsd: null, actualFills: 0 };
  });
  return { schemaVersion: 1, reviewedAtMs: nowMs, mode: 'read-only-multi-bot-lab',
    bots, tasks, qualifiedStrategies: 0, executionEnabled: false,
    evidence: { fundingDatasets: funding.length, marketDatasets: markets.length,
      latestMarketCapturedAtMs: latestMarket?.capturedAtMs ?? null,
      latestMarketAgeMs: latestMarket ? nowMs - latestMarket.capturedAtMs : null,
      poolResearchFreshness: research.freshness ?? 'unavailable' },
    reviewBudget: { maxTasks: 8, externalRequests: 0, networkActionsDispatched: 0 },
    policy: { capitalUsd: ['500', '5000', '50000'], carryDrawdownLimitBps: 500,
      newTokenDrawdownLimitBps: 1500, independentTestNetMustBePositive: true,
      doubleCostScenarioMustSurvive: true, minimumForwardDays: 30 } };
}
