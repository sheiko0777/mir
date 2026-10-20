# Two-venue liquidity research

Run from the starter directory:

```sh
npm test
npm run research
```

The research command selects USDC/WETH on Ethereum and queries Uniswap V2 and SushiSwap V2 using one finalized block hash. Both factory addresses are explicitly allowlisted. Pool addresses are obtained via each factory's `getPair`, then independently checked through pool `factory`, `token0`, `token1`, reserve and decimals reads. A reverse factory lookup must agree. It does not scan unrelated tokens.

The selected pair is a bounded engineering example, not a token safety certification. Addresses and the canonical base/quote orientation come from `config/watchlist.mjs` and verified contract reads. Base is USDC and quote is WETH for this pair; input size is 0.1 WETH in atomic units. No dollar conversion or stablecoin price assumption is made.

New results are archived in ignored `data/research/<block>-<hash>-<capture-ms>-<pid>.json`, keeping captures/scenarios separate instead of overwriting a prior report for the same block. Earlier `<block>-<hash>.json` archives remain historical records. Each file contains normalized snapshots and the original LXR report. That report evaluates both directions using actual reserves, 30-basis-point fees and integer rounding. `grossAfterPoolFeesQuote` includes reserve price impact but excludes gas and uncertainty costs. `netQuote` stays null, `status` stays `unqualified`, and research output cannot enter PaperLedger. A positive gross number is not an actionable opportunity.

An additional `sizedReport` evaluates the bounded input grid with optional explicit gas assumptions. It retains the pinned header base fee and reports only `scenarioNetQuote`, distinct from actual net profit. Unknown costs are not replaced with zero. See [sizing commands and limitations](SIZING.md).

No pair on a venue is reported as `PAIR_NOT_FOUND`; malformed or inconsistent pool responses stop collection. One available pool produces zero comparison routes. The report retains exclusions so zero routes cannot be mistaken for a complete market search with no spread. Snapshots older than 30 minutes are flagged by LXR, with no fallback to latest unpinned reads. This is historical finalized-state research; it makes no claim about present execution.

All existing live-monitor limitations apply: one trusted public RPC, no full historical reorg invalidation, no bytecode proof, no durable paper journal, and no token behavior audit. The research command runs once and does not start a background process. Read-only venue support is not an execution integration.

Sources checked 18 October 2026:

- [Uniswap V2 deployment addresses](https://developers.uniswap.org/docs/protocols/v2/deployments)
- [SushiSwap Ethereum factory deployment](https://github.com/sushiswap/v2-core/blob/master/deployments/ethereum/UniswapV2Factory.json)
- [SushiSwap pair fee/invariant source](https://github.com/sushiswap/v2-core/blob/master/contracts/UniswapV2Pair.sol)

Next: compare the local quotes against read-only protocol router quotes at the same pinned block, add independently evidenced token-risk observations, and supply a timestamped gas estimate plus an explicit uncertainty budget. Only then design a separate durable paper-fill scenario; live execution remains outside scope.

## Costed-size collection — 20 October 2026

A bounded read-only run collected both venues at finalized block `26233530`, hash `0x436be145fc3231f336c742d5c24366d6208ba411e77402a7b5519b2c98268c24`. The same pinned header supplied base fee `41013154` wei per gas. The run evaluated 16 size/direction candidates with explicitly assumed 300000 gas units, 1000000000 wei priority fee and a 50-basis-point input buffer. Result: `no-positive-scenario`, zero qualified opportunities. This single historical observation under assumptions does not establish that all markets or sizes lack opportunities. The complete report remains local in ignored `data/research`.

## Verified collection — 18 October 2026

All 16 tests passed. A live read-only run collected both pools at finalized Ethereum block **26220488**, hash `0xe3f3b5eb766cde3b7c96a0ded87f11fd125d9922b84e4f657cece1a1d8cc95df`.

| Direction | Starting WETH | Returned WETH after pool fees and price impact | Difference before gas |
|---|---:|---:|---:|
| Uniswap V2 → SushiSwap V2 | 0.1 | 0.099108027859467792 | -0.000891972140532208 |
| SushiSwap V2 → Uniswap V2 | 0.1 | 0.099343406942788236 | -0.000656593057211764 |

These historical reserve calculations show no positive gross spread for the tested size. Gas and an uncertainty budget were not supplied, so net profit is unknown rather than reported as zero. Both routes remained unqualified; no paper balance was changed. The run saved raw snapshots and the report in `data/research/26220488-e3f3b5eb766cde3b7c96a0ded87f11fd125d9922b84e4f657cece1a1d8cc95df.json`. No background monitor was left running.
