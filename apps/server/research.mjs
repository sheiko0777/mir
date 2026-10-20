import path from 'node:path';
import { mkdir, open, writeFile, rename, unlink } from 'node:fs/promises';
import { readJson, MAX_CAPTURE_AGE_MS } from './reports.mjs';
import { compareSizes } from '../../packages/lxr/sizing.mjs';
import { VENUES } from '../../packages/adapters/uniswap-v2.mjs';

const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const namePattern = /^\d+-[a-f0-9]{64}-\d+-\d+\.json$/;
const integer = n => Number.isSafeInteger(n) && n >= 0;
const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v, 2) + '\n';
const serializable = value => JSON.parse(json(value));
const quotes = new Map([
  ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', { label: 'WETH', decimals: 18 }],
  ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', { label: 'USDC', decimals: 6 }]
]);
function units(value, max = 2n ** 256n - 1n) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value) || BigInt(value) > max) throw new Error('Invalid research atomic amount');
  return BigInt(value);
}
const optionalUnits = value => value === null ? null : units(value);

export function normalizeResearch(archive, nowMs = Date.now()) {
  const raw = archive?.snapshot, policy = archive?.sizingInputs;
  if (!raw || raw.chainId !== 1 || raw.mode !== 'read-only' || raw.schemaVersion !== 1 ||
      !integer(raw.blockNumber) || !hash.test(raw.blockHash) || !integer(raw.capturedAtMs) ||
      !integer(raw.observedAtMs) || raw.observedAtMs > raw.capturedAtMs || !integer(nowMs) ||
      !Array.isArray(raw.pools) || raw.pools.length > 10 || !policy ||
      policy.schemaVersion !== 1 || !Number.isInteger(policy.bufferBps) || !Number.isInteger(policy.baseFeeFactorBps) ||
      !Array.isArray(policy.inputsQuote) || !policy.inputsQuote.length || policy.inputsQuote.length > 64) {
    throw new Error('Invalid saved research');
  }
  const pools = raw.pools.map(p => {
    if (p.chainId !== 1 || !address.test(p.address) || !address.test(p.baseToken) || !address.test(p.quoteToken) ||
        BigInt(p.address) === 0n || BigInt(p.baseToken) === 0n || BigInt(p.quoteToken) === 0n || p.baseToken === p.quoteToken ||
        p.model !== 'constant-product' || p.feeBps !== 30 || p.finality !== 'finalized' ||
        !Object.hasOwn(VENUES, p.venue) || p.factory !== VENUES[p.venue] || p.source !== `ethereum-${p.venue}-rpc` ||
        p.blockNumber !== raw.blockNumber || p.blockHash !== raw.blockHash || p.capturedAtMs !== raw.capturedAtMs ||
        p.observedAtMs !== raw.observedAtMs || !Number.isInteger(p.baseDecimals) || p.baseDecimals < 0 || p.baseDecimals > 255 ||
        !Number.isInteger(p.quoteDecimals) || p.quoteDecimals < 0 || p.quoteDecimals > 255) throw new Error('Invalid research pool provenance');
    const baseReserve = units(p.baseReserve, 2n ** 112n - 1n), quoteReserve = units(p.quoteReserve, 2n ** 112n - 1n);
    if (!baseReserve || !quoteReserve) throw new Error('Empty research reserves');
    // A stored fixture-style flag can never establish real token safety.
    return { ...p, baseReserve, quoteReserve, tokenChecksPassed: null };
  });
  if (new Set(pools.map(p => p.address)).size !== pools.length) throw new Error('Duplicate research pools');
  if (pools.some(p => p.baseToken !== pools[0].baseToken || p.quoteToken !== pools[0].quoteToken ||
      p.baseDecimals !== pools[0].baseDecimals || p.quoteDecimals !== pools[0].quoteDecimals)) throw new Error('Mixed research token units');
  const quote = pools.length ? quotes.get(pools[0].quoteToken) : null;
  if (pools.length && (!quote || quote.decimals !== pools[0].quoteDecimals)) throw new Error('Unsupported research quote');
  if (!raw.gas || raw.gas.blockNumber !== raw.blockNumber || raw.gas.blockHash !== raw.blockHash ||
      raw.gas.source !== 'pinned-rpc-header') throw new Error('Invalid research gas identity');
  const snapshot = { ...raw, pools, gas: { ...raw.gas, baseFeePerGasWei: optionalUnits(raw.gas.baseFeePerGasWei) } };
  const options = { inputsQuote: policy.inputsQuote.map(v => units(v)), gasUnits: optionalUnits(policy.gasUnits),
    priorityFeeWei: optionalUnits(policy.priorityFeeWei), bufferBps: policy.bufferBps,
    baseFeeFactorBps: policy.baseFeeFactorBps, budgetQuote: optionalUnits(policy.budgetQuote), minNetQuote: units(policy.minNetQuote) };
  // Re-evaluate raw inputs. Saved report fields and claimed winners are not authoritative.
  const analysis = compareSizes(snapshot, options, nowMs);
  const age = nowMs - raw.capturedAtMs;
  const freshness = age < 0 ? 'invalid-time' : age > MAX_CAPTURE_AGE_MS ? 'stale' : 'recent-capture';
  const tokens = pools.length ? [pools[0].baseToken, pools[0].quoteToken] : [];
  const best = analysis.bestScenario;
  const sizing = pools.length ? { pair: `1:${[...tokens].sort().join(':')}`,
    quoteToken: pools[0].quoteToken, quoteDecimals: quote.decimals,
    candidateCount: analysis.candidates.length, costAvailable: analysis.costScenario?.available === true,
    minNetQuote: analysis.policy.minNetQuote,
    aboveThreshold: best !== null && best.scenarioNetQuote > analysis.policy.minNetQuote,
    bestInputQuote: best?.inputQuote ?? null, bestScenarioNetQuote: best?.scenarioNetQuote ?? null,
    reasons: best?.reasons ?? ['NO_COSTED_CANDIDATE'],
    blockNumber: raw.blockNumber, blockHash: raw.blockHash } : null;
  return serializable({ schemaVersion: 1, available: true, dataset: 'saved-research', freshness,
    blockNumber: raw.blockNumber, blockHash: raw.blockHash, capturedAtMs: raw.capturedAtMs,
    observedAtMs: raw.observedAtMs, finality: 'finalized', qualifiedOpportunities: 0, netProfitKnown: false,
    quoteLabel: quote?.label ?? null, observations: pools.map(p => ({ chainId: 1, pool: p.address,
      tokens: [p.baseToken, p.quoteToken], blockNumber: p.blockNumber, blockHash: p.blockHash,
      capturedAtMs: p.capturedAtMs, spotGapBps: null, reasons: ['TOKEN_CHECKS_UNKNOWN', 'HISTORICAL_RESEARCH_ONLY'] })),
    sizing, analysis, limitations: ['Saved research, not live execution evidence.',
      'Scenario costs are assumed. Actual net and token safety remain unknown.',
      'Recomputation checks consistency, not authenticity of a trusted RPC provider.'] });
}

export async function loadResearch(directory, nowMs = Date.now()) {
  let checkpoint;
  try { checkpoint = await readJson(path.join(directory, 'checkpoint.json'), directory); }
  catch (error) {
    if (error.code === 'ENOENT') return { schemaVersion: 1, available: false, dataset: 'saved-research',
      freshness: 'unavailable', observations: [], sizing: null, analysis: null, qualifiedOpportunities: 0, netProfitKnown: false };
    throw error;
  }
  if (checkpoint?.schemaVersion !== 1 || checkpoint.chainId !== 1 || !namePattern.test(checkpoint.lastReport) ||
      !integer(checkpoint.blockNumber) || !hash.test(checkpoint.blockHash) || !integer(checkpoint.capturedAtMs)) throw new Error('Invalid research checkpoint');
  const archive = await readJson(path.join(directory, checkpoint.lastReport), directory);
  if (archive?.snapshot?.blockNumber !== checkpoint.blockNumber || archive.snapshot.blockHash !== checkpoint.blockHash ||
      archive.snapshot.capturedAtMs !== checkpoint.capturedAtMs) throw new Error('Research checkpoint mismatch');
  return normalizeResearch(archive, nowMs);
}

export async function saveResearch(directory, archive) {
  const content = json(archive);
  if (Buffer.byteLength(content) > 8 * 1024 * 1024) throw new Error('Research archive exceeds limit');
  const normalized = normalizeResearch(JSON.parse(content), archive.snapshot.capturedAtMs);
  await mkdir(directory, { recursive: true });
  const lockPath = path.join(directory, 'publish.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  try {
    let previous;
    try { previous = await readJson(path.join(directory, 'checkpoint.json'), directory); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (previous && (previous.schemaVersion !== 1 || previous.chainId !== 1 || !namePattern.test(previous.lastReport) ||
        !integer(previous.blockNumber) || !hash.test(previous.blockHash) ||
        !integer(previous.capturedAtMs) || previous.blockNumber > normalized.blockNumber ||
        previous.blockNumber === normalized.blockNumber && (previous.blockHash !== normalized.blockHash ||
          previous.capturedAtMs > normalized.capturedAtMs))) throw new Error('Research checkpoint conflict or regression');
    const name = `${normalized.blockNumber}-${normalized.blockHash.slice(2)}-${normalized.capturedAtMs}-${process.pid}.json`;
    const file = path.join(directory, name);
    await writeFile(file, content, { flag: 'wx', mode: 0o600 });
    const checkpoint = { schemaVersion: 1, chainId: 1, blockNumber: normalized.blockNumber,
      blockHash: normalized.blockHash, capturedAtMs: normalized.capturedAtMs, lastReport: name };
    const temporary = path.join(directory, `checkpoint.${process.pid}.tmp`);
    await writeFile(temporary, json(checkpoint), { mode: 0o600 });
    await rename(temporary, path.join(directory, 'checkpoint.json'));
    return file;
  } finally { await lock.close(); await unlink(lockPath); }
}
