import { loadResearch } from './research.mjs';
import { labView } from '../../packages/lab/index.mjs';
import { planBotResearch } from '../../packages/bots/index.mjs';

export async function loadBots({ researchDirectory, labDirectory, nowMs = Date.now() }) {
  const [research, datasets] = await Promise.all([
    loadResearch(researchDirectory, nowMs), labView(labDirectory, 'datasets')
  ]);
  return planBotResearch(research, datasets, nowMs);
}
