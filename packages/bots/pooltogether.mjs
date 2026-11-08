import { createHash } from 'node:crypto';
import reference from './pooltogether-reads.json' with { type: 'json' };

export const CLAIM_REFERENCE = reference;
export const BASE_WETH = '0x4200000000000000000000000000000000000006';
export const CLAIM_LIMITS = Object.freeze({ maxSeeds: 16, maxCalls: 96, maxElapsedMs: 60_000, maxAgeMs: 120_000 });
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const decimal = /^(0|[1-9][0-9]*)$/;
const validAddress = value => typeof value === 'string' && address.test(value) && BigInt(value) !== 0n;
const validTime = value => Number.isSafeInteger(value) && value >= 0;
class RejectedBlockTime extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}
export const COST_FIELDS = Object.freeze(['executionWei', 'l1Wei', 'operatorWei', 'withdrawalWei',
  'failedAttemptsWei', 'computeAndDataWei', 'maintenanceWei']);

function uint(value, bits) {
  if (!(typeof value === 'string' && decimal.test(value) || Number.isSafeInteger(value) && value >= 0)) throw new Error('Invalid unsigned integer');
  const number = BigInt(value);
  if (number >= 2n ** BigInt(bits)) throw new Error('ABI integer overflow');
  return number;
}

export function encodeClaimRead(method, values = []) {
  const abi = reference.functions[method];
  if (!abi || !Array.isArray(values) || values.length !== abi.inputs.length) throw new Error('Unknown read or argument count');
  return abi.selector + abi.inputs.map((type, i) => {
    if (type === 'address') {
      if (!validAddress(values[i])) throw new Error('Invalid ABI address');
      return values[i].slice(2).padStart(64, '0');
    }
    return uint(values[i], Number(type.slice(4))).toString(16).padStart(64, '0');
  }).join('');
}

export function decodeClaimRead(method, result) {
  const abi = reference.functions[method];
  if (!abi || typeof result !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(result)) throw new Error('Invalid static ABI result');
  const number = BigInt(result), type = abi.output;
  if (type === 'address') {
    if (!number || number >= 2n ** 160n) throw new Error('Invalid ABI address result');
    return `0x${number.toString(16).padStart(40, '0')}`;
  }
  if (type === 'bool') {
    if (number > 1n) throw new Error('Invalid ABI boolean');
    return number === 1n;
  }
  if (number >= 2n ** BigInt(type.slice(4))) throw new Error('ABI result overflow');
  return number;
}

export function validateClaimWatchlist(input) {
  if (input?.schemaVersion !== 1 || input.chainId !== 8453 || !Array.isArray(input.seeds) ||
      input.seeds.length > CLAIM_LIMITS.maxSeeds || !input.costs ||
      Object.keys(input).some(key => !['schemaVersion', 'chainId', 'seeds', 'costs'].includes(key)) ||
      Object.keys(input.costs).length !== COST_FIELDS.length) throw new Error('Invalid claim watchlist');
  for (const key of COST_FIELDS) {
    if (!Object.hasOwn(input.costs, key) || input.costs[key] !== null &&
        (typeof input.costs[key] !== 'string' || !decimal.test(input.costs[key]) || input.costs[key].length > 78 || BigInt(input.costs[key]) >= 2n ** 256n)) throw new Error('Invalid cost assumption');
  }
  const seen = new Set();
  for (const seed of input.seeds) {
    if (!validAddress(seed.vault) || !validAddress(seed.winner) ||
        !Number.isInteger(seed.tier) || seed.tier < 0 || seed.tier > 15 ||
        !Number.isInteger(seed.prizeIndex) || seed.prizeIndex < 0 || seed.prizeIndex >= 2 ** 32 ||
        Object.keys(seed).length !== 4) throw new Error('Invalid claim seed');
    const identity = `${seed.vault}:${seed.winner}:${seed.tier}:${seed.prizeIndex}`;
    if (seen.has(identity)) throw new Error('Duplicate claim seed');
    seen.add(identity);
  }
  return input;
}

function quantity(value) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) throw new Error('Invalid RPC quantity');
  const n = Number(BigInt(value));
  if (!Number.isSafeInteger(n)) throw new Error('RPC quantity overflow');
  return n;
}

export function claimCostScenario(reward, costs) {
  const missing = COST_FIELDS.filter(key => costs[key] === null);
  if (missing.length) return { model: 'conditional-all-success-not-expected-profit', missing,
    costAtomic: null, netAtomic: null, doubledCostNetAtomic: null, survivesDoubleCost: false };
  const cost = COST_FIELDS.reduce((sum, key) => sum + BigInt(costs[key]), 0n);
  return { model: 'conditional-all-success-not-expected-profit', missing, costAtomic: cost.toString(),
    netAtomic: (reward - cost).toString(), doubledCostNetAtomic: (reward - 2n * cost).toString(),
    survivesDoubleCost: reward > 2n * cost };
}

// This is a bounded watchlist filter, not an index of every eligible account.
export async function scanPoolTogether(read, watchlist, capturedAtMs) {
  validateClaimWatchlist(watchlist);
  if (typeof capturedAtMs !== 'function' && !validTime(capturedAtMs)) throw new Error('Invalid capture time');
  if (await read('eth_chainId', []) !== '0x2105') throw new Error('Expected Base mainnet');
  const header = await read('eth_getBlockByNumber', ['latest', false]);
  if (!hash.test(header?.hash)) throw new Error('Invalid block hash');
  capturedAtMs = typeof capturedAtMs === 'function' ? capturedAtMs() : capturedAtMs;
  if (!validTime(capturedAtMs)) throw new Error('Invalid capture time');
  const number = quantity(header.number), timestampMs = quantity(header.timestamp) * 1000;
  if (!validTime(timestampMs)) throw new Error('Invalid block time');
  if (capturedAtMs < timestampMs) throw new RejectedBlockTime('FUTURE_BLOCK_TIME');
  if (capturedAtMs - timestampMs > CLAIM_LIMITS.maxAgeMs) throw new RejectedBlockTime('STALE_BLOCK_TIME');
  const pin = { blockHash: header.hash, requireCanonical: true };
  const targets = { pool: reference.pool, claimer: reference.claimer, token: BASE_WETH };
  const codeSha256 = {};
  for (const [role, target] of Object.entries(targets)) {
    const code = await read('eth_getCode', [target, pin]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code) || code.length > 131074) throw new Error('Missing or invalid deployed code');
    codeSha256[role] = createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex');
  }
  const call = async (method, values = []) => decodeClaimRead(method,
    await read('eth_call', [{ to: targets[method.split('.')[0]], data: encodeClaimRead(method, values) }, pin]));
  if (await call('claimer.prizePool()') !== reference.pool ||
      await call('pool.prizeToken()') !== BASE_WETH || await call('token.decimals()') !== 18n) throw new Error('Deployment or asset relationship mismatch');
  const drawId = await call('pool.getLastAwardedDrawId()');
  const tiers = await call('pool.numberOfTiers()');
  if (tiers > 16n) throw new Error('Tier count exceeds scan budget');
  const observations = [], groups = new Map(), counts = new Map();
  for (const seed of watchlist.seeds) {
    const row = { ...seed, status: 'rejected', reason: null };
    observations.push(row);
    if (drawId === 0n) { row.reason = 'NO_AWARDED_DRAW'; continue; }
    if (BigInt(seed.tier) >= tiers) { row.reason = 'TIER_OUT_OF_RANGE'; continue; }
    if (!counts.has(seed.tier)) counts.set(seed.tier, await call('pool.getTierPrizeCount(uint8)', [seed.tier]));
    if (BigInt(seed.prizeIndex) >= counts.get(seed.tier)) { row.reason = 'PRIZE_INDEX_OUT_OF_RANGE'; continue; }
    const args = [seed.vault, seed.winner, seed.tier, seed.prizeIndex];
    if (!await call('pool.isWinner(address,address,uint8,uint32)', args)) { row.reason = 'NOT_A_WINNER'; continue; }
    if (await call('pool.wasClaimed(address,address,uint8,uint32)', args)) { row.reason = 'ALREADY_CLAIMED'; continue; }
    row.status = 'unclaimed-winner-at-pinned-block';
    const key = `${seed.vault}:${seed.tier}`;
    if (!groups.has(key)) groups.set(key, { vault: seed.vault, tier: seed.tier, claims: 0 });
    groups.get(key).claims++;
  }
  const batches = [];
  for (const group of groups.values()) {
    const reward = await call('claimer.computeTotalFees(uint8,uint256)', [group.tier, group.claims]);
    batches.push({ ...group, quotedRewardAtomic: reward.toString(), rewardSemantics: 'conditional-accrued-credit',
      scenario: claimCostScenario(reward, watchlist.costs), qualified: false,
      reasons: ['VAULT_CLAIMER_AND_HOOKS_UNVERIFIED', 'CLAIM_EXECUTION_NOT_SIMULATED', 'COMPETITION_UNMEASURED', 'COSTS_ARE_ASSUMPTIONS'] });
  }
  const confirmed = await read('eth_getBlockByNumber', [header.number, false]);
  if (confirmed?.hash !== header.hash || confirmed?.number !== header.number || confirmed?.timestamp !== header.timestamp) throw new Error('Canonical block changed during scan');
  return { schemaVersion: 1, botId: 'pooltogether-claimer', mode: 'read-only-watchlist', chainId: 8453,
    blockNumber: number, blockHash: header.hash, blockTimestampMs: timestampMs, capturedAtMs,
    drawId: drawId.toString(), finality: 'latest-unfinalized', deployment: {
      pool: reference.pool, claimer: reference.claimer, prizeToken: BASE_WETH, decimals: 18,
      codeSha256, codeObserved: true, codeMatchedToAuditedBuild: false },
    coverage: { kind: 'supplied-seeds-only', seedsChecked: watchlist.seeds.length, wholePoolComplete: false },
    observations, batches, executionEnabled: false, qualified: false, actualReceiptsAtomic: null, verifiedNetAtomic: null,
    limitations: ['No inclusion, expiry or saleability guarantee', 'Batch scenarios are alternatives; do not sum independent fee quotes',
      'Latest block may reorganize', 'No vault-hook simulation, complete account index or automatic scheduling'] };
}

export async function replayClaimCapture(capture, nowMs = Date.now()) {
  if (capture?.schemaVersion !== 1 || capture.kind !== 'pooltogether-claim-capture' ||
      !['public-rpc', 'illustrative-fixture'].includes(capture.source?.kind) ||
      !validTime(capture.capturedAtMs) || !validTime(nowMs) || nowMs < capture.capturedAtMs ||
      !Array.isArray(capture.records) || capture.records.length > CLAIM_LIMITS.maxCalls ||
      capture.source.kind === 'public-rpc' && capture.source.url !== 'https://base-rpc.publicnode.com') throw new Error('Invalid claim capture');
  let cursor = 0, failedRecord = false;
  const read = async (method, params) => {
    const row = capture.records[cursor++];
    if (!row || row.method !== method || JSON.stringify(row.params) !== JSON.stringify(params)) throw new Error('Read transcript mismatch');
    if (Object.hasOwn(row, 'error')) {
      if (typeof row.error !== 'string' || row.error.length > 100 || Object.hasOwn(row, 'result')) throw new Error('Invalid failed read');
      failedRecord = true; throw new Error('Recorded public source unavailable');
    }
    if (!Object.hasOwn(row, 'result')) throw new Error('Incomplete read transcript');
    return row.result;
  };
  let snapshot;
  try { snapshot = await scanPoolTogether(read, capture.watchlist, capture.capturedAtMs); }
  catch (error) {
    if (error instanceof RejectedBlockTime && cursor === capture.records.length) return {
      available: false, status: 'rejected-evidence', reason: error.reason, botId: 'pooltogether-claimer', batches: [],
      qualified: false, executionEnabled: false, verifiedNetAtomic: null, source: capture.source };
    if (!failedRecord || cursor !== capture.records.length) throw error;
    return { available: false, status: 'source-unavailable', botId: 'pooltogether-claimer', batches: [],
      qualified: false, executionEnabled: false, verifiedNetAtomic: null, source: capture.source };
  }
  if (cursor !== capture.records.length) throw new Error('Unused transcript records');
  const illustrative = capture.source.kind === 'illustrative-fixture';
  const ageMs = nowMs - snapshot.blockTimestampMs;
  return { ...snapshot, available: true, illustrative, ageMs,
    freshness: ageMs > CLAIM_LIMITS.maxAgeMs ? 'stale' : 'recent',
    status: illustrative ? 'illustrative-only' : ageMs > CLAIM_LIMITS.maxAgeMs ? 'stale-evidence' : 'read-only-evidence',
    source: capture.source };
}
