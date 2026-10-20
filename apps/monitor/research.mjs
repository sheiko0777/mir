import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createReadRpc, collectWatchlist } from '../../packages/adapters/uniswap-v2.mjs';
import { watchlist } from '../../config/watchlist.mjs';
import { compareMarkets } from '../../packages/lxr/research.mjs';
import { compareSizes } from '../../packages/lxr/sizing.mjs';

try {
  const { values } = parseArgs({ options: { 'gas-units': { type: 'string' },
    'priority-fee-wei': { type: 'string' }, 'size-steps': { type: 'string', default: '8' },
    'buffer-bps': { type: 'string', default: '50' } } });
  const steps = Number(values['size-steps']);
  const bufferBps = Number(values['buffer-bps']);
  if (!Number.isInteger(steps) || steps < 1 || steps > 64 || !Number.isInteger(bufferBps) ||
      bufferBps < 0 || bufferBps > 10000) throw new Error('Invalid sizing policy');
  const atomicArgument = name => {
    if (values[name] === undefined) return null;
    if (!/^\d{1,78}$/.test(values[name])) throw new Error(`Invalid ${name}`);
    return BigInt(values[name]);
  };
  const gasUnits = atomicArgument('gas-units');
  const priorityFeeWei = atomicArgument('priority-fee-wei');
  if ((gasUnits === null) !== (priorityFeeWei === null) || gasUnits !== null &&
      (gasUnits <= 0n || gasUnits > 10000000n || priorityFeeWei >= 2n ** 256n)) throw new Error('Set both valid gas assumptions or neither');
  const rpc = createReadRpc({ url: process.env.MIR_PUBLIC_RPC_URL });
  const snapshot = await collectWatchlist(rpc, { tokens: watchlist.tokens });
  if (snapshot.pools.some(p => p.quoteDecimals !== watchlist.quoteDecimals)) throw new Error('Watchlist quote unit mismatch');
  const report = compareMarkets(snapshot, watchlist.inputQuote);
  const sizedReport = compareSizes(snapshot, { inputsQuote: Array.from({ length: steps },
    (_, i) => watchlist.inputQuote * BigInt(i + 1) / BigInt(steps)).filter(n => n > 0n),
    gasUnits, priorityFeeWei, bufferBps });
  const directory = resolve('data/research');
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, `${snapshot.blockNumber}-${snapshot.blockHash.slice(2)}-${snapshot.capturedAtMs}-${process.pid}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ watchlist: watchlist.name, snapshot, report, sizedReport },
    (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
  console.log(JSON.stringify({ status: 'research-saved', poolCount: report.poolCount,
    routeCount: report.routes.length, sizedCandidateCount: sizedReport.candidates.length,
    sizingStatus: sizedReport.status, gasScenarioAvailable: sizedReport.costScenario?.available ?? false,
    qualifiedOpportunities: 0, blockNumber: snapshot.blockNumber, file }));
} catch (error) {
  console.error(JSON.stringify({ status: 'research-unavailable', message: error.message }));
  process.exitCode = 1;
}
