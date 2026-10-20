import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createReadRpc } from '../../packages/adapters/uniswap-v2.mjs';
import { scanNewPools } from '../../packages/adapters/new-pools.mjs';

const { values } = parseArgs({ options: { watch: { type: 'boolean', default: false },
  limit: { type: 'string', default: '2' }, 'gap-bps': { type: 'string', default: '100' } } });
const directory = resolve('data/discovery');
const checkpointFile = resolve(directory, 'checkpoint.json');
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
await mkdir(directory, { recursive: true });
const rpc = createReadRpc({ url: process.env.MIR_PUBLIC_RPC_URL });
do {
  try {
    let previous = null;
    try {
      previous = JSON.parse(await readFile(checkpointFile, 'utf8')).state;
      if (!previous) throw new Error('Checkpoint state is missing');
    }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Checkpoint cannot be read'); }
    if (previous === undefined) throw new Error('Checkpoint state is missing');
    const result = await scanNewPools(rpc, { state: previous, limit: Number(values.limit), minGapBps: Number(values['gap-bps']) });
    const name = `${result.report.blockNumber}-${Date.now()}-${process.pid}.json`;
    const reportFile = resolve(directory, name);
    await writeFile(reportFile, json(result.report), { flag: 'wx', mode: 0o600 });
    const temporary = `${checkpointFile}.${process.pid}.tmp`;
    // A checkpoint commits only after the complete scan and report have succeeded.
    await writeFile(temporary, json({ state: result.state, lastReport: name }), { mode: 0o600 });
    await rename(temporary, checkpointFile);
    console.log(JSON.stringify({ status: 'discovery-saved', discoveredPools: result.report.discoveries.length,
      gapSignals: new Set([...result.report.discoveries, ...result.report.followUps]
        .filter(d => d.analysis?.gapDetected).map(d => d.tokens.join(':'))).size,
      pendingPairs: result.report.pendingPairCount, followUps: result.report.followUps.length,
      qualifiedOpportunities: 0, blockNumber: result.report.blockNumber, file: reportFile }));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({ status: 'discovery-unavailable', message: error.message }));
    process.exitCode = 1;
  }
  if (values.watch) await delay(60_000);
} while (values.watch);
