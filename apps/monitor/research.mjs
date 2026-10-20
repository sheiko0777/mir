import { mkdir, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createReadRpc, collectWatchlist } from '../../packages/adapters/uniswap-v2.mjs';
import { watchlist } from '../../config/watchlist.mjs';
import { compareMarkets } from '../../packages/lxr/research.mjs';

try {
  const rpc = createReadRpc({ url: process.env.MIR_PUBLIC_RPC_URL });
  const snapshot = await collectWatchlist(rpc, { tokens: watchlist.tokens });
  if (snapshot.pools.some(p => p.quoteDecimals !== watchlist.quoteDecimals)) throw new Error('Watchlist quote unit mismatch');
  const report = compareMarkets(snapshot, watchlist.inputQuote);
  const directory = resolve('data/research');
  await mkdir(directory, { recursive: true });
  const file = resolve(directory, `${snapshot.blockNumber}-${snapshot.blockHash.slice(2)}.json`);
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify({ watchlist: watchlist.name, snapshot, report },
    (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
  console.log(JSON.stringify({ status: 'research-saved', poolCount: report.poolCount,
    routeCount: report.routes.length, qualifiedOpportunities: 0, blockNumber: snapshot.blockNumber, file }));
} catch (error) {
  console.error(JSON.stringify({ status: 'research-unavailable', message: error.message }));
  process.exitCode = 1;
}
