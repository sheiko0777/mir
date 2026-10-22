# MIR Lab — implementation and remaining gates

The approved research plan remains the scope. This is a progress ledger, not a completion declaration. No qualified strategy, real trade, or 30-day forward observation has been established.

## Implemented and verified

- Content-addressed immutable funding datasets and experiment definitions in `data/lab`. File hashes and input fields are verified on read; results are recalculated, never accepted from saved winners. The directory is local and excluded from Git.
- Three read-only endpoints: `/api/lab/datasets`, `/api/lab/experiments`, `/api/lab/experiments/:id`. Missing datasets return an empty listing, corrupt evidence returns unavailable, unknown IDs return 404, writes return 405.
- `lab.html` displays actual datasets and funding diagnostics, unknown net profit, assumptions and missing evidence. No simulated sample fallback. Mobile widths and clearing results on endpoint failure are browser-tested.
- Capital labels 500/5,000/50,000 USD in diagnostic experiments do not imply computed returns: the funding diagnostic is normalized and independent of capital.
- Public funding collector supports bounded pagination and `--days 90`. Complete hourly coverage is required; raw timestamps remain preserved. 90-day BTC/ETH/SOL observations were collected (2,160 each), distinct from the earlier seven-day dataset.
- DuckDB 1.5.6 and PyArrow 26.0.0 installed into an isolated Python environment; wheel hashes, licenses and platform-specific lock recorded. Parquet rebuilt from verified datasets and reconciled with DuckDB. Overlapping datasets remain separate and must not be summed together.
- Independent fixed-quantity carry scenario includes matched spot/perp quantity, oracle funding, executable-side quote inputs, four-side fees, explicit other costs, 50% spot/30% margin/20% reserve allocation, 5% drawdown stop and assumed maintenance-margin check. Tests use synthetic inputs. No synchronized real price/depth data has yet been supplied to this model. Intrahour liquidation and actual fills are unmodeled.
- CCXT 4.5.89 and 21 dependencies installed in the isolated environment from hash-pinned binary wheels. Installed versions and 31 license/notice files retained in `ccxt-resources.json` and `licenses/ccxt-dependencies`. `pip check` passed. This is a dependency/license review, not a security audit.
- Public Hyperliquid adapter permits only four metadata request types and L2 books on the exact public info URL. It rejects account/trade requests before transport, disables redirects, bounds capture to 20 requests and 180 seconds of admission time, and records failed requests. The research agent is not given the underlying CCXT exchange instance.
- A real six-market capture completed in nine requests. Native decimal-string depth is preserved alongside normalized CCXT books; calculations consume native strings. BTC/ETH/SOL spot and perpetual symbols are candidate representations, not proof of equivalent underlying exposure. Snapshot source age, request p50/p95, failures and identity mismatches are recomputed for Lab display. Raw evidence is omitted from list responses.
- Decimal depth estimates support buy/sell, weighted prices and partial depth. Empty/crossed/unsorted books, identity mismatch, nonfinite values and source age above five seconds are rejected. Estimates explicitly report zero actual fills. A one-unit probe is a validation exercise, not the 500/5,000/50,000 USD allocation experiment.

## Reproduce locally

```text
python tools/research/funding_probe.py --days 90
node apps/monitor/lab-import.mjs <saved-funding-report.json>
tools/research/.venv/Scripts/python.exe tools/research/market_capture.py
python tools/research/inspect_capture.py <saved-market-capture.json>
node apps/monitor/lab-import-market.mjs <saved-market-capture.json>
tools/research/.venv/Scripts/python.exe tools/research/warehouse.py
npm start
```

Open `/lab.html`. Import is explicit and creates a new registration time; repeated imports preserve existing objects and create additional experiment registrations. This is not an automatic trading or forward-observation scheduler.

Environment recovery on Windows x64 CPython 3.14:

```text
python -m venv tools/research/.venv
tools/research/.venv/Scripts/python.exe -m pip install --only-binary=:all: --no-deps --require-hashes -r tools/research/requirements-win-cp314.lock
tools/research/.venv/Scripts/python.exe -m pip install --only-binary=:all: --no-deps --require-hashes -r tools/research/ccxt-win-cp314.lock
tools/research/.venv/Scripts/python.exe tools/research/audit_ccxt.py
```

Other platforms require their own reviewed wheel hashes. Optional DuckDB extras were not installed. Tests: `npm test` and the five `tools/research/test_*.py` files (funding, carry, public guard, depth, native/normalized comparison). Market imports create datasets without creating a strategy experiment. Funding Parquet excludes market snapshots. The six captured normalized books matched their native price/size conversions and timestamps; float comparisons validate parser behavior only, while calculations retain native Decimal strings.

## Remaining work — do not mark complete

| Plan requirement | Current gap / next gate |
|---|---|
| Frozen hypotheses, 60/30 holdout and stress approval | Diagnostic definitions exist; no holdout evaluator, no approvals |
| Spot/perp depth and synchronized pricing | Collect both legs with exact market identity and quote timestamps; do not use funding alone |
| CCXT public-data adapter | Installed and exercised against native depth; next: sustained capture, synchronized legs, exact hedge identity and cost policy |
| Lending and PT baselines | Add verified sources and unit/redemption accounting |
| Cross-venue and dated futures | Add settlement/funding alignment and fragmented collateral model |
| Resumable event index | Existing factory offsets are not event timestamps; add event journal with reorg handling |
| Ethereum V3, Base and Solana | Not implemented; require separate reference-pricing checks before admission |
| Token checks and fork sell simulation | Not implemented; unknown token behavior remains a rejection reason |
| Foundry and protocol SDKs | Not installed by this stage; install at the relevant adapter gate |
| Lab agent scheduling | Existing agent remains separate; lab currently only returns next-task suggestions |
| Full portfolio risk | Carry scenario checks 5% drawdown only; 15% new-token track and portfolio limits still require integration |
| Forward observation | No new 30-day experiment is registered or running. Start only after explicit frozen strategy/cost policy and data readiness |
| Final model decision | No model qualifies. Diagnostic positive funding is not net profitability |

Keep MIR independent, LXR internal, WADJ subtle, free data first, and all operations read-only or local simulation. Never replace missing history with invented market observations.
