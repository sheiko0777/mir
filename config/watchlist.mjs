// Research selection only; this does not certify token safety or recommend a trade.
// Addresses independently checked by factory membership and token reads at runtime.
export const watchlist = Object.freeze({
  name: 'USDC / WETH', chainId: 1,
  tokens: Object.freeze(['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']),
  quoteDecimals: 18, inputQuote: 10n ** 17n // 0.1 WETH research size
});
