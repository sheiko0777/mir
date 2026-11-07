# MIR multi-bot research lab

## Current integration

MIR coordinates independent research tracks through `GET /api/bots` and the bot
cards in `/lab.html`. LXR remains the internal liquidity engine. WADJ Studio stays
the parent studio. Local commands run analysis, and the HTTP endpoint displays
recomputed evidence and proposed tasks.

| Track | Implemented | Remaining gate |
|---|---|---|
| LXR Liquidity | Existing reserve, size and cost analysis connected to the coordinator | Token transfer behavior, fresh evidence and independent net-return validation |
| Carry Research | Funding diagnostics, HYPE history, native depth cost estimates and cost stresses | Synchronized historical executable-side prices, complete costs, prospective policy and holdout |
| Kronos Forecast | Source-pinned adapter, separate sampled paths, closed-candle checks and runtime preflight | Reviewed Python runtime, pinned local weights/tokenizer, actual inference and forecast evaluation |
| Prediction Markets | Reviewed Polymarket SDK and OpenMarket sources mapped to the research track | Public feed adapter, timestamp alignment, settlement identity and cost-aware replay |

The coordinator proposes five bounded tasks with stable evidence-based IDs. It
dispatches zero network actions. Its report retains historical evidence dates,
missing prerequisites and a qualification count of zero. The approved research
limits are recorded as 5% carry drawdown, 15% new-token drawdown and at least 30
forward days. Portfolio enforcement across active strategies remains a later gate.

```text
npm run bots:review
python tools/research/kronos_adapter.py --check
python tools/research/carry_entry.py <saved-market-capture.json>
python tools/research/funding_probe.py --days 90 --coins HYPE
npm start
```

Reviews are content-addressed local records under `data/bots/reviews`. Loading the
API validates Lab object hashes and recalculates LXR research from its committed
raw inputs. Invalid source evidence produces HTTP 503 and an empty bot view.

## Kronos adapter

The adapter loads the reviewed source at commit
`67b630e67f6a18c9e9be918d9b4337c960db1e9a` from the local source checkout. It checks
the three imported source files against Git before loading them. Model assets
belong under `tools/models/kronos-small` and
`tools/models/kronos-tokenizer-base`. Runtime and model installation are pending.
Package and model provenance must be recorded before an evaluated model run.

```text
python tools/research/kronos_adapter.py --context <closed-candles.json> --horizon 24 --samples 8
```

Context JSON uses `schemaVersion: 1`, `kind: "ohlcv-context"`, `market`,
`intervalMs`, `asOfMs`, and 16–512 `rows`. Each row contains `timeMs` for candle
open time and decimal strings for `open`, `high`, `low`, `close`, `volume`.
Times must be contiguous, and candles must have closed by `asOfMs`. The latest
completed candle must be present. The model receives only this context and the
derived future timestamp grid.

Upstream `sample_count` averages outputs internally. MIR requests each path with
`sample_count=1` and preserves 2–16 distinct path arrays, seeds, generation time,
input hash and the last-close baseline. CPU generation has a 180-second admission
budget checked between paths. An individual inference call can exceed that budget.
The adapter keeps model outputs as forecast evidence awaiting observed outcomes
and cost evaluation. Model runtime execution remains unverified in this delivery.

## Observed carry inputs

The local HYPE archive collected on 2026-10-30 has 2,160 hourly settlements,
1,956 positive and 204 negative intervals. Its normalized short-funding sum is
253.233156 bps over 90 days. Import registered three historical diagnostics in Lab.
The separate eight-market capture used 11 public requests. HYPE native spot pair
`@107` and perpetual `HYPE` share a book timestamp in that capture. Oracle context
has a request interval, while its underlying source timestamp remains unknown.

`carry_entry.py` recomputes four-side depth and assumed base-tier taker fees for
500/5,000/50,000 USDC budgets. Conditional constant-rate, unchanged-book recovery
times for known costs were 32/32/34 hours and 64/64/66 hours with doubled fees.
These horizons depend on the captured rate and future prices/liquidity assumptions.
Other costs and net return remain unknown. USDC-to-USD conversion is an open input.

## Source reuse and further research

| Resource | Decision and purpose |
|---|---|
| [Kronos](https://github.com/shiyu-coder/Kronos) · MIT | Downloaded and source-pinned. Adapter contract tested using a controlled predictor. Runtime and weights pending. |
| [AgentDiscover](https://github.com/mhdfb/AgentDiscover) | Reference for independent evaluator, persistent evidence and bounded sessions. Current checkout has no discovered code license, so the coordinator is MIR code. |
| [ShinkaEvolve](https://github.com/SakanaAI/ShinkaEvolve) · Apache-2.0 | Downloaded. Candidate for experiment genealogy views after local format adaptation. |
| [MiroFish](https://github.com/666ghj/MiroFish) · AGPL-3.0 | Downloaded. Graphic/social simulation reuse deferred pending license fit and measured value. |
| [Polymarket SDK](https://github.com/Polymarket/ts-sdk) · MIT | Downloaded. Review public reads before exposing a bounded adapter. |
| [OpenMarket](https://github.com/gregyoung14/openmarket/tree/v0.5.2) · Apache-2.0 | Source downloaded at release `v0.5.2`. Candidate for timing-aware replay. The large historical corpus remains external. |
| [Qlib](https://github.com/microsoft/qlib) · MIT | Reviewed project documentation. Candidate for research workflow and model/baseline comparisons. Installation deferred until a matching dataset contract exists. |
| [TradingAgents](https://github.com/TauricResearch/TradingAgents) · Apache-2.0 | Reviewed project documentation. Candidate for explanatory research roles after model-call costs and evaluator boundaries are specified. |
| [Freqtrade lookahead analysis](https://github.com/freqtrade/freqtrade/blob/develop/docs/lookahead-analysis.md) | Review method for future-information leakage and isolated strategy testing. Engine installation deferred. |

Downloaded references are recorded in `work/upstream-video-sources/README.md` with
commits and entry points. They remain separate from MIR runtime imports except
the explicitly invoked, verified local Kronos adapter. Further qualification
requires a positive independent net result, cost stress survival and frozen
forward tracking with all losses retained.
