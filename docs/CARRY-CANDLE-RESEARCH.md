# Carry economics: observed data, negative result — 2026-11-07

The new public Binance adapter captured 90 days of hourly spot, perpetual and
mark-price candles for BTC, ETH and SOL plus funding history carrying each
settlement's mark price. Native spot/perpetual identities are checked. Collection
used 26 read-only requests and 4,113,721 raw bytes. No authentication, order,
wallet or payment was used.

The fixed policy and date window were written to a content-addressed plan before
the historical capture. The initial metadata request returned HTTP 400; that
failed record is retained. Compact JSON array serialization was applied before
the successful retry, which produced a complete capture.

Source: `data/binance-history/05fe5b1d5189997a1db516e1bc8d779a041c6e4ffab5b4fb4b2ceed6828e0d7e.json`.
Policy SHA-256: `dba22f4718489f846f7f735c5e5f96c6ddc93383619c96bbec043a63059a2576`.
Policy: `tools/research/policies/carry-candle-v1.json`.

## Model and limits

The model is long owned spot and short the same base-asset quantity on one venue.
It uses reference candle opens with explicit per-leg penalties, not invented
order-book executions. Capital is 50% spot including entry costs, 30% isolated
margin and remaining reserve, rounded down to a common current native lot step.
Fees are assumed 10 bps spot/5 bps perpetual, each-leg slippage penalty 5 bps,
and opportunity cost 3% APR on total capital. The stress doubles all three.
These are research assumptions, not verified account commissions or historical
execution costs. Funding uses observed settlement mark price times quantity
times rate; it does not simply sum funding rates.

Data spans 2026-08-09T00:00:00Z to 2026-11-07T00:00:00Z. The chronological split
is 60 development days and 30 heldout days. Each reference trade starts at 01:00
and exits at 23:00 on its segment's last day to avoid ambiguous funding boundary
ownership. Exact entry/exit timestamps are retained in every case. No optimizer
or ex-post best-asset promotion was used. This remains retrospective research,
not a prospective trading test.

Ledger decomposition is reference basis PnL plus settled funding, minus fees,
slippage penalties and opportunity cost. Conservative intrahour mark/high/low
bounds reject possible margin or 5% drawdown breaches without inventing an exit.
Separate extremes need not occur simultaneously; bounds are not a realized path.
Current lot increments do not certify historical trading filters, and withdrawal,
custody, outage, conversion and full execution costs remain unverified.

## Heldout result

All nine asset/capital combinations were negative at base and doubled costs:

| Asset | 500 USDT base / doubled | 5,000 USDT base / doubled | 50,000 USDT base / doubled |
|---|---:|---:|---:|
| BTC | -1.1904 / -3.2162 | -11.7289 / -35.5693 | -117.1136 / -358.7225 |
| ETH | -1.7421 / -4.1266 | -17.4691 / -41.3873 | -174.6962 / -413.9768 |
| SOL | -1.3887 / -3.7223 | -13.8901 / -37.2288 | -138.9032 / -372.2935 |

Amounts are conditional scenario USDT, not USD, realized fills or verified profit.
The result rejects this configuration under its frozen assumptions. It is not a
claim that every possible carry strategy is unprofitable. Parameters have not been
lowered after seeing the heldout data to force a positive result.

Report: `data/carry-candle-screen/29fb58be6eb7f251ac97918c22f215199c2869fb7ab6336f367e952042609bf7.json`.
Earlier calculation before the conservative margin fee-source correction is
retained separately; cash PnL did not change.

The evaluator rebuilds its entire bundle from raw response files, rechecks their
hashes and frozen policy/window, and rejects altered bundled prices, gaps,
duplicate funding or unit/market mismatches. Every case retains `qualified:false`,
`verifiedNetQuote:null`, zero actual fills and its full ledger.

```text
python tools/research/binance_probe.py
python tools/research/binance_history.py
python tools/research/carry_candle_screen.py <capture.json>
python tools/research/test_carry_candle_screen.py
python tools/research/test_binance_provenance.py
```

## Lending baseline attempted next

`lending_index.py` adds restricted Aave reserve-index reads, canonical timestamped
blocks, native identity checks, reserve flags and available-liquidity checks.
Its pure atomic-unit model floors conversions, includes undeployed capital and
fixed cost/opportunity reserves, and exposes positive arithmetic only as a
conditional result. It supports no transactions, approvals or state overrides.

Both reviewed public Arbitrum profiles returned HTTP 403 on the first chain-ID
request. The PublicNode response was error 1010. No index history or lending
result was fabricated. Failures are saved in
`data/lending-index/db5e746becd199893a4dd25e20b19205158603065e1f33125702b4de9086cedb.json`
and `data/lending-index/1792abb121621e17876695dbfaa76ad477372a2166edfe912f9ede6276fadf49.json`.
No access control was bypassed or paid/keyed provider provisioned.

The command uses the existing reviewed `.venv-almanak` eth-utils dependency for
ABI selectors; no new package was installed:

```text
tools/research/.venv-almanak/Scripts/python.exe tools/research/lending_index.py
python tools/research/test_lending_index.py
```

## Broader research decision

The user expanded MIR beyond trading and arbitrage. The parallel-agent findings
and first non-trading prototype are recorded in
[small-niche research](SMALL-NICHE-RESEARCH.md). No income stream is promoted yet.
The saved Kronos forward forecast still requires the previously fixed future
outcome period; it was not relabeled or altered during this research.

Primary references: [funding settlement amount](https://www.binance.com/en/support/faq/detail/360033525031),
[public history API with settlement mark](https://developers.binance.com/docs/derivatives/usds-margined-futures/market-data/rest-api/Get-Funding-Rate-History),
[Aave normalized income](https://aave.com/docs/aave-v3/smart-contracts/pool),
[official Arbitrum RPC](https://docs.arbitrum.io/arbitrum-essentials/reference/node-providers),
[public alternate provider](https://arbitrum.publicnode.com/).
