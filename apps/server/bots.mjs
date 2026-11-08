import { loadResearch } from './research.mjs';
import { labView } from '../../packages/lab/index.mjs';
import { planBotResearch } from '../../packages/bots/index.mjs';
import { loadClaimBot } from './pooltogether.mjs';
import { createHash } from 'node:crypto';

export async function loadBots({ researchDirectory, labDirectory, claimDirectory, nowMs = Date.now() }) {
  const [research, datasets] = await Promise.all([
    loadResearch(researchDirectory, nowMs), labView(labDirectory, 'datasets')
  ]);
  const plan = planBotResearch(research, datasets, nowMs);
  if (claimDirectory) {
    const worker = await loadClaimBot(claimDirectory, nowMs);
    const bot = plan.bots.find(item => item.id === 'pooltogether-claimer');
    bot.worker = worker;
    bot.status = worker.available ? 'research-evidence-available' : 'awaiting-data';
    bot.evidenceIds = worker.evidenceId ? [worker.evidenceId] : [];
    bot.reasons = worker.available ? ['READ_ONLY_WATCHLIST', 'NO_EXECUTION_OR_NET_PROOF'] : ['PROTOCOL_SOURCE_OR_WATCHLIST_REQUIRED'];
    if (worker.illustrative === false && worker.viability?.checked && worker.viability.claimingAllowed === false) {
      bot.status = 'protocol-ineligible';
      bot.reasons = ['DEPLOYMENT_NOT_CLAIMABLE_AT_OBSERVED_BLOCK', 'SELECT_AND_VERIFY_ANOTHER_TARGET'];
      const next = plan.tasks.find(item => item.botId === bot.id);
      next.kind = 'select-active-protocol'; next.evidenceIds = [...bot.evidenceIds]; next.reasons = [...bot.reasons];
      next.id = createHash('sha256').update(JSON.stringify([bot.id, next.kind, next.evidenceIds])).digest('hex');
    }
  }
  return plan;
}
