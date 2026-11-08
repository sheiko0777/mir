import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CLAIM_EVENT_TOPIC, parseClaimParticipants, discoverClaimSeeds, validateSeedDiscovery } from '../packages/bots/pooltogether-discovery.mjs';
import { CLAIM_REFERENCE, scanPoolTogether, replayClaimCapture } from '../packages/bots/pooltogether.mjs';
import { illustrativeClaimSession } from '../packages/bots/pooltogether-fixture.mjs';
import { createClaimRpc } from '../packages/adapters/pooltogether-rpc.mjs';

const word = value => BigInt(value).toString(16).padStart(64, '0');
function claimLog(overrides = {}) {
  return { address: CLAIM_REFERENCE.pool, removed: false, blockHash: `0x${'ab'.repeat(32)}`,
    blockNumber: '0x64', transactionHash: `0x${'aa'.repeat(32)}`, transactionIndex: '0x0', logIndex: '0x0',
    topics: [CLAIM_EVENT_TOPIC, '0x' + word('0x' + '11'.repeat(20)),
      '0x' + word('0x' + '22'.repeat(20)), '0x' + word('0x' + '33'.repeat(20))],
    data: '0x' + [7, 1, 0, 500, 100, '0x' + '44'.repeat(20)].map(word).join(''), ...overrides };
}
const window = { fromBlock: 97, toBlock: 100, drawId: 7n };

test('claim topic and static field widths match the existing pinned accounting reference', async () => {
  const reference = JSON.parse(await readFile(new URL('../tools/research/pooltogether-reference.json', import.meta.url)));
  const event = reference.events.find(e => e.name === 'ClaimedPrize');
  assert.equal(CLAIM_EVENT_TOPIC, event.topic);
  assert.deepEqual(event.inputs.filter(i => !i.indexed).map(i => i.type), ['uint24', 'uint8', 'uint32', 'uint152', 'uint96', 'address']);
});

test('event parser exposes a biased participant sample and never counts payouts as income', () => {
  const parsed = parseClaimParticipants([claimLog()], window);
  assert.equal(parsed.eventsObserved, 1);
  assert.equal(parsed.participants[0].sourceDrawId, '7');
  assert.equal(parsed.participants[0].winner, '0x' + '22'.repeat(20));
  assert.equal(parsed.coversAllEligibleAccounts, false);
  assert.equal(Object.hasOwn(parsed.participants[0], 'reward'), false);
  assert.equal(Object.hasOwn(parsed.participants[0], 'revenue'), false);
  assert.deepEqual(parseClaimParticipants([], window).participants, []);
});

test('removed, duplicate, wrong-source, out-of-range and malformed claim logs fail closed', () => {
  const wrongTopic = claimLog(); wrongTopic.topics[0] = `0x${'00'.repeat(32)}`;
  const badData = claimLog({ data: '0x' + [7, 256, 0, 500, 100, 1].map(word).join('') });
  const futureDraw = claimLog({ data: '0x' + [8, 1, 0, 500, 100, 1].map(word).join('') });
  for (const logs of [[claimLog({ removed: true })], [claimLog(), claimLog()], [claimLog({ address: '0x' + '55'.repeat(20) })],
    [claimLog({ blockNumber: '0x65' })], [claimLog({ data: '0x01' })], [wrongTopic], [badData], [futureDraw],
    [claimLog(), claimLog({ blockHash: `0x${'cd'.repeat(32)}`, logIndex: '0x1' })], Array(129).fill(claimLog())]) {
    assert.throws(() => parseClaimParticipants(logs, window));
  }
});

test('discovery limits participants, deduplicates manual seeds and checks selected source block hashes', async () => {
  const logs = Array.from({ length: 6 }, (_, i) => claimLog({ logIndex: '0x' + i.toString(16),
    topics: [CLAIM_EVENT_TOPIC, '0x' + word('0x' + '11'.repeat(20)), '0x' + word(BigInt(i + 10)), '0x' + word(3)] }));
  const header = { number: '0x64', hash: `0x${'ab'.repeat(32)}` };
  let headers = 0;
  const read = async method => {
    if (method === 'eth_getLogs') return logs;
    headers++; return header;
  };
  const result = await discoverClaimSeeds(read, { header, drawId: 7n, existingSeeds: [],
    discovery: { kind: 'recent-claim-participants', lookbackBlocks: 4 } });
  assert.equal(result.seeds.length, 16); assert.equal(result.coverage.selectedParticipants, 4);
  assert.equal(result.coverage.distinctParticipantTiersObserved, 6); assert.equal(headers, 1);
  const again = await discoverClaimSeeds(read, { header, drawId: 7n, existingSeeds: result.seeds,
    discovery: { kind: 'recent-claim-participants', lookbackBlocks: 4 } });
  assert.equal(again.seeds.length, 16); assert.equal(again.coverage.addedSeeds, 0);
  await assert.rejects(discoverClaimSeeds(async method => method === 'eth_getLogs' ? logs : { ...header, hash: `0x${'cd'.repeat(32)}` },
    { header, drawId: 7n, existingSeeds: [], discovery: { kind: 'recent-claim-participants', lookbackBlocks: 4 } }), /canonical/);
});

test('event-discovered participants traverse current winner/claim checks and replay identically', async () => {
  const session = illustrativeClaimSession();
  session.watchlist.seeds = [];
  session.watchlist.discovery = { kind: 'recent-claim-participants', lookbackBlocks: 4 };
  const read = async (method, params) => {
    let result;
    if (method === 'eth_getLogs') result = [claimLog()];
    if (method === 'eth_call' && params[0].data.startsWith(CLAIM_REFERENCE.functions['pool.isWinner(address,address,uint8,uint32)'].selector) &&
        !params[0].data.endsWith(word(0))) result = '0x' + word(0);
    if (result === undefined) return session.read(method, params);
    session.records.push({ method, params: structuredClone(params), result }); return result;
  };
  const report = await scanPoolTogether(read, session.watchlist, session.capturedAtMs);
  assert.equal(report.coverage.discovery.addedSeeds, 4);
  assert.equal(report.coverage.seedsChecked, 4);
  assert.equal(report.batches.length, 1); assert.equal(report.qualified, false);
  assert.equal(report.observations.filter(r => r.reason === 'NOT_A_WINNER').length, 3);
  const capture = { schemaVersion: 1, kind: 'pooltogether-claim-capture', capturedAtMs: session.capturedAtMs,
    watchlist: session.watchlist, records: session.records, source: session.source };
  const replay = await replayClaimCapture(capture, session.capturedAtMs);
  assert.deepEqual(replay.observations, report.observations);
  assert.deepEqual(replay.coverage, report.coverage);
  assert.equal(replay.status, 'illustrative-only');
});

test('event query transport allows only bounded exact protocol filters; financial methods stay forbidden', async () => {
  let requests = 0;
  const rpc = createClaimRpc({ fetchImpl: async (url, options) => {
    requests++; const body = JSON.parse(options.body);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: [] }));
  } });
  const filter = { address: CLAIM_REFERENCE.pool, topics: [CLAIM_EVENT_TOPIC], fromBlock: '0x0', toBlock: '0x1ff' };
  await rpc.read('eth_getLogs', [filter]);
  assert.equal(requests, 1);
  for (const invalid of [{ ...filter, toBlock: '0x200' }, { ...filter, address: '0x' + '11'.repeat(20) },
    { ...filter, topics: [] }, { ...filter, fromBlock: 'earliest' }, { ...filter, blockHash: `0x${'ab'.repeat(32)}` }]) {
    await assert.rejects(rpc.read('eth_getLogs', [invalid]), /allowlisted/);
  }
  assert.equal(requests, 1);
  assert.throws(() => validateSeedDiscovery({ kind: 'recent-claim-participants', lookbackBlocks: 513 }));
  assert.throws(() => validateSeedDiscovery({ kind: 'all-accounts', lookbackBlocks: 4 }));
});
