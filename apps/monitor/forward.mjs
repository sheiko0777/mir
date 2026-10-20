import { mkdir, open, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readJson } from '../server/reports.mjs';
import { loadResearchArchive } from '../server/research.mjs';
import { emptyForwardJournal, advanceForward, summarizeForward } from '../../packages/paper/forward.mjs';

// One local cycle; no RPC collection, wallet or transaction simulation is started.
const directory = resolve('data/forward');
await mkdir(directory, { recursive: true });
const lockPath = resolve(directory, 'run.lock');
const lock = await open(lockPath, 'wx', 0o600);
try {
  let journal;
  try { journal = await readJson(resolve(directory, 'journal.json'), directory); }
  catch (error) { if (error.code !== 'ENOENT') throw error; journal = emptyForwardJournal(); }
  const archive = await loadResearchArchive(resolve('data/research'));
  const result = advanceForward(journal, archive);
  const report = summarizeForward(result.journal);
  const content = JSON.stringify(result.journal, null, 2) + '\n';
  if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error('Forward journal exceeds limit');
  const temporary = resolve(directory, `journal.${process.pid}.tmp`);
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, resolve(directory, 'journal.json'));
  console.log(JSON.stringify({ ...report, actions: result.actions, reason: result.reason }));
} finally { await lock.close(); await unlink(lockPath); }
