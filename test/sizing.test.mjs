import test from 'node:test';
import assert from 'node:assert/strict';
import { fixturePools } from '../packages/adapters/fixture.mjs';
import { gasScenario, ceilDiv, WETH } from '../packages/lxr/costs.mjs';
import { compareSizes } from '../packages/lxr/sizing.mjs';
import { PaperLedger } from '../packages/paper/index.mjs';

const nowMs = 100000, blockHash = `0x${'a'.repeat(64)}`;
function snapshot() {
  return { chainId: 1, blockNumber: 100, blockHash, capturedAtMs: nowMs,
    gas: { blockNumber: 100, blockHash, baseFeePerGasWei: 1000000000n },
    pools: fixturePools(nowMs).map((p, i) => ({ ...p, baseToken: WETH,
      blockHash, finality: 'finalized', baseDecimals: 18, quoteDecimals: 6,
      venue: ['uniswap-v2', 'sushiswap-v2'][i], tokenChecksPassed: null })) };
}
const options = { inputsQuote: [100n, 1000n, 5000n, 10000n].map(n => n * 1000000n),
  gasUnits: 300000n, priorityFeeWei: 1000000000n, bufferBps: 50 };
function model(data = snapshot()) {
  return gasScenario(data, { quoteToken: data.pools[0].quoteToken, quoteDecimals: 6,
    gasUnits: 300000n, priorityFeeWei: 1000000000n, fxPool: data.pools[0] });
}
test('gas arithmetic is exact, pinned and denominated in native atomic units for WETH', () => {
  const result = gasScenario(snapshot(), { quoteToken: WETH, quoteDecimals: 18,
    gasUnits: 300000n, priorityFeeWei: 1000000000n });
  assert.equal(result.gasQuote, 600000000000000n);
  assert.equal(result.gasQuote, result.gasNativeWei);
  assert.equal(result.available, true);
  assert.ok(result.reasons.includes('GAS_UNITS_ASSUMED'));
  assert.equal(result.blockHash, blockHash);
});
test('quote conversion rounds costs upward, supports both orientations and never assumes a dollar peg', () => {
  const direct = model();
  assert.equal(direct.gasQuote, 600000n);
  const data = snapshot(); const p = data.pools[0];
  const reverse = { ...p, baseToken: p.quoteToken, quoteToken: WETH,
    baseDecimals: 6, quoteDecimals: 18, baseReserve: p.quoteReserve, quoteReserve: p.baseReserve };
  const reversed = gasScenario(data, { quoteToken: p.quoteToken, quoteDecimals: 6,
    gasUnits: 300000n, priorityFeeWei: 1000000000n, fxPool: reverse });
  assert.equal(reversed.gasQuote, direct.gasQuote);
  assert.equal(ceilDiv(10n, 3n), 4n);
  const tiny = snapshot(); tiny.gas.baseFeePerGasWei = 1n;
  const rounded = gasScenario(tiny, { quoteToken: p.quoteToken, quoteDecimals: 6,
    gasUnits: 1n, priorityFeeWei: 0n, fxPool: { ...p, baseReserve: 3n, quoteReserve: 2n } });
  assert.equal(rounded.gasQuote, 1n);
});
test('missing gas assumptions, base fee or conversion keep the cost unknown', () => {
  assert.equal(gasScenario(snapshot(), { quoteToken: WETH, quoteDecimals: 18 }).gasQuote, null);
  const data = snapshot(); data.gas.baseFeePerGasWei = null;
  assert.ok(model(data).reasons.includes('BASE_FEE_UNAVAILABLE'));
  const unknown = gasScenario(snapshot(), { quoteToken: snapshot().pools[0].quoteToken,
    quoteDecimals: 6, gasUnits: 1n, priorityFeeWei: 1n });
  assert.equal(unknown.available, false);
  assert.equal(unknown.gasQuote, null);
});
test('cross-block conversion, mismatched decimals, invalid fees and wrong chain fail closed', () => {
  const data = snapshot();
  for (const fxPool of [{ ...data.pools[0], blockHash: `0x${'b'.repeat(64)}` },
    { ...data.pools[0], baseDecimals: 6 }]) assert.throws(() => gasScenario(data, {
      quoteToken: data.pools[0].quoteToken, quoteDecimals: 6, gasUnits: 1n, priorityFeeWei: 1n, fxPool }), /conversion/);
  data.gas.blockHash = `0x${'b'.repeat(64)}`; assert.throws(() => model(data), /provenance/);
  assert.throws(() => gasScenario({ ...snapshot(), chainId: 137 }, { quoteToken: WETH, quoteDecimals: 18 }), /identity/);
  assert.throws(() => gasScenario(snapshot(), { quoteToken: WETH, quoteDecimals: 18, gasUnits: 0n }), /assumptions/);
});
test('search ranks the actual candidate net amounts, retaining all costs and unqualified status', () => {
  const data = snapshot(); const result = compareSizes(data, { ...options, fxPool: data.pools[0] }, nowMs);
  assert.equal(result.candidates.length, 8);
  assert.ok(result.bestScenario);
  for (const candidate of result.candidates) {
    assert.equal(candidate.scenarioNetQuote, candidate.outputQuote - candidate.inputQuote -
      candidate.gasQuoteScenario - candidate.bufferQuoteScenario);
    assert.equal(candidate.netQuote, null); assert.equal(candidate.qualified, false);
    assert.ok(candidate.reasons.includes('TOKEN_CHECKS_UNKNOWN_OR_FAILED'));
    assert.throws(() => new PaperLedger(100000000000n).record('forbidden', candidate));
    if (candidate.withinResearchConstraints) assert.ok(result.bestScenario.scenarioNetQuote >= candidate.scenarioNetQuote);
  }
  assert.equal(result.qualifiedOpportunities, 0);
  assert.equal(result.netProfitKnown, false);
  assert.equal(result.policy.strategy, 'explicit-grid-not-global-optimization');
});
test('positive gross can be negative after costs; zero/unknown fees are not substituted', () => {
  const data = snapshot();
  const result = compareSizes(data, { ...options, fxPool: data.pools[0], gasUnits: 10000000n,
    priorityFeeWei: 1000000000000n }, nowMs);
  assert.ok(result.candidates.some(c => c.grossAfterPoolFeesQuote > 0n && c.scenarioNetQuote < 0n));
  assert.equal(result.status, 'no-positive-scenario');
  const unknown = compareSizes(data, { inputsQuote: options.inputsQuote }, nowMs);
  assert.equal(unknown.bestScenario, null);
  assert.ok(unknown.candidates.every(c => c.scenarioNetQuote === null));
});
test('over-budget, over-size and stale candidates cannot win', () => {
  const data = snapshot();
  const constrained = compareSizes(data, { ...options, inputsQuote: [...options.inputsQuote, 50000n * 1000000n],
    fxPool: data.pools[0], budgetQuote: 2000n * 1000000n }, nowMs);
  assert.ok(constrained.candidates.some(c => c.reasons.includes('SCENARIO_BUDGET_EXCEEDED')));
  assert.ok(constrained.candidates.some(c => c.reasons.includes('BUY_SIZE_LIMIT')));
  assert.ok(constrained.bestScenario.inputQuote < 2000n * 1000000n);
  assert.equal(compareSizes(data, { ...options, fxPool: data.pools[0] }, nowMs + 1800001).bestScenario, null);
  assert.equal(compareSizes({ ...data, capturedAtMs: nowMs + 1 }, { ...options, fxPool: data.pools[0] }, nowMs).bestScenario, null);
});
test('quote budget includes rounded costs and admits equality but not one atomic unit less', () => {
  const data = snapshot();
  const exact = 100000000n + 600000n + 500000n;
  const base = { ...options, inputsQuote: [100000000n], fxPool: data.pools[0] };
  assert.ok(compareSizes(data, { ...base, budgetQuote: exact }, nowMs).bestScenario);
  assert.equal(compareSizes(data, { ...base, budgetQuote: exact - 1n }, nowMs).bestScenario, null);
});
test('grid limits and integer amounts are enforced; missing markets do not invent a winner', () => {
  for (const inputsQuote of [[], [0n], [1], Array(65).fill(1n)]) {
    assert.throws(() => compareSizes(snapshot(), { inputsQuote }, nowMs), /policy/);
  }
  const empty = snapshot(); empty.pools = [];
  assert.equal(compareSizes(empty, options, nowMs).bestScenario, null);
  const deduplicated = compareSizes(snapshot(), { inputsQuote: [10n, 10n] }, nowMs);
  assert.equal(deduplicated.candidates.length, 2);
});
