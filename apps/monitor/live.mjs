import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createReadRpc, discoverSnapshots } from '../../packages/adapters/uniswap-v2.mjs';

const { values } = parseArgs({ options: { watch: { type: 'boolean', default: false },
  start: { type: 'string', default: '0' }, count: { type: 'string', default: '3' } } });
const rpc = createReadRpc({ url: process.env.MIR_PUBLIC_RPC_URL });
const directory = resolve('data/snapshots');
await mkdir(directory, { recursive: true });
let failed = false;
do {
  try {
    const snapshot = await discoverSnapshots(rpc, { startIndex: Number(values.start), count: Number(values.count) });
    const name = `${snapshot.blockNumber}-${snapshot.blockHash.slice(2)}-${snapshot.startIndex}-${snapshot.requestedCount}.json`;
    const destination = resolve(directory, name);
    const temporary = `${destination}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(snapshot, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n', { mode: 0o600 });
    await rename(temporary, destination);
    console.log(JSON.stringify({ status: 'snapshot-saved', mode: 'read-only', blockNumber: snapshot.blockNumber,
      pools: snapshot.pools.length, excluded: snapshot.excluded.length, qualifiedOpportunities: 0, file: destination }));
    failed = false;
  } catch (error) {
    // No provider URL, response body or credentials are logged.
    console.error(JSON.stringify({ status: 'source-unavailable', message: error.message }));
    failed = true;
  }
  if (values.watch) await delay(60_000);
} while (values.watch);
if (failed) process.exitCode = 1;
