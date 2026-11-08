# MIR: protocol-funded work is the primary research track

Implementation update: [first read-only protocol worker, commands and test evidence](FIRST-PROTOCOL-BOT.md). This is a bounded watchlist prototype, not a profitable autonomous executor.

Decision date: 8 November 2026. User clarification: first build something that earns for MIR from existing protocol mechanisms, without finding or selling to a customer. The customer-service pilot remains a separate, deferred hypothesis. Its evidence does not validate protocol income.

Research and paper simulation only. No wallet, signing, deposits, approvals, broadcasting or autonomous financial execution is authorized by this change.

## Ranked candidates

| Priority | Mechanism | Economic source | Critical uncertainty |
|---|---|---|---|
| 1 | PoolTogether V5 prize claiming | Protocol claim fees for computing and claiming winners' prizes | Available unclaimed work, competitor timing, compute/gas/withdrawal cost and realized receipts |
| 2 | PoolTogether draw auctions | Reserve-funded rewards for starting randomness and finishing draws | Limited cadence, competition, RNG charges and chain-specific deployment details |
| 3 | Liquity V2 liquidation initiation | Protocol gas compensation paid to liquidation initiator | Eligible positions, exact deployed rules, competition, failed attempts and collateral exit value |
| 4 | PoolTogether yield liquidation | Discount in converting yield into prize tokens | Executable exit price, capital or flash-liquidity cost, slippage and race conditions |

These are research priorities based on fit and existing MIR work, not a profitability ranking. None is known to be uncrowded or currently profitable for MIR. No customer acquisition does not mean no operating cost, required capital or market dependence.

## Mechanisms verified in official documentation

[PoolTogether claiming guide](https://dev.pooltogether.com/protocol/guides/bots/claiming-prizes/) describes enumerating eligible accounts, calculating winners, checking claim fees and withdrawing accrued fees. It also warns of competing claims. Computed fees and reward credit are not cash receipts. MIR already has a protocol-specific decoder and inventory reconciler; see [accounting gate](PROTOCOL-WORK-ACCOUNTING.md).

[Draw auction design](https://dev.pooltogether.com/protocol/design/draw-auction/) separates starting RNG from finishing the draw; some randomness providers charge for requests. A reserve reward is distinct from a prize claim fee. Do not add mirror events or credit and withdrawal amounts as separate earnings.

[Liquity V2 documentation](https://docs.liquity.org/v2-faq/borrowing-and-liquidations) describes initiator compensation as `0.0375 WETH + min(0.5% of trove collateral, 2 units of LST or WETH)`. Preserve the collateral denomination; do not add different tokens as if identical. Verify code, branch, deployment and block before using this documentation formula in a quote. Stability Pool liquidation gains are a different capital-bearing activity, not initiator compensation. Old Liquity V1 bot code is not a validated V2 adapter.

[PoolTogether yield liquidation guide](https://dev.pooltogether.com/protocol/guides/bots/liquidating-yield/) describes discounted yield swaps and flashswap support. A discount alone is not net income: the exit route and all costs must be simulated. Flash liquidity does not eliminate gas, fees, competition or contract risk.

Sources checked 8 November 2026. Documentation establishes mechanism existence, not current transaction receipts or MIR access to profitable tasks.

## Evidence sequence: PoolTogether first

1. Confirm deployed addresses, chain, bytecode/version, token identities and decimals. Keep the existing pinned ABI as a reference, not a certificate of current deployment.
2. Obtain a complete, bounded historical window of official/public logs and receipts, including failed attempts by the tracked operators. Existing denied RPC/explorer probes are retained; do not bypass challenges, solicit secrets or treat missing history as zero activity.
3. Reconcile earned credit, opening/closing balances, withdrawals and actual token transfers. Separate claims from draw allocations, winner payouts and unrelated activity.
4. Calculate operator results including failed transactions, withdrawal costs, execution/L1/operator fees, computation, data and infrastructure. Trace attribution to reward recipient and fee payer. Unknown costs or conversions block a net claim.
5. Historical earnings by another bot establish that work was paid, not that MIR could win the same work. Replay against block-specific state where possible, using only information available before each decision. A successful static call is not an inclusion guarantee.
6. Freeze a paper policy; record candidate arrival, expiry, fee evolution, data lag, competing claims and lost opportunities. Measure at least 30 days; no retrospective deletion of failures. Do not start an unattended scheduler implicitly.

## Economics and acceptance

For a fixed observation window and one documented reporting currency:

```
earned net = earned protocol rewards - all successful and failed attempt costs
             - withdrawals and conversion costs - data/compute/infrastructure

cash flow = actual external receipts - actual cash outflows
```

Keep accrued credit and opening inventory separate when reconciling these quantities. Estimate pre-trade value using probability of winning and failure costs only after those probabilities are measured; unknown probability must not become 100%. No-task periods still incur monitoring costs.

Promote only with complete inputs, positive net under base and doubled variable costs, credible access to unclaimed work, and independent forward evidence. Report insufficient evidence if receipts or counterfactual access cannot be established. Positive results do not establish guaranteed daily or continuous income.

## Current state

- Mechanism: documented and relevant to the clarified goal.
- Existing MIR component: PoolTogether accounting decoder, source reference, synthetic fixture and tests.
- Missing: complete live/historical receipt window, current deployment verification, measured competitive access and full operating costs.
- MIR realized protocol revenue: not established. Verified profitable policy: none.
- Deferred: selling the data-QA sample and installing unrelated frameworks. No new package or financial executor is needed for the next evidence gate.
