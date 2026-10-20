import { fixturePools } from '../../packages/adapters/fixture.mjs';
import { assessRoute } from '../../packages/lxr/index.mjs';
import { PaperLedger } from '../../packages/paper/index.mjs';

const nowMs = Date.now();
const pools = fixturePools(nowMs);
const policy = { nowMs, maxAgeMs: 30_000, maxBlockLag: 0, maxInputBps: 100, minNetQuote: 1_000_000n };
const costs = { gasQuote: 2_000_000n, bufferQuote: 1_000_000n };
const ledger = new PaperLedger(10_000n * 10n ** 6n);
const routes = [[pools[0], pools[1]], [pools[1], pools[0]]].map(([buy, sell], i) => {
  const result = assessRoute(buy, sell, 1_000n * 10n ** 6n, costs, policy);
  return { id: `fixture-route-${i}`, buy: buy.address, sell: sell.address, ...result };
});
// Evaluate both directions, then record at most one route from this snapshot.
const best = routes.filter(r => r.eligible).sort((a, b) => a.netQuote > b.netQuote ? -1 : 1)[0];
if (best) ledger.record(best.id, best);
console.log(JSON.stringify({ brand: 'WADJ', platform: 'MIR', engine: 'LXR',
  tentativeDomain: 'mir.wadj.online', source: 'SYNTHETIC — NOT LIVE',
  quoteDecimals: 6, routes, paperEntries: ledger.entries, paperBalanceQuote: ledger.balanceQuote
}, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
