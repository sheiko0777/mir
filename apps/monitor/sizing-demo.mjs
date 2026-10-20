import { fixturePools } from '../../packages/adapters/fixture.mjs';
import { WETH } from '../../packages/lxr/costs.mjs';
import { compareSizes } from '../../packages/lxr/sizing.mjs';

const nowMs = Date.now(), blockHash = `0x${'a'.repeat(64)}`;
const pools = fixturePools(nowMs).map((pool, i) => ({ ...pool, baseToken: WETH,
  baseDecimals: 18, quoteDecimals: 6, blockHash, finality: 'finalized',
  venue: `SYNTHETIC-${i + 1}`, tokenChecksPassed: null }));
const snapshot = { chainId: 1, blockNumber: 100, blockHash, capturedAtMs: nowMs,
  gas: { blockNumber: 100, blockHash, baseFeePerGasWei: 1000000000n }, pools };
const started = performance.now();
const result = compareSizes(snapshot, { inputsQuote: [100n, 1000n, 5000n, 10000n].map(n => n * 1000000n),
  gasUnits: 300000n, priorityFeeWei: 1000000000n, fxPool: pools[0], bufferBps: 50 }, nowMs);
console.log(JSON.stringify({ dataset: 'MOCK-SAMPLE-SYNTHETIC', quoteToken: pools[0].quoteToken,
  quoteDecimals: 6, units: 'invented quote token atomic units, not USD',
  processingMs: performance.now() - started, candidateCount: result.candidates.length,
  status: result.status, bestScenario: result.bestScenario, qualifiedOpportunities: 0,
  disclaimer: 'Illustrative scenario only; invented reserves, header and gas assumptions. No RPC or transactions.' },
  (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
