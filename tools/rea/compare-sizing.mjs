import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareSizes } from '../../packages/lxr/sizing.mjs';
import { WETH } from '../../packages/lxr/costs.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(new URL('./reference/package.json', import.meta.url));
const sdkEntry = require.resolve('@uniswap/v2-sdk');
const sdkRequire = createRequire(sdkEntry);
const { Pair } = require('@uniswap/v2-sdk');
const { Token, CurrencyAmount } = sdkRequire('@uniswap/sdk-core');
let sdkVersion;
for (let dir = dirname(sdkEntry); ; dir = dirname(dir)) {
  try { const pkg = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
    if (pkg.name === '@uniswap/v2-sdk') { sdkVersion = pkg.version; break; }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (dirname(dir) === dir) throw new Error('SDK metadata missing');
}
if (sdkVersion !== '4.21.5') throw new Error('Unexpected SDK version');
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const hash = `0x${'a'.repeat(64)}`, nowMs = 100000;
function sdkOut(pool, input, fromBase) {
  const base = new Token(1, pool.baseToken, pool.baseDecimals);
  const quote = new Token(1, pool.quoteToken, pool.quoteDecimals);
  const pair = new Pair(CurrencyAmount.fromRawAmount(base, pool.baseReserve.toString()),
    CurrencyAmount.fromRawAmount(quote, pool.quoteReserve.toString()));
  try { return BigInt(pair.getOutputAmount(CurrencyAmount.fromRawAmount(fromBase ? base : quote,
    input.toString()), false)[0].quotient.toString()); }
  catch (error) { if (error.isInsufficientInputAmountError === true) return 0n; throw error; }
}
const cases = [], failures = [];
for (const quoteNative of [true, false]) for (let variant = 0; variant < 4; variant++) {
  const quoteDecimals = quoteNative ? 18 : 6;
  const quoteUnit = 10n ** BigInt(quoteDecimals);
  const baseReserve = quoteNative ? 1000000n * 1000000n : 1000n * 10n ** 18n;
  const quoteReserve = (quoteNative ? 1000n : 1000000n) * quoteUnit;
  const common = { chainId: 1, baseToken: quoteNative ? usdc : WETH, quoteToken: quoteNative ? WETH : usdc,
    baseDecimals: quoteNative ? 6 : 18, quoteDecimals, baseReserve, quoteReserve,
    model: 'constant-product', feeBps: 30, blockNumber: 100, blockHash: hash,
    observedAtMs: nowMs, finality: 'finalized', tokenChecksPassed: null, source: 'SYNTHETIC-ONLY' };
  const pools = [{ ...common, address: `0x${'1'.repeat(40)}`, venue: 'synthetic-a' },
    { ...common, address: `0x${'2'.repeat(40)}`, venue: 'synthetic-b',
      quoteReserve: quoteReserve * BigInt(100 + variant) / 100n }];
  const snapshot = { chainId: 1, blockNumber: 100, blockHash: hash, capturedAtMs: nowMs,
    gas: { blockNumber: 100, blockHash: hash, baseFeePerGasWei: 1000000000n }, pools };
  const nominal = (quoteNative ? 1n : 1000n) * quoteUnit;
  const inputsQuote = [1n, nominal / 1000n, nominal / 100n, nominal / 10n, nominal / 2n,
    nominal, nominal * 2n, nominal * 100n];
  const priorityFeeWei = variant === 3 ? 1000000000000n : 1000000000n;
  const gasNative = 300000n * (1000000000n + priorityFeeWei);
  // Independent reference arithmetic for this declared same-block FX scenario.
  const gasQuote = quoteNative ? gasNative : (gasNative * quoteReserve + baseReserve - 1n) / baseReserve;
  const budgetQuote = nominal * 3n;
  const result = compareSizes(snapshot, { inputsQuote, gasUnits: 300000n, priorityFeeWei,
    bufferBps: 50, budgetQuote, fxPool: quoteNative ? null : pools[0] }, nowMs);
  const reference = [];
  for (const row of result.candidates) {
    const buy = pools.find(p => p.address === row.buyPool), sell = pools.find(p => p.address === row.sellPool);
    const baseOut = sdkOut(buy, row.inputQuote, false);
    const outputQuote = baseOut === 0n ? 0n : sdkOut(sell, baseOut, true);
    const bufferQuote = (row.inputQuote * 50n + 9999n) / 10000n;
    const net = outputQuote - row.inputQuote - gasQuote - bufferQuote;
    const within = baseOut > 0n && outputQuote > 0n && row.inputQuote * 10000n <= buy.quoteReserve * 100n &&
      baseOut * 10000n <= sell.baseReserve * 100n && row.inputQuote + gasQuote + bufferQuote <= budgetQuote;
    const matches = row.baseOut === baseOut && row.outputQuote === outputQuote &&
      row.gasQuoteScenario === gasQuote && row.bufferQuoteScenario === bufferQuote && row.scenarioNetQuote === net &&
      row.withinResearchConstraints === within && row.netQuote === null && row.qualified === false;
    const observation = { quoteNative, variant, buyPool: row.buyPool, sellPool: row.sellPool,
      inputQuote: row.inputQuote, sdkBaseOut: baseOut, sdkOutputQuote: outputQuote,
      expectedGasQuote: gasQuote, expectedBufferQuote: bufferQuote, expectedNet: net,
      expectedWithinConstraints: within, matches };
    cases.push(observation); if (!matches) failures.push(observation);
    if (within) reference.push({ ...row, referenceNet: net });
  }
  reference.sort((a, b) => a.referenceNet === b.referenceNet ?
    a.inputQuote < b.inputQuote ? -1 : a.inputQuote > b.inputQuote ? 1 :
      `${a.buyPool}:${a.sellPool}`.localeCompare(`${b.buyPool}:${b.sellPool}`) : a.referenceNet > b.referenceNet ? -1 : 1);
  const expected = reference[0] ?? null, actual = result.bestScenario;
  if (expected === null ? actual !== null : !actual || actual.inputQuote !== expected.inputQuote ||
      actual.buyPool !== expected.buyPool || actual.sellPool !== expected.sellPool || actual.scenarioNetQuote !== expected.referenceNet) {
    failures.push({ quoteNative, variant, failure: 'best-tested-size-mismatch' });
  }
}
const output = resolve(root, 'outputs/REA-Uniswap-V2/sizing-comparison.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ sdkVersion, mode: 'synthetic-offline-sdk-reference',
  observationType: 'ordinary runtime harness, not REA static Evidence', cases: cases.length,
  scenarios: 8, unexpectedMismatches: failures.length, observations: cases, failures,
  limitations: ['Finite synthetic fixtures; no live profitability or token safety claim.',
    'SDK compares swap math; gas and buffer are independently evaluated declared scenario arithmetic.'] },
  (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n');
console.log(JSON.stringify({ output, sdkVersion, cases: cases.length, scenarios: 8, unexpectedMismatches: failures.length }));
if (failures.length) process.exitCode = 1;
