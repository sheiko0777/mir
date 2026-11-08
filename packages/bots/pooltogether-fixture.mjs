import { BASE_WETH, CLAIM_REFERENCE, encodeClaimRead } from './pooltogether.mjs';

// Fictional protocol state for deterministic failure/positive controls. No market evidence.
export function illustrativeClaimSession() {
  const vault = '0x1111111111111111111111111111111111111111';
  const seeds = [1, 2, 3].map(n => ({ vault, winner: `0x${String(n + 1).repeat(40)}`, tier: 1, prizeIndex: 0 }));
  const watchlist = { schemaVersion: 1, chainId: 8453, seeds, costs: {
    executionWei: '10', l1Wei: '2', operatorWei: '1', withdrawalWei: '3', failedAttemptsWei: '4', computeAndDataWei: '5', maintenanceWei: '5' } };
  const header = { number: '0x64', hash: `0x${'ab'.repeat(32)}`, timestamp: '0x3e8' };
  const word = n => `0x${BigInt(n).toString(16).padStart(64, '0')}`;
  const results = new Map();
  const result = (method, values, value) => results.set(encodeClaimRead(method, values), word(value));
  result('claimer.prizePool()', [], CLAIM_REFERENCE.pool);
  result('pool.prizeToken()', [], BASE_WETH);
  result('token.decimals()', [], 18);
  result('pool.getLastAwardedDrawId()', [], 7);
  result('pool.numberOfTiers()', [], 3);
  result('pool.getTierPrizeCount(uint8)', [1], 4);
  for (let i = 0; i < seeds.length; i++) {
    const s = seeds[i], args = [s.vault, s.winner, s.tier, s.prizeIndex];
    result('pool.isWinner(address,address,uint8,uint32)', args, i === 2 ? 0 : 1);
    result('pool.wasClaimed(address,address,uint8,uint32)', args, i === 1 ? 1 : 0);
  }
  result('claimer.computeTotalFees(uint8,uint256)', [1, 1], 100);
  const records = [];
  const read = async (method, params) => {
    let value;
    if (method === 'eth_chainId') value = '0x2105';
    else if (method === 'eth_getBlockByNumber') value = structuredClone(header);
    else if (method === 'eth_getCode') value = '0x6000';
    else if (method === 'eth_call') value = results.get(params[0].data);
    if (value === undefined) throw new Error('Unexpected fixture read');
    records.push({ method, params: structuredClone(params), result: value });
    return value;
  };
  return { watchlist, capturedAtMs: 1_001_000, records, read,
    source: { kind: 'illustrative-fixture', label: 'FICTIONAL SAMPLE - NOT PROTOCOL EARNINGS' } };
}
