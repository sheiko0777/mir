import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile, link, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeClaimRead, decodeClaimRead } from '../../packages/bots/pooltogether.mjs';
import liquity from './liquity-read-reference.json' with { type: 'json' };

// Fixed published targets; adding a network requires another source review.
export const SURVEY_TARGETS = Object.freeze({
  arbitrum: Object.freeze({ chainId: 42161, pool: '0x52e7910c4c287848c8828e8b17b8371f4ebc5d42',
    rpc: 'https://arbitrum-one-rpc.publicnode.com', version: '1.0.0',
    deploymentSource: 'https://github.com/GenerationSoftware/pt-v5-mainnet/blob/72816ec8a6b506c570f09e60bd0b6f71a3cf36d6/deployments/arbitrum/contracts.json' }),
  ethereum: Object.freeze({ chainId: 1, pool: '0x7865d01da4c9ba2f69b7879e6d2483ab6b354d95',
    rpc: 'https://ethereum-rpc.publicnode.com', version: '1.0.0',
    deploymentSource: 'https://github.com/GenerationSoftware/pt-v5-mainnet/blob/ca2acf967a962355b921fd4893306b961e7bc62a/deployments/ethereum/contracts.json' }),
  'liquity-eth': Object.freeze({ chainId: 1, protocol: 'liquity-v2', pool: liquity.manager,
    registry: liquity.registry, collateral: liquity.collateral, rpc: 'https://ethereum-rpc.publicnode.com',
    deploymentSource: `https://github.com/liquity/bold/blob/${liquity.sourceCommit}/contracts/addresses/1.json` })
});
const quantity = value => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid RPC quantity');
  return Number(BigInt(value));
};

export async function capturePoolViability(target, { fetchImpl = fetch, now = Date.now } = {}) {
  const profile = SURVEY_TARGETS[target];
  if (!profile) throw new Error('Unreviewed survey target');
  const began = now(), records = [];
  let responseBytes = 0;
  const read = async (method, params) => {
    if (records.length >= 16 || now() - began >= 30000) throw new Error('Survey request/time budget exceeded');
    const row = { method, params }; records.push(row);
    try {
      const response = await fetchImpl(profile.rpc, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(Math.max(1, Math.min(8000, 30000 - (now() - began)))),
        body: JSON.stringify({ jsonrpc: '2.0', id: records.length, method, params }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('Missing body');
      const reader = response.body.getReader(), chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          bytes += value.byteLength; responseBytes += value.byteLength;
          if (bytes > 256 * 1024 || responseBytes > 1024 * 1024) throw new Error('Survey byte budget exceeded');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const envelope = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (envelope?.jsonrpc !== '2.0' || envelope.id !== records.length || envelope.error || !Object.hasOwn(envelope, 'result')) throw new Error('Invalid RPC result');
      row.result = envelope.result; return row.result;
    } catch (error) {
      row.error = /^HTTP \d{3}$/.test(error.message) ? error.message : 'Public read unavailable or invalid';
      throw error;
    }
  };
  const base = { schemaVersion: 1, kind: 'protocol-viability-survey', target, profile, startedAtMs: began,
    scope: 'protocol-liveness-only-not-full-worker-or-profit-test', abiCompatibility: 'reviewed-interface-not-audited-bytecode-match',
    records, qualified: false, verifiedNetAtomic: null, executionEnabled: false };
  try {
    if (quantity(await read('eth_chainId', [])) !== profile.chainId) throw new Error('Wrong chain');
    const header = await read('eth_getBlockByNumber', ['latest', false]);
    if (!/^0x[0-9a-f]{64}$/.test(header?.hash)) throw new Error('Invalid head');
    const blockNumber = quantity(header.number), blockTimeMs = quantity(header.timestamp) * 1000, time = now();
    if (!Number.isSafeInteger(blockTimeMs) || blockTimeMs > time || time - blockTimeMs > 120000) throw new Error('Invalid head time');
    const pin = { blockHash: header.hash, requireCanonical: true };
    const code = await read('eth_getCode', [profile.pool, pin]);
    if (typeof code !== 'string' || !/^0x(?:[0-9a-f]{2})+$/.test(code) || code.length > 131074) throw new Error('Invalid pool code');
    let protocolState;
    if (profile.protocol === 'liquity-v2') {
      const getter = async (method, index = null) => {
        const spec = liquity.functions[method];
        const data = spec.selector + (spec.inputs.length ? BigInt(index).toString(16).padStart(64, '0') : '');
        const value = await read('eth_call', [{ to: method.startsWith('registry.') ? profile.registry : profile.pool, data }, pin]);
        if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Invalid Liquity getter');
        const n = BigInt(value);
        if (spec.output !== 'address') return n;
        if (n === 0n || n >= 2n ** 160n) throw new Error('Invalid registry address');
        return '0x' + n.toString(16).padStart(40, '0');
      };
      if (await getter('registry.getTroveManager(uint256)', 0) !== profile.pool ||
          await getter('registry.getToken(uint256)', 0) !== profile.collateral) throw new Error('Liquity registry mismatch');
      const shutdownTime = await getter('manager.shutdownTime()'), trackedTroveIds = await getter('manager.getTroveIdsCount()');
      if (shutdownTime > BigInt(blockTimeMs / 1000)) throw new Error('Future shutdown timestamp');
      protocolState = { status: shutdownTime > 0n ? 'branch-shutdown' : 'branch-operational-preflight-only',
        shutdownTimeSeconds: shutdownTime.toString(), trackedTroveIds: trackedTroveIds.toString(),
        furtherResearchEligible: shutdownTime === 0n && trackedTroveIds > 0n,
        liquidationCandidates: null, oracleValidity: 'not-evaluated', operatingCosts: 'unknown' };
    } else {
      const call = async (method, values = []) => decodeClaimRead(method,
        await read('eth_call', [{ to: profile.pool, data: encodeClaimRead(method, values) }, pin]));
      const shutdown = await call('pool.isShutdown()'), draw = await call('pool.getLastAwardedDrawId()');
      const awardedAtMs = Number(await call('pool.lastAwardedDrawAwardedAt()')) * 1000;
      const claimCount = (await call('pool.claimCount()')).toString();
      if (!Number.isSafeInteger(awardedAtMs) || awardedAtMs > blockTimeMs || draw > 0n && awardedAtMs === 0) throw new Error('Invalid awarded time');
      let finalized = null, claimWindowEndsAtMs = null;
      if (draw > 0n) {
        finalized = await call('pool.isDrawFinalized(uint24)', [draw.toString()]);
        claimWindowEndsAtMs = Number(await call('pool.drawClosesAt(uint24)', [(draw + 1n).toString()])) * 1000;
        if (!Number.isSafeInteger(claimWindowEndsAtMs) || finalized !== (blockTimeMs >= claimWindowEndsAtMs)) throw new Error('Inconsistent claim window');
      }
      protocolState = { status: shutdown ? 'shutdown' : draw === 0n ? 'no-awarded-draw' : finalized ? 'claim-window-expired' : 'claim-window-open',
        shutdown, finalized, drawId: draw.toString(), awardedAtMs, claimWindowEndsAtMs, claimCount,
        furtherResearchEligible: !shutdown && draw > 0n && !finalized };
    }
    const confirmed = await read('eth_getBlockByNumber', [header.number, false]);
    if (confirmed?.hash !== header.hash || confirmed?.number !== header.number || confirmed?.timestamp !== header.timestamp) throw new Error('Canonical head changed');
    return { ...base, ...protocolState, available: true,
      capturedAtMs: now(), blockNumber, blockHash: header.hash, blockTimeMs,
      codeSha256: createHash('sha256').update(Buffer.from(code.slice(2), 'hex')).digest('hex'),
      requests: records.length, responseBytes };
  } catch (error) {
    return { ...base, available: false, status: 'unavailable-or-rejected', capturedAtMs: now(),
      requests: records.length, responseBytes, furtherResearchEligible: false,
      reason: records.at(-1)?.error ?? 'Protocol identity, state or budget check failed' };
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (!(args.length === 0 || args.length === 2 && args[0] === '--target' && Object.hasOwn(SURVEY_TARGETS, args[1]))) throw new Error('Only fixed reviewed targets are supported');
  const targets = args.length ? [args[1]] : Object.keys(SURVEY_TARGETS);
  const reports = await Promise.all(targets.map(target => capturePoolViability(target)));
  const directory = resolve('data/protocol-survey'); await mkdir(directory, { recursive: true });
  for (const report of reports) {
    const raw = JSON.stringify(report) + '\n', id = createHash('sha256').update(raw).digest('hex');
    const temporary = join(directory, `.${id}.${randomUUID()}.pending`);
    try {
      await writeFile(temporary, raw, { flag: 'wx' });
      try { await link(temporary, join(directory, id + '.json')); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
    console.log(JSON.stringify({ id, target: report.target, status: report.status, drawId: report.drawId,
      awardedAtMs: report.awardedAtMs, claimCount: report.claimCount, trackedTroveIds: report.trackedTroveIds,
      shutdownTimeSeconds: report.shutdownTimeSeconds, requests: report.requests,
      furtherResearchEligible: report.furtherResearchEligible, qualified: false, verifiedNetAtomic: null }));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
