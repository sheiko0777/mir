# Kronos: reproducible inference and outcome validation

MIR uses Kronos as a candidate forecasting component. It supplies no execution
authority and no profit qualification. LXR remains the liquidity engine; MIR is
the independent platform built by WADJ Studio.

## Reviewed runtime and assets

`tools/research/kronos-win-cp314.lock` pins the complete Windows CPython 3.14
binary-wheel resolution with SHA-256 hashes. `prepare_kronos.py freeze` records a
pip dry-run report, `download` fetches wheels, and `review` verifies hashes and
extracts license notices before `install` installs offline into `.venv-kronos`.
The only admitted startup hook is the exact, recorded setuptools distutils shim.
These are provenance checks, not a full security audit of every dependency.

The audit checks package versions, loads PyTorch and checks a CPU tensor
calculation. Optional `audit-files` additionally rehashes all installed files
against their RECORD entries; it can be slow and is separate from the mandatory
downloaded-wheel, source and model checks. Run using the isolated interpreter:

```powershell
tools/research/.venv-kronos/Scripts/python.exe tools/research/prepare_kronos.py audit
```

The model manifest `kronos-models.json` pins official public Hugging Face
repositories, revisions, sizes and file hashes. `kronos_assets.py plan` creates
the manifest and `download` fetches only config, model card and safetensors.
No pickle weights or remote model code are loaded. Models and downloaded wheels
remain local, excluded from Git. Source MIT notice and dependency notices are
preserved under `tools/research/licenses`.

## Actual-data experiment commands

```powershell
python tools/research/kronos_context.py
tools/research/.venv-kronos/Scripts/python.exe tools/research/kronos_adapter.py --context <context.json> --horizon 24 --samples 2 --historical-tail
tools/research/.venv-kronos/Scripts/python.exe tools/research/kronos_adapter.py --context <context.json> --horizon 24 --samples 2 --lookback 128
python tools/research/kronos_evaluate.py --forecast <forecast.json> --observations <later-context.json>
```

The collector makes one public BTC perpetual candle request and preserves its
raw bytes, SHA-256, native identity, request interval and capture time. It requires
512 contiguous, closed hourly candles. These are contract prices, not an assumed
USD valuation of USDC collateral.

The upstream predictor derives its missing `amount` feature as volume multiplied
by the mean OHLC price. Every MIR run records that assumption; this is estimated
quote turnover, not an independently observed market field.

The historical diagnostic withholds the last 24 candles before constructing the
model input. It reports median-path MAE against a last-close baseline. It is one
retrospective window; upstream pretraining overlap is unknown. It cannot qualify
a trading policy, supply executable fills or demonstrate net profitability.

A forward forecast records generation time, model/source/runtime provenance and
sample paths. Evaluation excludes any candle already open at generation time,
requires all eligible candles to be present and closed, and rejects market or
timestamp mismatches. Missing outcomes return `insufficient-evidence` with no MAE.
Sample-range coverage is explicitly not a calibrated confidence interval.

All results retain `qualified: false`, `netUsd: null`, and zero actual fills.
The next economic gate requires a frozen entry/exit policy, executable-side depth,
funding and margin where applicable, complete costs, independent chronological
evaluation, doubled-cost stress and at least 30 days of forward observation.

## Actual first diagnostic: 2026-11-07

The binary-only isolated install contains 26 pinned packages and 84 preserved
dependency notices. The optional full audit verified 18,138 installed file hashes;
PyTorch 2.10.0 CPU tensor smoke testing also passed. Model/tokenizer files total
114,841,271 bytes and are verified against the committed manifest on each run.

The initial historical diagnostic used 488 input candles, 24 withheld target
candles and two separate paths with seeds 0 and 1. Model median-path MAE was
**1737.1707356771** contract-price units; the last-close baseline MAE was
**295.125**. Kronos was about 5.9 times worse in this window. Generation itself
took 156,168 ms on two CPU threads; total process time also includes imports and
asset checks. This is a single local measurement, not a latency benchmark.

Decision: **do not promote this configuration**. Preserve it as negative evidence.
One window cannot establish general model quality, and it establishes no profit.
The shorter-lookback forward run is a separate configuration, not a revision of
these historical results.

Local input: `data/bots/kronos-context/796e68f2026f5ed507a1864f38b72355c602319d7821bfcdf23cfa83e476c7ce.json`.
Local diagnostic: `data/bots/kronos/5bb68de682a7d125aeaeb2bef852182f9c4d568604a18aa7f94ef76accddd69b.json`.
Immutable artifact IDs are SHA-256 hashes of their file bytes.

The separate forward run used 128 context candles and two 24-step paths, generated
at 2026-11-07T03:59:11.320Z. Its inference elapsed time was 39,388 ms. Input period
and context differ from the diagnostic above, so these two timings do not establish
a controlled performance improvement. The evaluator excluded the already-open
candle and returned `insufficient-evidence` for all 23 eligible future candles.
Their final close is 2026-11-08T03:00:00Z; rerun the collector and evaluator after
that time. There is no scheduler or background market-monitoring service started
by these commands.

Forward record: `data/bots/kronos/588798c431ec2aa86541796d013dfbc6ec740670d61e5dcda2c0f3e6c1833cb4.json`.
Pending evaluation: `data/bots/kronos-evaluations/782d0da7518a95334ccfd3861b5f74d7aafa62af5b6439470bacff130bb0b910.json`.

## Parallel carry check: 2026-11-07

A new eight-market capture used 11 public requests and was imported into MIR Lab
as dataset `2b8e73b5efa8f6b1d4025a75378a6e601b5fc5a3149be167ed6a016f4989e758`.
HYPE native spot/perpetual books had zero source-time skew. Recomputed known-cost
hurdles were 0.5943661090 USDC for the 500 USDC budget and 6.4625452285 USDC for
5,000 USDC. Conditional unchanged-rate recovery horizons were 191/208 hours,
or 375/392 hours with doubled fees. These estimates exclude still-unknown costs
and future basis/price/funding changes; they are not break-even forecasts.
Both 50,000 USDC cases were rejected for insufficient displayed perpetual buy
depth. Full net return remains unknown for every case.

Local capture: `data/market-capture/1794023283478.json`.
Recomputed cost report: `data/carry-entry/4c4da4dbc74875db94ecb89e88d713c037ed391f663ddf0c2e67a7fbaf41a429.json`.
These preserve a materially less favorable snapshot than the earlier capture;
the original results and losses are retained.
