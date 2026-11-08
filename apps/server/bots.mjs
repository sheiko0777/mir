import { loadResearch } from './research.mjs';
import { labView } from '../../packages/lab/index.mjs';
import { planBotResearch } from '../../packages/bots/index.mjs';
import { loadClaimBot } from './pooltogether.mjs';

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
  }
  return plan;
}
