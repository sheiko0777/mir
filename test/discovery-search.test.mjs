import test from 'node:test';
import assert from 'node:assert/strict';
import { searchDiscoveredMarket } from '../packages/lxr/discovery-search.mjs';
import { QUOTE_TOKENS } from '../packages/lxr/discovery.mjs';
import { fixturePools } from '../packages/adapters/fixture.mjs';

const now = 100000, hash = `0x${'a'.repeat(64)}`;
function sample(quote = QUOTE_TOKENS[0]) {
  return { chainId: 1, blockNumber: 100, blockHash: hash, capturedAtMs: now,
    gas: { blockNumber: 100, blockHash: hash, baseFeePerGasWei: 1000000000n },
    pools: fixturePools(now).map(p => ({ ...p, blockHash: hash, finality: 'finalized',
      baseToken: `0x${'1'.repeat(40)}`, quoteToken: quote.address,
      baseDecimals: 18, quoteDecimals: quote.decimals,
      baseReserve: 10000n * 10n ** 18n, quoteReserve: 10000n * 10n ** BigInt(quote.decimals),
      tokenChecksPassed: null })) };
}
test('discovery search keeps losing routes and exact net costs; never qualifies them', () => {
  const result = searchDiscoveredMarket(sample(), now);
  assert.equal(result.status, 'no-positive-scenario');
  assert.equal(result.sizing.candidates.length, 16);
  for (const c of result.sizing.candidates) {
    assert.equal(c.scenarioNetQuote, c.outputQuote - c.inputQuote - c.gasQuoteScenario - c.bufferQuoteScenario);
    assert.ok(c.scenarioNetQuote < 0n);
    assert.equal(c.qualified, false);
  }
});
test('orientation does not change quotes or mutate collected reserves', () => {
  const normal = sample();
  const reversed = structuredClone(normal);
  reversed.pools = reversed.pools.map(p => ({ ...p, baseToken: p.quoteToken, quoteToken: p.baseToken,
    baseReserve: p.quoteReserve, quoteReserve: p.baseReserve,
    baseDecimals: p.quoteDecimals, quoteDecimals: p.baseDecimals }));
  const before = structuredClone(reversed);
  assert.deepEqual(searchDiscoveredMarket(reversed, now).sizing, searchDiscoveredMarket(normal, now).sizing);
  assert.deepEqual(reversed, before);
});
test('missing venue, unknown conversion, and stale samples cannot produce a winner', () => {
  const single = sample(); single.pools.pop();
  assert.equal(searchDiscoveredMarket(single, now).status, 'missing-second-venue');
  const unknown = searchDiscoveredMarket(sample(QUOTE_TOKENS[1]), now);
  assert.equal(unknown.sizing.bestScenario, null);
  assert.ok(unknown.sizing.candidates.every(c => c.scenarioNetQuote === null));
  assert.equal(searchDiscoveredMarket(sample(), now + 1800001).sizing.bestScenario, null);
});
