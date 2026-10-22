// Scope one instance to one provider and one collection cycle. Headers and chain
// identity always reach the provider so canonical checks cannot be hidden.
export function cachePinnedReads(read, { maxEntries = 1000 } = {}) {
  if (typeof read !== 'function' || !Number.isInteger(maxEntries) || maxEntries < 1 || maxEntries > 10000)
    throw new Error('Invalid pinned cache policy');
  const entries = new Map();
  let hits = 0, misses = 0, bypasses = 0;
  const rpc = async (method, params = []) => {
    const [call, pin] = params;
    const eligible = method === 'eth_call' && params.length === 2 && call && pin &&
      Object.keys(call).length === 2 && Object.keys(call).every(k => ['to', 'data'].includes(k)) &&
      Object.keys(pin).length === 2 && pin.requireCanonical === true &&
      /^0x[0-9a-f]{40}$/i.test(call.to) && /^0x[0-9a-f]+$/i.test(call.data) &&
      /^0x[0-9a-f]{64}$/i.test(pin.blockHash);
    if (!eligible) { bypasses++; return read(method, params); }
    const key = JSON.stringify([pin.blockHash, call.to, call.data]);
    if (entries.has(key)) { hits++; return entries.get(key); }
    misses++;
    // The underlying adapter still enforces method/selector permissions.
    const value = await read(method, params);
    if (typeof value === 'string' && /^0x(?:[0-9a-f]{2})*$/i.test(value) && entries.size < maxEntries)
      entries.set(key, value);
    return value;
  };
  return { rpc, metrics: () => ({ hits, misses, bypasses, entries: entries.size, maxEntries,
    scope: 'single-provider-single-collection', headersCached: false }) };
}
