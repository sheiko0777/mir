# MIR: research beyond trading — 2026-11-07

MIR is an independent platform built by WADJ Studio. LXR remains its internal
onchain liquidity engine. The research objective now includes useful paid work
and narrow data services; it is not restricted to price trading or arbitrage.

Three parallel research agents independently reviewed protocol-paid work, paid
data services, and novel agent-business models. They made no installations,
transactions, account registrations, sales messages or payments. This document
combines their results and separates a documented payment mechanism from a proven
opportunity available to MIR.

**Current conclusion:** no continuous profitable business or underserved market
has been established. The useful new hypothesis is an agent that selects small
paid operational jobs, prices their full costs, and supplies verifiable results.
Its potential edge is a narrow workflow and low operating cost, not assumed
predictive intelligence or assumed absence of competitors.

## Candidate map

| Candidate | Payer and trigger | Evidence | Unproven gate / rejection test |
|---|---|---|---|
| Small delayed PoolTogether claim batches | Claimer contract pays useful prize-claim work | [MIT claimer](https://github.com/GenerationSoftware/pt-v5-claimer), [MIT existing bots](https://github.com/GenerationSoftware/pt-v5-autotasks-monorepo), [current Base deployments](https://dev.pooltogether.com/protocol/deployments/base/) | Need current paid events, eligible unclaimed jobs, full gas and failed attempts. Delayed jobs may simply be uneconomic. Reject if reachable margin disappears before our response. |
| Curve PegKeeperV2 caller work | Contract caller share for an allowed useful update | [Official contract docs](https://docs.curve.finance/developer/crvUSD/pegkeepers/PegKeeperV2), [specific MIT source](https://raw.githubusercontent.com/curvefi/curve-stablecoin/master/curve_stablecoin/stabilizer/PegKeeperV2.vy) | `estimate_caller_profit()` is relevant; accumulated protocol `calc_profit()` is not caller revenue. LP redemption, eligibility, competing updates and failure costs remain unknown. |
| Funded Keep3r job backlog | Job sponsors fund credits for useful operations | [Job accounting](https://docs.keep3r.network/core/jobs), [keeper eligibility](https://docs.keep3r.network/core/keepers), [MIT source](https://github.com/keep3r-network/keep3r-network-v2) | Current funded, accessible backlog and bonding/age rules must be measured; old documentation alone is not demand. |
| Independent rewards reconciliation | A small protocol's incentive manager pays for exception reports | [Merkl fees](https://app.merkl.fr/about), [Morpho reward semantics](https://docs.morpho.org/developers/rewards/tutorials/fetch-rewards-data/) | Adjacent distribution budgets exist. Payment for MIR on top of free dashboards is not established. Reject if reports add no useful exception or need constant manual review. |
| Paid integration-data QA | dApp/data team pays for a precise test/report on release | [A completed paid analytics listing](https://superteam.fun/earn/listing/wallet-analytics-website-creation), [marketplace rules](https://docs.superteam.fun/the-superteam-handbook/community/faqs/superteam-earn-faq) | A past bounty is evidence of purchased work, not a current opening, recurring subscription or low competition. |
| Contract-change impact report | Small wallet/aggregator team pays per watchlist | [Existing paid monitoring competition](https://tenderly.co/pricing) | Need an actionable dependency/replay report beyond generic alerts. Security monitoring is not an empty market. |
| Validator revenue exceptions | Small operator pays to reconcile missing fees/rewards | [Lido economics](https://docs.lido.fi/staking-modules/rewards/), [MIT monitoring implementation](https://github.com/lidofinance/ethereum-validators-monitoring) | Existing free monitors are strong. Find a financial exception they do not solve before building another uptime panel. |
| Agent-service cost/delivery guard | Paid API operator pays to control loss-making requests | [Current x402 settlement economics](https://docs.cdp.coinbase.com/x402/seller/facilitator), [Apache-2.0 SDK](https://github.com/x402-foundation/x402/blob/main/LICENSE) | Need operator-authorized cost/delivery logs and an independent buyer. Generic timeout recovery already exists; see [upstream shipped work](https://github.com/x402-foundation/x402/issues/2294). |
| Deterministic paid verification worker | Another agent buys a reproducible factual check | [Mech code](https://github.com/valory-xyz/mech), [current monetization path](https://build.olas.network/monetize) | Organic paid demand for the exact check is unknown. Exclude self-funded traffic, staking subsidy and points from revenue. |
| HIP-3 oracle/data SLA monitor | Market operator pays a monitoring subscription | [Operator responsibilities](https://hyperliquid.gitbook.io/hyperliquid-docs/hyperliquid-improvement-proposals-hips/hip-3-builder-deployed-perpetuals), [MIT SDK](https://github.com/hyperliquid-dex/hyperliquid-python-sdk) | Oracle capture time is not update time. Need an observable extra failure signal, licensed reference data and a buyer. |
| Application-specific Hyperlane relay | An application deliberately routes payment to our service | [IGP mechanics](https://docs.hyperlane.xyz/docs/protocol/core/interchain-gas-payment), [Apache-2.0 source](https://github.com/hyperlane-xyz/hyperlane-monorepo) | A public IGP payment is not automatically ours. Needs a real routing/customer arrangement and multi-chain gas reserves. |

No row has been certified low-competition. Address counts are not operator counts;
several addresses can belong to one incumbent. Public code demonstrates reuse
possibilities, not a complete source/license audit. No new upstream code was
installed or copied into runtime for these hypotheses.

## First two experiments

### A. Observe protocol-paid work before deploying a keeper

Start with one chain and small delayed PoolTogether batches. Existing MIT bots
should be reviewed/reused if the economic gate passes. MIR's initial addition is
the observer and evidence ledger, not a new claim executor.

Collect paid reward events, eligible job age, actual receipts, failures and
snapshot eligibility. Group cost by transaction hash once: batch claim records
can repeat the same receipt gas. Add chain-specific L1/operator fees, conversion,
RPC/compute, support and operating costs. Do not count an entire prize as the
operator's caller reward. Measure time-to-claim and successful response capacity.

Research admission budget: one chain, 30 days of existing data if available,
at most 100 public requests per capture, 32 MiB raw response storage and no paid
provider. These are proposed pilot budgets, not a running scheduler.

Reject if there is no recurring eligible backlog, payout is not actually
accessible, costs are missing, or doubled costs erase the margin. A stale tail
is not an edge until its net economics and attainable timing are demonstrated.

`tools/research/paid_work.py` now implements the offline accounting core. It
deduplicates receipt costs, retains failed-transaction costs, rejects duplicated
events and other operators' rewards, and refuses missing cost/conversion inputs.
It accepts no wallet, signer, RPC endpoint or transaction method. Its fixture is
explicitly illustrative and breaks even at base costs, losing under double costs.

```text
python tools/research/paid_work.py tools/research/fixtures/paid-work-illustrative.json
python tools/research/test_paid_work.py
```

No live paid-work dataset has been verified. The public subgraph was inaccessible
to web research; a research-agent shell request was blocked by lean-ctx and was
not retried or rerouted. No gas, revenue or competitive advantage is inferred.

### B. Validate a narrow rewards exception report

The customer hypothesis is a small protocol operations team, not an investor
buying a profit signal. Report cumulative indexed rewards, claimed amounts,
pending amounts, root/layer state, units and data age separately.

Morpho documents claimable rewards as cumulative `amount - claimed`; pending
rewards are not in the live root. Merkl also has legitimate TREE and LEDGER
distribution layers. An empty proof in a LEDGER response is not itself an error.
An API's internally consistent totals cannot independently prove entitlement
fairness. Points are not cash revenue. Some point campaigns can keep a LIVE
label while computation is paused; observed staleness does not prove its cause.
See [official point-program mechanics](https://docs.merkl.xyz/distribute-with-merkl/create-a-point-program).

The bounded public Merkl opportunity probe returned HTTP 403 / error 1010.
It retained this failure, with no fallback data, user-agent workaround or claim
of reward access. Live reconciliation is therefore still gated on a permitted
accessible source. Commercial API redistribution rights must also be reviewed.

If data access succeeds, build one useful exception report before a dashboard.
Measure false positives, review time and support cost. A drafted customer test
would ask whether the report fixes a currently costly task and whether the buyer
will pay for it. No outreach has been sent; recurring service revenue requires
independent paying customers and measured renewal/retention, not a market-size
estimate. Generic Safe dashboards and generic monitoring are not priorities.

## How the models can combine without hiding their assumptions

MIR can keep a common work queue: payer, job, evidence, eligibility, deadline,
expected receipt, all costs, competing responses and outcome. A deterministic
worker can perform verification; an agent can find and organize tasks. LXR data
can supply a verified onchain input when relevant. The cost/delivery guard is an
internal control first; selling it is a separate demand hypothesis.

For protocol work: caller reward actually received minus every attempt and
operating cost. For a service: collected customer revenue minus delivery,
settlement, refunds, support and acquisition. Keep currencies separate until a
documented conversion exists. Unpriced points, token appreciation and nominal
work listings do not count as paid cash flow.

Promotion requires independently verifiable positive unit economics, survival
under doubled-cost stress, actual recurring work/customer demand, and at least
30 days of forward observation retaining every failure. A longer business cycle
needs a longer observation period. A positive sample calculation cannot establish
continuous future income or authorize financial execution.

## Tool reuse decisions

Ponder and viem (MIT) are candidates for indexing/reading after a dataset need is
established. OpenZeppelin Monitor is AGPL-3.0, not MIT; license compatibility must
be reviewed before reuse. Public Merkl REST reads require no API key according
to its [developer portal](https://app.merkl.fr/developers); that does not license
arbitrary data resale. Dune ordinary plans should not be assumed to permit a
resale product. Existing pinned MIR/CCXT/Anvil tools remain available. No extra
framework installation is justified until a specific pilot needs it.
