const quantity = /^0x(?:0|[1-9a-f][0-9a-f]*)$/i;
const address = /^0x[0-9a-f]{40}$/i;
const slot = /^0x[0-9a-f]{1,64}$/i;
const reads = new Map([['0xe6a43905',138],['0xc45a0155',10],['0x0dfe1681',10],
  ['0xd21220a7',10],['0x0902f1ac',10],['0x313ce567',10],['0xad5c4648',10],['0xd06ca61f',330]]);
export function validateForkRead(method, params, pin, addresses, { bootstrapBlock='finalized' }={}) {
  if (!Array.isArray(params)) throw new Error('Invalid parameters');
  if (method === 'eth_chainId' || method === 'net_version') {
    if (params.length === 0) return;
  }
  if (method === 'eth_getBlockByNumber' && params.length === 2 && typeof params[1] === 'boolean' &&
      (pin ? params[0] === pin.number : (bootstrapBlock === 'finalized' || quantity.test(bootstrapBlock)) && params[0] === bootstrapBlock && params[1] === false)) return;
  if (!pin) throw new Error('Pinned source block required');
  if (method === 'eth_getBlockByHash' && params.length === 2 && params[0] === pin.hash && typeof params[1] === 'boolean') return;
  const known = value => typeof value === 'string' && address.test(value) && addresses.has(value.toLowerCase());
  const block = value => value === pin.number || (value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(k=>['blockHash','requireCanonical'].includes(k)) && value.blockHash === pin.hash &&
    (value.requireCanonical === undefined || value.requireCanonical === true));
  if (['eth_getCode','eth_getBalance','eth_getTransactionCount'].includes(method) && params.length === 2 && known(params[0]) && block(params[1])) return;
  if (method === 'eth_getStorageAt' && params.length === 3 && known(params[0]) && slot.test(params[1]) && block(params[2])) return;
  if (method === 'eth_getProof' && params.length === 3 && known(params[0]) && Array.isArray(params[1]) &&
      params[1].length <= 32 && params[1].every(s => typeof s === 'string' && slot.test(s)) && block(params[2])) return;
  if (method === 'eth_call' && params.length === 2 && block(params[1])) {
    const call = params[0];
    if (call && Object.keys(call).every(k => ['to','data'].includes(k)) && known(call.to) &&
        typeof call.data === 'string' && /^0x[0-9a-f]+$/i.test(call.data) &&
        reads.get(call.data.slice(0,10).toLowerCase()) === call.data.length) return;
  }
  throw new Error('Only pinned allowlisted source reads are permitted');
}
export function validPin(header, nowMs = Date.now(), historical = false) {
  if(typeof historical !== 'boolean') throw new Error('Invalid historical mode');
  if (!header || !quantity.test(header.number) || !/^0x[0-9a-f]{64}$/i.test(header.hash) ||
      !quantity.test(header.timestamp) || BigInt(header.number) > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Invalid source header');
  const age = nowMs - Number(BigInt(header.timestamp)) * 1000;
  if (!Number.isSafeInteger(age) || age < 0 || !historical && age > 30 * 60 * 1000) throw new Error('Stale or future source block');
  return header;
}
