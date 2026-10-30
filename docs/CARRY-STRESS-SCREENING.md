# MIR — carry scenario stress screening

Added 2026-10-30. This local tool evaluates supplied mathematical scenarios using
`carry_model.py`. It does not download data, validate a hedge, infer fills, register
a holdout or promote a strategy. No additional dependencies are required.

```powershell
python tools/research/test_carry_stress.py
python tools/research/carry_stress.py tools/research/fixtures/carry-stress-illustrative.json
```

The bundled fixture is explicitly **MOCK SAMPLE / illustrative**. Its zero spread,
artificial prices, assumed fees and funding are arithmetic inputs, never market
evidence. Replace it only with a separately documented `supplied-scenario` input;
that label still does not certify executable liquidity or complete costs.

Each report includes all 15 cases: five scenarios at total capital 500, 5,000 and
50,000 USD. Each reruns the same 50% spot / 30% margin / 20% reserve allocation,
including its adjusted entry fee/quote, so quantities can change between stresses.
Quotes are conditional, and using one price across sizes does not establish depth.

| Scenario | Deterministic change |
|---|---|
| Baseline | Original inputs |
| Double costs | Double both trading fees and each explicit other-cost amount |
| Double quote penalty | Double bid/ask distance from the midpoint for both legs |
| Combined | Both cost and quote changes |
| Adverse funding | Every rate becomes `-abs(rate)`; already negative rates stay negative |

The quote penalty is a sensitivity assumption, not a market-depth or realized
slippage model. A nonpositive stressed bid becomes missing evidence, never an
invented fill. Missing costs stay missing. The existing 5% drawdown and margin
checks preserve stopping losses and partial ledgers; unmodeled liquidation leaves
scenario net unknown.

The screening gate rejects a nonpositive baseline or combined scenario and their
risk stops. Unknown required results produce an incomplete screen. Other stress
losses and risk stops remain visible in `stressFindings`; adverse funding is a risk
diagnostic, not a requirement that a funding strategy earn money under every rate.
Even `survived-scenario-screen` leaves the overall decision
`insufficient-evidence`, `qualified=false`, and `netUsd=null`.

Full ledgers, negative cases, reasons and incomplete inputs are retained. Reports
are written with exclusive creation under local, Git-ignored
`data/carry-stress/<report-sha256>.json`. Identical input bytes and engine sources
produce identical report bytes and reuse that report after integrity checking.
The report records raw-input, semantic-input and engine-source SHA-256 hashes.
Hashes establish reproducibility of bytes, not authenticity of market data.

Bounds: input 4 MiB, 2–2,161 observations, output 32 MiB; decimal arithmetic only.
The CLI rejects duplicate JSON keys and does no network IO. Source outage,
unavailable depth, settlement identity, borrow/transfer/rebalance costs, changing
margin rules and intrainterval liquidation are not simulated. A supplied zero
cost is an assumption to audit, not proof that a cost does not exist.

Next gate: verified, synchronized, size-aware spot/perp observations and complete
cost provenance, followed by a frozen 60/30 chronological evaluation and forward
tracking. This implementation completes a scenario sensitivity component only.
