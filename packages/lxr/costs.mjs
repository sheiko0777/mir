export const WETH = '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2';
const address = /^0x[0-9a-f]{40}$/;
const hash = /^0x[0-9a-f]{64}$/;
const uint = x => typeof x === 'bigint' && x >= 0n && x < 2n ** 256n;
export const ceilDiv = (n, d) => {
  if (typeof n !== 'bigint' || n < 0n || typeof d !== 'bigint' || d <= 0n) throw new Error('Invalid rounding inputs');
  return (n + d - 1n) / d;
};

// A historical fee scenario, not a transaction estimate, fee quote or execution guarantee.
export function gasScenario(snapshot, { quoteToken, quoteDecimals, gasUnits = null, priorityFeeWei = null,
  baseFeeFactorBps = 10000, fxPool = null } = {}) {
  if (!snapshot || snapshot.chainId !== 1 || !Number.isSafeInteger(snapshot.blockNumber) || snapshot.blockNumber < 0 ||
      !hash.test(snapshot.blockHash) || !address.test(quoteToken) || !Number.isInteger(quoteDecimals) ||
      quoteDecimals < 0 || quoteDecimals > 255 || !Number.isInteger(baseFeeFactorBps) ||
      baseFeeFactorBps < 10000 || baseFeeFactorBps > 100000) throw new Error('Invalid cost identity or policy');
  if (gasUnits !== null && (!uint(gasUnits) || gasUnits === 0n || gasUnits > 10000000n) ||
      priorityFeeWei !== null && !uint(priorityFeeWei)) throw new Error('Invalid gas assumptions');
  const result = { available: false, model: 'historical-fee-scenario-v1', quoteToken, quoteDecimals,
    blockNumber: snapshot.blockNumber, blockHash: snapshot.blockHash, gasQuote: null, gasNativeWei: null,
    assumptions: { gasUnits, priorityFeeWei, baseFeeFactorBps, gasUnitsSource: 'user-scenario-not-estimated' }, reasons: [] };
  if (gasUnits === null || priorityFeeWei === null) result.reasons.push('GAS_ASSUMPTIONS_UNSET');
  const gas = snapshot.gas;
  if (gas != null && (gas.blockNumber !== snapshot.blockNumber || gas.blockHash !== snapshot.blockHash ||
      gas.baseFeePerGasWei !== null && !uint(gas.baseFeePerGasWei))) throw new Error('Invalid gas provenance');
  if (gas?.baseFeePerGasWei == null) result.reasons.push('BASE_FEE_UNAVAILABLE');
  if (result.reasons.length) return result;
  result.baseFeePerGasWei = gas.baseFeePerGasWei;
  result.scenarioGasPriceWei = ceilDiv(gas.baseFeePerGasWei * BigInt(baseFeeFactorBps), 10000n) + priorityFeeWei;
  result.gasNativeWei = gasUnits * result.scenarioGasPriceWei;
  result.reasons.push('GAS_UNITS_ASSUMED', 'PRIORITY_FEE_ASSUMED', 'FUTURE_FEES_UNCERTAIN');
  if (quoteToken === WETH) {
    if (quoteDecimals !== 18) throw new Error('Invalid WETH decimals');
    result.gasQuote = result.gasNativeWei;
    result.conversion = { kind: 'native-to-wrapped-parity-assumption' };
  } else {
    if (!fxPool) { result.reasons.push('NATIVE_QUOTE_CONVERSION_UNAVAILABLE'); return result; }
    const direct = fxPool.baseToken === WETH && fxPool.quoteToken === quoteToken;
    const reverse = fxPool.quoteToken === WETH && fxPool.baseToken === quoteToken;
    if (fxPool.chainId !== 1 || !address.test(fxPool.address) || (!direct && !reverse) ||
        fxPool.blockNumber !== snapshot.blockNumber || fxPool.blockHash !== snapshot.blockHash ||
        fxPool.finality !== 'finalized' || fxPool.model !== 'constant-product' ||
        !uint(fxPool.baseReserve) || !uint(fxPool.quoteReserve) || !fxPool.baseReserve || !fxPool.quoteReserve ||
        (direct ? fxPool.baseDecimals !== 18 || fxPool.quoteDecimals !== quoteDecimals :
          fxPool.quoteDecimals !== 18 || fxPool.baseDecimals !== quoteDecimals)) throw new Error('Invalid gas conversion pool');
    const nativeReserve = direct ? fxPool.baseReserve : fxPool.quoteReserve;
    const quoteReserve = direct ? fxPool.quoteReserve : fxPool.baseReserve;
    result.gasQuote = ceilDiv(result.gasNativeWei * quoteReserve, nativeReserve);
    result.conversion = { kind: 'same-block-reserve-spot-assumption', pool: fxPool.address,
      nativeReserve, quoteReserve, blockHash: fxPool.blockHash };
    result.reasons.push('FX_SPOT_RATE_ASSUMED');
  }
  result.available = true;
  return result;
}
