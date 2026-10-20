import test from 'node:test';
import assert from 'node:assert/strict';
import { VENUES } from '../packages/adapters/uniswap-v2.mjs';
import { scanNewPools } from '../packages/adapters/new-pools.mjs';
import { analyzeDiscoveredPair, QUOTE_TOKENS } from '../packages/lxr/discovery.mjs';

const hash = `0x${'a'.repeat(64)}`;
const header = { number: '0x64', timestamp: '0x3e8', hash };
const nowMs = 1_010_000;
const address = number => `0x${BigInt(number).toString(16).padStart(40, '0')}`;
const encode = (...numbers) => `0x${numbers.map(n => BigInt(n).toString(16).padStart(64, '0')).join('')}`;
const weth = QUOTE_TOKENS[0].address;
function source({ total = 1, reorg = false, fail = false, empty = false } = {}) {
  const calls = [];
  const factories = Object.values(VENUES);
  const rpc = async (method, params = []) => {
    calls.push({ method, params });
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_getBlockByNumber') return reorg && params[0] === '0x64' ? { ...header, hash: `0x${'b'.repeat(64)}` } : header;
    if (fail) throw new Error('RPC transport unavailable or timed out');
    const { to, data } = params[0];
    assert.deepEqual(params[1], { blockHash: hash, requireCanonical: true });
    const factoryIndex = factories.indexOf(to);
    const selector = data.slice(0, 10);
    if (selector === '0x574f2ba3') return encode(total);
    if (selector === '0x1e3dd18b') return encode(address(300 + factoryIndex * 100 + Number(BigInt(`0x${data.slice(10)}`))));
    if (selector === '0xe6a43905') return encode(address(300 + factoryIndex * 100 + Number(BigInt(`0x${data.slice(10, 74)}`)) - 100));
    if (selector === '0x313ce567') return encode(18);
    const poolNumber = Number(BigInt(to));
    const venue = poolNumber >= 400 ? 1 : 0;
    const i = poolNumber - (300 + venue * 100);
    if (selector === '0xc45a0155') return encode(factories[venue]);
    if (selector === '0x0dfe1681') return encode(address(100 + i));
    if (selector === '0xd21220a7') return encode(weth);
    if (selector === '0x0902f1ac') return encode(empty ? 0 : 1000n * 10n ** 18n, (venue ? 1030n : 1000n) * 10n ** 18n, 900);
    throw new Error('Unexpected mock call');
  };
  return { rpc, calls };
}

test('new pool bootstrap is bounded and token age stays unknown even when a gap exists', async () => {
  const { rpc } = source({ total: 5 });
  const { report, state } = await scanNewPools(rpc, { limit: 1, nowMs });
  assert.equal(report.discoveries.length, 2);
  assert.ok(report.coverage.every(c => c.bootstrapSkipped === 4));
  assert.ok(Object.values(state.offsets).every(offset => offset === 5));
  assert.ok(report.discoveries.every(d => d.tokenAge === 'unknown' && d.analysis.gapDetected));
  assert.equal(report.discoveries[0].analysis.spotGapBps, 300n);
  assert.equal(report.discoveries[0].analysis.qualified, false);
  assert.deepEqual(report.discoveries[1].firstObservedLocally, []);
});
test('checkpoint resumes without duplicates, new counts catch up in bounded windows', async () => {
  const first = await scanNewPools(source().rpc, { limit: 1, nowMs });
  const unchangedSource = source();
  const unchanged = await scanNewPools(unchangedSource.rpc, { state: first.state, limit: 1, nowMs });
  assert.equal(unchanged.report.discoveries.length, 0);
  assert.equal(unchangedSource.calls.some(c => c.method === 'eth_call' && c.params[0].data.startsWith('0x1e3dd18b')), false);
  const next = await scanNewPools(source({ total: 3 }).rpc, { state: first.state, limit: 1, nowMs });
  assert.ok(next.report.coverage.every(c => c.fromIndex === 1 && c.toIndexExclusive === 2 && c.remaining === 1));
  assert.ok(next.report.discoveries.every(d => d.classification === 'NEW_SINCE_CHECKPOINT'));
  assert.notEqual(next.report.discoveries[0].id, first.report.discoveries[0].id);
});
test('bad checkpoints, count regression, reorgs and failed RPC scans do not mutate prior state', async () => {
  const first = await scanNewPools(source().rpc, { limit: 1, nowMs });
  const before = structuredClone(first.state);
  await assert.rejects(scanNewPools(source({ reorg: true }).rpc, { state: first.state, nowMs }), /canonical/);
  await assert.rejects(scanNewPools(source({ total: 0 }).rpc, { state: first.state, nowMs }), /decreased/);
  await assert.rejects(scanNewPools(source({ fail: true }).rpc, { state: first.state, nowMs }), /transport/);
  await assert.rejects(scanNewPools(source().rpc, { state: {}, nowMs }), /checkpoint/);
  assert.deepEqual(first.state, before);
});
test('empty pools are detected with token addresses but no invented price', async () => {
  const { report } = await scanNewPools(source({ empty: true }).rpc, { limit: 1, nowMs });
  assert.equal(report.discoveries.length, 2);
  assert.ok(report.discoveries.every(d => d.baseToken && d.quoteToken && d.reasons.includes('EMPTY_RESERVES') && !d.analysis));
});

test('empty pairs are revisited when funded without a new factory entry', async () => {
  const initial = await scanNewPools(source({ empty: true }).rpc, { limit: 1, nowMs });
  assert.equal(initial.state.pendingPairs.length, 1);
  const funded = await scanNewPools(source().rpc, { state: initial.state, limit: 1, nowMs });
  assert.equal(funded.report.discoveries.length, 0);
  assert.equal(funded.report.followUps.length, 1);
  assert.equal(funded.report.followUps[0].analysis.poolCount, 2);
  assert.equal(funded.report.followUps[0].analysis.gapDetected, true);
  assert.equal(funded.state.pendingPairs.length, 0);
});
test('gap thresholds and quote normalization work without floating point', async () => {
  const { report } = await scanNewPools(source().rpc, { limit: 1, minGapBps: 301, nowMs });
  assert.equal(report.discoveries[0].analysis.gapDetected, false);
  assert.equal(report.discoveries[0].analysis.research.routes[0].netQuote, null);
  assert.ok(report.discoveries[0].analysis.reasons.includes('GAP_BELOW_THRESHOLD'));
  // Quote token can be canonical token0; orientation is economic, not address order.
  const pool = { address: address(800), venue: 'test', chainId: 1, model: 'constant-product',
    baseToken: QUOTE_TOKENS[1].address, quoteToken: weth, baseDecimals: 6, quoteDecimals: 18,
    baseReserve: 2000n * 10n ** 6n, quoteReserve: 10n ** 18n, blockNumber: 100, blockHash: hash };
  const analyzed = analyzeDiscoveredPair({ blockNumber: 100, blockHash: hash, pools: [pool] }, { nowMs });
  assert.equal(analyzed.quoteLabel, 'WETH');
  assert.equal(analyzed.prices[0].priceNumerator * 2000n, analyzed.prices[0].priceDenominator);
  assert.ok(analyzed.reasons.includes('NO_CROSS_VENUE_POOL'));
  const unsupported = analyzeDiscoveredPair({ pools: [{ baseToken: address(1), quoteToken: address(2) }] }, { nowMs });
  assert.ok(unsupported.reasons.includes('UNSUPPORTED_QUOTE_TOKEN'));
});
