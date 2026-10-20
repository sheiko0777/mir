# Offline V2 amount comparison

Run from the repository root after the separate reference package has been installed:

```powershell
node tools/rea/compare-v2.mjs
```

The harness requires exactly `@uniswap/v2-sdk@4.21.5` under `tools/rea/reference`. It resolves `@uniswap/sdk-core` from that SDK's entrypoint, uses synthetic token addresses, and performs no network, RPC, or wallet operations. It does not install dependencies or change application dependencies.

Results are written to `outputs/REA-Uniswap-V2/comparison.json`. Every quote includes raw integer inputs, reserves, token decimals and direction, both observed outcomes, and a classification. The deterministic generator's seed and recurrence are recorded. Unexpected differences or an unexpected SDK version produce a nonzero exit status.

The scope is `amountOut(input, reserveIn, reserveOut, 30)` against `Pair.getOutputAmount(inputAmount, false)`: standard 0.3% fee with transfer-fee calculations disabled. Cases cover positive reserves up to uint112, asymmetric pools, both swap directions, 6/18 decimal orientations, and sequential two-hop quotes across separate pools. Empty reserves and zero input must be rejected by both implementations; error classes need not agree.

When a positive input rounds to zero, LXR returns `0` and the SDK throws `InsufficientInputAmountError`. Those observations are explicitly classified as expected semantic differences. If the first hop has that difference, the route is recorded and a second quote is not attempted.

These are ordinary offline runtime observations, **not REA static Evidence**. Finite fixtures do not prove equivalence for all inputs. This comparison does not assess token contracts, fee-on-transfer tokens, dynamic fees, router execution, gas, live-chain behavior, or profitability.
