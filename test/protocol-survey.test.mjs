import test from 'node:test';
import assert from 'node:assert/strict';
import { capturePoolViability, SURVEY_TARGETS } from '../tools/research/pooltogether-survey.mjs';
import { encodeClaimRead } from '../packages/bots/pooltogether.mjs';
import liquity from '../tools/research/liquity-read-reference.json' with { type: 'json' };

const word = n => '0x' + BigInt(n).toString(16).padStart(64, '0');
function source({ shutdown = false, expired = false, wrongChain = false, reorg = false } = {}) {
  let requests = 0;
  const values = new Map([
    [encodeClaimRead('pool.isShutdown()'), word(Number(shutdown))],
    [encodeClaimRead('pool.getLastAwardedDrawId()'), word(7)],
    [encodeClaimRead('pool.lastAwardedDrawAwardedAt()'), word(900)],
    [encodeClaimRead('pool.claimCount()'), word(42)],
    [encodeClaimRead('pool.isDrawFinalized(uint24)', [7]), word(Number(expired))],
    [encodeClaimRead('pool.drawClosesAt(uint24)', [8]), word(expired ? 1000 : 1100)]
  ]);
  return { now: () => 1001000, count: () => requests, fetchImpl: async (url, options) => {
    requests++; const body = JSON.parse(options.body);
    assert.ok(['eth_chainId', 'eth_getBlockByNumber', 'eth_getCode', 'eth_call'].includes(body.method));
    let result;
    if (body.method === 'eth_chainId') result = wrongChain ? '0x1' : '0xa4b1';
    if (body.method === 'eth_getCode') result = '0x6000';
    if (body.method === 'eth_getBlockByNumber') result = { number: '0x64', timestamp: '0x3e8',
      hash: '0x' + (reorg && body.params[0] !== 'latest' ? 'cd' : 'ab').repeat(32) };
    if (body.method === 'eth_call') {
      assert.equal(body.params[0].to, SURVEY_TARGETS.arbitrum.pool);
      assert.equal(body.params[1].requireCanonical, true);
      result = values.get(body.params[0].data);
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
  } };
}

test('cross-chain survey distinguishes open, expired and shutdown without claiming profitable operation', async () => {
  for (const [options, status] of [[{}, 'claim-window-open'], [{ expired: true }, 'claim-window-expired'], [{ shutdown: true }, 'shutdown']]) {
    const fake = source(options), report = await capturePoolViability('arbitrum', fake);
    assert.equal(report.status, status); assert.equal(report.available, true);
    assert.equal(report.furtherResearchEligible, status === 'claim-window-open');
    assert.equal(report.qualified, false); assert.equal(report.verifiedNetAtomic, null);
    assert.equal(report.records.length, report.requests);
  }
});

test('survey refuses unreviewed targets, wrong networks and changed canonical blocks', async () => {
  const unknown = source();
  await assert.rejects(capturePoolViability('unreviewed', unknown), /Unreviewed/);
  assert.equal(unknown.count(), 0);
  for (const options of [{ wrongChain: true }, { reorg: true }]) {
    const report = await capturePoolViability('arbitrum', source(options));
    assert.equal(report.available, false); assert.equal(report.furtherResearchEligible, false);
    assert.equal(report.status, 'unavailable-or-rejected');
  }
});

test('survey keeps access denial as unknown and does not retry or turn it into shutdown', async () => {
  let count = 0;
  const report = await capturePoolViability('arbitrum', { now: () => 1001000,
    fetchImpl: async () => { count++; return new Response('', { status: 403 }); } });
  assert.equal(count, 1); assert.equal(report.available, false);
  assert.equal(report.status, 'unavailable-or-rejected'); assert.equal(report.records[0].error, 'HTTP 403');
  assert.equal(report.shutdown, undefined);
});

test('Liquity preflight checks current registry wiring without treating tracked troves as opportunities', async () => {
  for (const mismatch of [false, true]) {
    const values = new Map([
      [liquity.functions['registry.getTroveManager(uint256)'].selector, word(mismatch ? '0x' + '11'.repeat(20) : liquity.manager)],
      [liquity.functions['registry.getToken(uint256)'].selector, word(liquity.collateral)],
      [liquity.functions['manager.shutdownTime()'].selector, word(0)],
      [liquity.functions['manager.getTroveIdsCount()'].selector, word(123)]
    ]);
    const report = await capturePoolViability('liquity-eth', { now: () => 1001000, fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      let result;
      if (body.method === 'eth_chainId') result = '0x1';
      if (body.method === 'eth_getBlockByNumber') result = { number: '0x64', timestamp: '0x3e8', hash: '0x' + 'ab'.repeat(32) };
      if (body.method === 'eth_getCode') result = '0x6000';
      if (body.method === 'eth_call') {
        assert.ok([liquity.registry, liquity.manager].includes(body.params[0].to));
        assert.equal(body.params[1].requireCanonical, true);
        result = values.get(body.params[0].data.slice(0, 10));
      }
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    } });
    if (mismatch) { assert.equal(report.available, false); assert.equal(report.furtherResearchEligible, false); }
    else {
      assert.equal(report.status, 'branch-operational-preflight-only');
      assert.equal(report.trackedTroveIds, '123'); assert.equal(report.liquidationCandidates, null);
      assert.equal(report.oracleValidity, 'not-evaluated'); assert.equal(report.qualified, false);
    }
  }
});
