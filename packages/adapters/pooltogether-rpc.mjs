import { CLAIM_LIMITS, CLAIM_REFERENCE, BASE_WETH, encodeClaimRead } from '../bots/pooltogether.mjs';
import { CLAIM_EVENT_TOPIC, DISCOVERY_LIMITS } from '../bots/pooltogether-discovery.mjs';

export const CLAIM_PUBLIC_RPC = 'https://base-rpc.publicnode.com';
const hash = /^0x[0-9a-f]{64}$/;

// One public endpoint, no credentials, retries, redirects or transaction methods.
export function createClaimRpc({ fetchImpl = fetch, clock = Date.now } = {}) {
  const records = [], started = clock();
  let responseBytes = 0;
  const targetRoles = new Map([[CLAIM_REFERENCE.pool, 'pool'], [CLAIM_REFERENCE.claimer, 'claimer'], [BASE_WETH, 'token']]);
  const pin = value => value && hash.test(value.blockHash) && value.requireCanonical === true && Object.keys(value).length === 2;
  const read = async (method, params) => {
    let valid = false;
    if (method === 'eth_chainId') valid = Array.isArray(params) && params.length === 0;
    if (method === 'eth_getBlockByNumber') valid = Array.isArray(params) && params.length === 2 && params[1] === false &&
      (params[0] === 'latest' || typeof params[0] === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(params[0]));
    if (method === 'eth_getCode') valid = params?.length === 2 && targetRoles.has(params[0]) && pin(params[1]);
    if (method === 'eth_getLogs' && Array.isArray(params) && params.length === 1) {
      const filter = params[0];
      if (filter && Object.keys(filter).length === 4 && filter.address === CLAIM_REFERENCE.pool &&
          Array.isArray(filter.topics) && filter.topics.length === 1 && filter.topics[0] === CLAIM_EVENT_TOPIC &&
          [filter.fromBlock, filter.toBlock].every(n => typeof n === 'string' && /^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(n))) {
        const from = BigInt(filter.fromBlock), to = BigInt(filter.toBlock);
        valid = from <= to && to - from < BigInt(DISCOVERY_LIMITS.maxLookbackBlocks) && to <= BigInt(Number.MAX_SAFE_INTEGER);
      }
    }
    if (method === 'eth_call' && params?.length === 2 && pin(params[1])) {
      const call = params[0], role = targetRoles.get(call?.to) ??
        (typeof call?.to === 'string' && /^0x[0-9a-f]{40}$/.test(call.to) && BigInt(call.to) !== 0n ? 'vault' : null);
      if (role && Object.keys(call).length === 2 && typeof call.data === 'string' && /^0x[0-9a-f]+$/.test(call.data)) {
        const entry = Object.entries(CLAIM_REFERENCE.functions).find(([name, abi]) => name.startsWith(role + '.') && call.data.startsWith(abi.selector));
        if (entry) {
          const [name, abi] = entry;
          if (call.data.length === 10 + 64 * abi.inputs.length) {
            const values = abi.inputs.map((type, index) => {
              const word = call.data.slice(10 + index * 64, 74 + index * 64);
              return type === 'address' ? `0x${word.slice(24)}` : BigInt('0x' + word).toString();
            });
            valid = encodeClaimRead(name, values) === call.data;
          }
        }
      }
    }
    if (!valid) throw new Error('Only pinned, allowlisted PoolTogether reads are permitted');
    if (records.length >= CLAIM_LIMITS.maxCalls || clock() - started >= CLAIM_LIMITS.maxElapsedMs) throw new Error('Claim scan budget exhausted');
    const row = { method, params };
    records.push(row);
    const requestId = records.length;
    try {
      const response = await fetchImpl(CLAIM_PUBLIC_RPC, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(Math.max(1, Math.min(8000, CLAIM_LIMITS.maxElapsedMs - (clock() - started)))),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params }) });
      if (!response.ok) throw new Error(`Public RPC HTTP ${response.status}`);
      if (!response.body) throw new Error('Missing RPC body');
      const reader = response.body.getReader(), chunks = [];
      let bytes = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength; responseBytes += value.byteLength;
          if (bytes > 256 * 1024 || responseBytes > 2 * 1024 * 1024) throw new Error('RPC response budget exceeded');
          chunks.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); }
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (payload?.jsonrpc === '2.0' && payload.id === requestId && Number.isSafeInteger(payload.error?.code)) throw new Error(`Public RPC error ${payload.error.code}`);
      if (payload?.jsonrpc !== '2.0' || payload.id !== requestId || payload.error || !Object.hasOwn(payload, 'result')) throw new Error('Invalid RPC envelope');
      row.result = payload.result;
      return row.result;
    } catch (error) {
      // Keep a bounded classification, not provider bodies or arbitrary transport text.
      row.error = /^Public RPC (HTTP \d{3}|error -?\d+)$/.test(error.message) ? error.message : 'Public RPC unavailable or invalid';
      throw new Error(row.error);
    }
  };
  return { read, records, source: { kind: 'public-rpc', url: CLAIM_PUBLIC_RPC },
    metrics: () => ({ requests: records.length, responseBytes, elapsedMs: clock() - started, retries: 0 }) };
}
