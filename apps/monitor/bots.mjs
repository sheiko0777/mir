import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { loadBots } from '../server/bots.mjs';

if (process.argv.length !== 2) throw new Error('Usage: npm run bots:review');
const report = await loadBots({ researchDirectory: resolve('data/research'), labDirectory: resolve('data/lab') });
const encoded = JSON.stringify(report, null, 2) + '\n';
const id = createHash('sha256').update(encoded).digest('hex');
const folder = resolve('data/bots/reviews');
await mkdir(folder, { recursive: true });
const file = join(folder, `${id}.json`);
try { await writeFile(file, encoded, { flag: 'wx' }); }
catch (error) { if (error.code !== 'EEXIST' || await readFile(file, 'utf8') !== encoded) throw error; }
console.log(JSON.stringify({ file, tasks: report.tasks.length, bots: report.bots,
  mode: report.mode, qualifiedStrategies: 0, executionEnabled: false }));
