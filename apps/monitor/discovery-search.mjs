import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createReadRpc } from '../../packages/adapters/uniswap-v2.mjs';
import { scanNewPools } from '../../packages/adapters/new-pools.mjs';
import { searchDiscoveredMarket } from '../../packages/lxr/discovery-search.mjs';

const { values } = parseArgs({ options: { limit: { type: 'string', default: '3' } } });
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('Limit must be 1..10 per factory');
const read = createReadRpc();
const started = Date.now();
let calls = 0;
const rpc = async (...args) => {
  if (++calls > 1000 || Date.now() - started > 180000) throw new Error('Research RPC/time budget exhausted');
  return read(...args);
};
try {
  // Independent one-shot sample: never advances discovery or paper checkpoints.
  const scan = await scanNewPools(rpc, { limit });
  const evaluatedAtMs = Date.now();
  const markets = scan.marketSnapshots.map(snapshot => ({ snapshot,
    analysis: searchDiscoveredMarket(snapshot, evaluatedAtMs) }));
  const report = { schemaVersion: 1, mode: 'bounded-discovery-size-research',
    discovery: scan.report, evaluatedAtMs, rpcCalls: calls, markets,
    qualifiedOpportunities: 0, actualFills: 0,
    limitations: ['Ethereum Uniswap V2 and Sushi V2 only; recent factory entries are not verified new tokens.',
      'One-shot bounded sample, not a complete market search or continuous monitor.',
      'Gas and buffer are assumptions; unknown token behavior and execution costs prevent qualification.',
      'USDC gas valuation remains unknown without a pinned conversion pool.'] };
  const directory = resolve('data/discovery-search');
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, `${scan.report.blockNumber}-${Date.now()}-${process.pid}.json`);
  await writeFile(file, JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2), { flag: 'wx' });
  console.log(JSON.stringify({ file, rpcCalls: calls, discoveries: scan.report.discoveries.length,
    pairs: markets.length, statuses: markets.map(m => m.analysis.status), qualified: 0, actualFills: 0 }));
} catch (error) {
  console.error(JSON.stringify({ status: 'research-unavailable', rpcCalls: calls, reason: error.message }));
  process.exitCode = 1;
}
