// SYNTHETIC ONLY. Addresses and reserves are invented; no live pool is represented.
const a = digit => `0x${digit.repeat(40)}`;
export function fixturePools(nowMs) {
  const common = { chainId: 1, model: 'constant-product', baseToken: a('a'),
    quoteToken: a('b'), blockNumber: 100, observedAtMs: nowMs, feeBps: 30,
    tokenChecksPassed: true, source: 'synthetic-fixture' };
  return [
    { ...common, address: a('1'), baseReserve: 1_000n * 10n ** 18n, quoteReserve: 1_000_000n * 10n ** 6n },
    { ...common, address: a('2'), baseReserve: 1_000n * 10n ** 18n, quoteReserve: 1_030_000n * 10n ** 6n }
  ];
}
