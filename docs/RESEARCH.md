# Two-venue liquidity research

Run from the starter directory:

```sh
npm test
npm run research
```

The research command selects USDC/WETH on Ethereum and queries Uniswap V2 and SushiSwap V2 using one finalized block hash. Both factory addresses are explicitly allowlisted. Pool addresses are obtained via each factory's `getPair`, then independently checked through pool `factory`, `token0`, `token1`, reserve and decimals reads. A reverse factory lookup must agree. It does not scan unrelated tokens.

The selected pair is a bounded engineering example, not a token safety certification. Addresses and the canonical base/quote orientation come from `config/watchlist.mjs` and verified contract reads. Base is USDC and quote is WETH for this pair; input size is 0.1 WETH in atomic units. No dollar conversion or stablecoin price assumption is made.

The result is archived in ignored `data/research/<block>-<hash>.json` with both raw normalized snapshots and an LXR report. The report evaluates both directions using actual reserves, 30-basis-point pool fees and integer rounding. `grossAfterPoolFeesQuote` already includes reserve price impact, but excludes gas and uncertainty costs. `netQuote` is always null, `status` is always `unqualified`, and the research output cannot enter PaperLedger. A positive gross number is not an actionable opportunity. Unknown token checks, gas valuation and buffer assumptions remain explicit blockers.

No pair on a venue is reported as `PAIR_NOT_FOUND`; malformed or inconsistent pool responses stop collection. One available pool produces zero comparison routes. The report retains exclusions so zero routes cannot be mistaken for a complete market search with no spread. Snapshots older than 30 minutes are flagged by LXR, with no fallback to latest unpinned reads. This is historical finalized-state research; it makes no claim about present execution.

All existing live-monitor limitations apply: one trusted public RPC, no full historical reorg invalidation, no bytecode proof, no durable paper journal, and no token behavior audit. The research command runs once and does not start a background process. Read-only venue support is not an execution integration.

Sources checked 18 October 2026:

- [Uniswap V2 deployment addresses](https://developers.uniswap.org/docs/protocols/v2/deployments)
- [SushiSwap Ethereum factory deployment](https://github.com/sushiswap/v2-core/blob/master/deployments/ethereum/UniswapV2Factory.json)
- [SushiSwap pair fee/invariant source](https://github.com/sushiswap/v2-core/blob/master/contracts/UniswapV2Pair.sol)

Next: compare the local quotes against read-only protocol router quotes at the same pinned block, add independently evidenced token-risk observations, and supply a timestamped gas estimate plus an explicit uncertainty budget. Only then design a separate durable paper-fill scenario; live execution remains outside scope.

## Verified collection — 18 October 2026

All 16 tests passed. A live read-only run collected both pools at finalized Ethereum block **26220488**, hash `0xe3f3b5eb766cde3b7c96a0ded87f11fd125d9922b84e4f657cece1a1d8cc95df`.

| Direction | Starting WETH | Returned WETH after pool fees and price impact | Difference before gas |
|---|---:|---:|---:|
| Uniswap V2 → SushiSwap V2 | 0.1 | 0.099108027859467792 | -0.000891972140532208 |
| SushiSwap V2 → Uniswap V2 | 0.1 | 0.099343406942788236 | -0.000656593057211764 |

These historical reserve calculations show no positive gross spread for the tested size. Gas and an uncertainty budget were not supplied, so net profit is unknown rather than reported as zero. Both routes remained unqualified; no paper balance was changed. The run saved raw snapshots and the report in `data/research/26220488-e3f3b5eb766cde3b7c96a0ded87f11fd125d9922b84e4f657cece1a1d8cc95df.json`. No background monitor was left running.
