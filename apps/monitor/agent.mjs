import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { loadDiscovery } from '../server/reports.mjs';
import { loadResearch } from '../server/research.mjs';
import { planAgentCycle, emptyAgentState } from '../../packages/agent/index.mjs';

const { values } = parseArgs({ options: { watch: { type: 'boolean', default: false } } });
const directory = resolve('data/agent');
await mkdir(directory, { recursive: true });
const file = resolve(directory, 'journal.json');
const lockPath = resolve(directory, 'run.lock');
let lock;
try { lock = await open(lockPath, 'wx', 0o600); }
catch { throw new Error('Agent lock unavailable. Stop concurrent runs; inspect stale lock after a crash.'); }
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop); process.once('SIGTERM', stop);
try {
  do {
    const started = performance.now();
    let state = emptyAgentState(), history = [], researchState = emptyAgentState(), researchHistory = [];
    try {
      const info = await readFile(file, 'utf8');
      if (Buffer.byteLength(info) > 8 * 1024 * 1024) throw new Error('Journal exceeds limit');
      const journal = JSON.parse(info);
      if (!journal.state || !Array.isArray(journal.history) || journal.history.length > 256) throw new Error('Invalid agent journal');
      state = journal.state; history = journal.history;
      if (journal.researchState !== undefined) {
        if (!Array.isArray(journal.researchHistory) || journal.researchHistory.length > 256) throw new Error('Invalid research agent journal');
        researchState = journal.researchState; researchHistory = journal.researchHistory;
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const nowMs = Date.now();
    const view = await loadDiscovery(resolve('data/discovery'), nowMs);
    const research = await loadResearch(resolve('data/research'), nowMs);
    const result = planAgentCycle(view, state, { nowMs });
    const researchResult = planAgentCycle(research, researchState, { nowMs });
    result.report.processingMs = Math.round((performance.now() - started) * 1000) / 1000;
    const journal = { state: result.state, lastReport: result.report,
      history: [...history, ...result.report.decisions].slice(-256),
      researchState: researchResult.state, researchReport: researchResult.report,
      researchHistory: [...researchHistory, ...researchResult.report.decisions].slice(-256) };
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(journal, null, 2) + '\n', { mode: 0o600 });
    await rename(temporary, file);
    console.log(JSON.stringify({ ...result.report, research: researchResult.report }));
    if (!values.watch || controller.signal.aborted) break;
    try { await delay(Math.min(result.report.nextPollMs, researchResult.report.nextPollMs), undefined, { signal: controller.signal }); }
    catch (error) { if (error.name !== 'AbortError') throw error; }
  } while (!controller.signal.aborted);
} finally {
  process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  await lock.close(); await unlink(lockPath);
}
