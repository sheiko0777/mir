// Integer units throughout: quote/base reserves must use their token's atomic units.
// Scope: same-chain, same-token two-pool constant-product AMMs only.
const BPS = 10_000n;
const address = /^0x[0-9a-fA-F]{40}$/;

function units(value, name, allowZero = false) {
  if (typeof value !== 'bigint' || (allowZero ? value < 0n : value <= 0n)) {
    throw new TypeError(`${name} must be ${allowZero ? 'nonnegative' : 'positive'} bigint`);
  }
}

function validatePool(pool) {
  if (!pool || !Number.isSafeInteger(pool.chainId) || pool.chainId <= 0 ||
      !address.test(pool.address) || !address.test(pool.baseToken) ||
      !address.test(pool.quoteToken) || pool.baseToken.toLowerCase() === pool.quoteToken.toLowerCase() ||
      !Number.isSafeInteger(pool.blockNumber) || pool.blockNumber < 0 ||
      !Number.isSafeInteger(pool.observedAtMs) || pool.observedAtMs < 0 ||
      !Number.isInteger(pool.feeBps) || pool.feeBps < 0 || pool.feeBps >= 10_000 ||
      pool.model !== 'constant-product') throw new TypeError('Invalid pool snapshot');
  units(pool.baseReserve, 'baseReserve');
  units(pool.quoteReserve, 'quoteReserve');
}

export function amountOut(input, reserveIn, reserveOut, feeBps) {
  units(input, 'input');
  units(reserveIn, 'reserveIn');
  units(reserveOut, 'reserveOut');
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) throw new RangeError('Invalid fee');
  const effective = input * (BPS - BigInt(feeBps));
  return effective * reserveOut / (reserveIn * BPS + effective);
}

export function assessRoute(buy, sell, input, costs, policy) {
  validatePool(buy);
  validatePool(sell);
  units(input, 'input');
  units(costs.gasQuote, 'gasQuote', true);
  units(costs.bufferQuote, 'bufferQuote', true);
  units(policy.minNetQuote, 'minNetQuote', true);
  for (const key of ['nowMs', 'maxAgeMs', 'maxBlockLag', 'maxInputBps']) {
    if (!Number.isSafeInteger(policy[key]) || policy[key] < 0) throw new TypeError(`Invalid ${key}`);
  }
  if (policy.maxInputBps > 10_000) throw new RangeError('maxInputBps exceeds 10000');
  if (buy.chainId !== sell.chainId || buy.baseToken.toLowerCase() !== sell.baseToken.toLowerCase() ||
      buy.quoteToken.toLowerCase() !== sell.quoteToken.toLowerCase() ||
      buy.address.toLowerCase() === sell.address.toLowerCase()) throw new Error('Incompatible route');

  const reasons = [];
  for (const pool of [buy, sell]) {
    const age = policy.nowMs - pool.observedAtMs;
    if (age < 0 || age > policy.maxAgeMs) reasons.push('STALE_OR_FUTURE_SNAPSHOT');
    // Unknown token behavior is rejected; this flag is fixture evidence, not an audit.
    if (pool.tokenChecksPassed !== true) reasons.push('TOKEN_CHECKS_UNKNOWN_OR_FAILED');
  }
  if (Math.abs(buy.blockNumber - sell.blockNumber) > policy.maxBlockLag) reasons.push('BLOCK_MISMATCH');
  if (input * BPS > buy.quoteReserve * BigInt(policy.maxInputBps)) reasons.push('BUY_SIZE_LIMIT');

  const baseOut = amountOut(input, buy.quoteReserve, buy.baseReserve, buy.feeBps);
  const quoteOut = baseOut === 0n ? 0n : amountOut(baseOut, sell.baseReserve, sell.quoteReserve, sell.feeBps);
  if (baseOut === 0n || quoteOut === 0n) reasons.push('DUST_OUTPUT');
  if (baseOut * BPS > sell.baseReserve * BigInt(policy.maxInputBps)) reasons.push('SELL_SIZE_LIMIT');
  const netQuote = quoteOut - input - costs.gasQuote - costs.bufferQuote;
  if (netQuote <= policy.minNetQuote) reasons.push('NET_BELOW_THRESHOLD');
  return Object.freeze({ mode: 'paper', input, baseOut, quoteOut, gasQuote: costs.gasQuote,
    bufferQuote: costs.bufferQuote, netQuote, eligible: reasons.length === 0,
    reasons: Object.freeze([...new Set(reasons)]) });
}
