# Bounded costed-size research

`packages/lxr/sizing.mjs` evaluates an explicit grid of 1–64 positive raw quote-token amounts against the existing same-chain constant-product route model. It reuses LXR's integer quote/risk gates and does no RPC inside the search. Up to 10 pools means at most 5760 route evaluations. Repeated sizes are deduplicated. “Best” means best of the tested grid, never global optimization.

Each candidate retains gross output after pool fees, `gasQuoteScenario`, `bufferQuoteScenario`, and `scenarioNetQuote`. Actual `netQuote` remains null; `qualified:false`, `paperFills:0` and `netProfitKnown:false` apply even when the modeled result is positive. Research output cannot be submitted to `PaperLedger`. Unknown token behavior is not promoted to safe behavior.

## Cost identity and assumptions

The read-only adapter now retains `baseFeePerGas` from the exact pinned Ethereum block, alongside number/hash. Missing base fee stays unknown; malformed quantities fail collection. No RPC write method or transaction selector was added.

For an explicitly supplied gas-unit count and priority fee, the model uses:

```text
scenarioGasPriceWei = ceil(pinnedBaseFeeWei × baseFeeFactorBps / 10000) + assumedPriorityFeeWei
gasNativeWei = assumedGasUnits × scenarioGasPriceWei
bufferQuote = ceil(inputQuote × bufferBps / 10000)
scenarioNetQuote = outputQuote − inputQuote − gasQuoteScenario − bufferQuote
```

The default base-fee factor is 10000 (historical base fee unchanged); a larger factor is a stress assumption. This is not `maxFeePerGas`, a transaction estimate, a future inclusion price or a full EIP-1559 simulator. The distinction follows the [EIP-1559 specification](https://eips.ethereum.org/EIPS/eip-1559). Gas units and the priority fee are caller assumptions, not RPC-derived estimates. Approval costs, reverting attempts, MEV and changes in state are not modeled.

WETH quotes use an explicit native/wrapped parity assumption and require Ethereum plus 18 decimals. Other quotes require a supplied finalized WETH/quote pool at the identical number/hash. Conversion uses the raw reserve ratio and rounds cost upward; it is a spot valuation assumption, not an independent oracle or executable conversion quote. No dollar peg is assumed. Missing conversion leaves costs and scenario net unknown.

Candidates that fail age, finality, size, dust or optional quote-denominated budget constraints cannot become the best candidate. The optional budget covers modeled input plus valued costs; it is not evidence of native gas balance or wallet funding. Token-risk evidence remains a separate unqualified gate. WETH and USDC outcomes are never combined into one numeric profit total.

## Commands

```sh
npm run size:demo
npm run research
node apps/monitor/research.mjs --gas-units 300000 --priority-fee-wei 1000000000 --size-steps 8 --buffer-bps 50
```

The first command is prominently labeled synthetic and has no network activity. The third is a **user-specified illustrative cost scenario**, not recommended transaction parameters. The default research command collects live observations but leaves scenario gas unknown unless both gas assumptions are supplied. Input sizes span up to the existing watchlist research amount. Reports add `sizedReport` alongside the original `report`, preserving existing consumers. Saved reports and modeled findings are not served as current opportunities.

## Reuse and verification

The MIT-licensed `@uniswap/v2-sdk@4.21.5` is an isolated reference dependency, not a production execution engine. `npm run test:sizing-reference` invokes its real `Pair.getOutputAmount` independently for each synthetic route and checks costs, constraints and winner selection. The SDK provides swap math; gas/buffer arithmetic is independently evaluated by the harness rather than attributed to the SDK. See [reuse policy](OPEN-SOURCE-REUSE.md).

Unfinished work includes measured gas execution profiles, independent FX/risk evidence, token taxes/rebasing, durable out-of-sample paper outcomes, historical latency measurements, and connection of the size matrix to the agent and UI. A scenario model alone does not establish net profitability.
