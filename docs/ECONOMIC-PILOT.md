# MIR economic pilot v1

Frozen research protocol: 7 November 2026. No current buyer or paid engagement. This is a draft for review, not a sent offer, advertised SLA or trading service.

## Hypothesis and deliverable

A data team maintaining a crypto research pipeline may pay to detect missing, duplicated, mismatched or unreproducible source data before using it. Start with the one capture format already supported by MIR rather than promising arbitrary chain indexing.

Draft scope: one saved Binance spot/perpetual/mark/funding capture covering BTC/ETH/SOL, up to 90 days, hourly prices, at most 16 MiB for the bundle and the existing bounded raw-response format. Deliver a reproducible JSON report, human-readable findings and source hashes; include clean results, limitations and one clarification round. Input ingestion must first pass the existing provenance and path/budget guards. No customer file is executed.

The example uses existing public historical data. It does not establish rights to resell provider data: any external pilot must review source terms and customer permission, and sell validation work within permitted use. Avoid security-audit certification, guaranteed correctness, trading signals and invented time-saving estimates.

## Price discovery and cost equation

**Unvalidated price hypothesis: USD 25 equivalent for the fixed-scope pilot.** It is neither an observed willingness to pay nor a recommended token settlement mechanism. No checkout, wallet or offer was published. If input or support exceeds scope, record that outcome rather than silently excluding its cost.

Use one documented reporting currency and receipt-time conversion per asset; unknown inputs produce **unknown net**, not zero cost:

```
realised net = collected receipts - refunds - settlement fees
               - collection/API/compute/storage cost
               - delivery and support labour - acquisition labour
               - attributable development/maintenance allocation

contribution before fixed allocation = collected receipts - all variable costs
break-even jobs = ceil(period fixed allocation / contribution per job)
```

Break-even is undefined when contribution is nonpositive or a material cost is unknown. Cash flow and profit are separate: prepaid maintenance creates future delivery obligations. Count failed proposals, unpaid work, rework and rejected deliveries, not just successful jobs.

Illustrative arithmetic only, **not MIR results**: collected $25, $1 non-labour variable cost, 30 minutes total labour valued at $20/hour gives $14 contribution before fixed allocation. Doubling both variable inputs leaves $3. With $100 period fixed allocation, base break-even is eight jobs, stressed break-even 34 jobs. At 45 minutes base labour the doubled-cost contribution is -$7: stop or change scope/price. None of those costs, prices or sales have been measured in a customer pilot.

## Two-week bounded discovery protocol

This document defines the experiment; it does not start a background process or authorize contacting anyone.

1. First qualify at most ten current public requests, using at most twenty primary-page reads per manual research session. Record canonical source, capture time, buyer, funded scope, eligibility, deadline and status. Cached, closed, speculative, prize-only and real-money-volume programs do not count as qualified QA buyers. Record zero when none qualify.
2. A candidate must have a concrete data reliability problem, compatible input rights, no required financial activity, and a reviewable acceptance condition. Prepare a specific recipient and fixed-scope draft before any separately authorized outreach. No mass messaging, accounts or unpaid speculative builds.
3. Record every pilot outcome: input hashes, version, acceptance, rejection/refund, actual receipt evidence, currencies/conversion, every labour interval, all cash costs and unknowns. Receipt evidence may be redacted locally; never publish customer data or secrets.
4. After a two-week discovery window, report qualified leads, offers actually authorized/sent, accepted jobs, collected receipts and acquisition hours. No response is a recorded outcome, not an assumed future sale. If no qualified buyer or willingness-to-pay evidence appears, pause product expansion and revise or reject this service hypothesis.

## Promotion and stop criteria

- Technical delivery demonstration: achieved only for the existing saved public capture; not yet a customer acceptance test.
- First economic evidence: one independently controlled buyer accepts delivery and pays; all delivery/acquisition costs recorded. This supports one transaction only.
- Repeatability gate: at least three independently controlled paying buyers and at least one returning payer, across at least 30 days, including failures. A longer contract cycle needs longer observation. These are research thresholds, not statistical certainty or a profit guarantee.
- Positive full-cost net and positive contribution under doubled variable-cost stress are both required. Material unknown cost, refunds hiding losses, unpaid invoices or related-party/self-paid tasks block promotion.
- A marketplace can be considered after ten genuinely paid tasks spanning at least three independent payer control groups and one repeat payer are evidenced for the actual tool category. Aggregate Olas activity cannot substitute for this cohort.
- Current status: no qualifying MIR buyer, no collected receipts, unknown full costs, **insufficient evidence**. Do not relabel unknown as profitable. The prior trading drawdown limits remain separate from this service experiment.

## Integration boundary

Use the current Python audit and MIR Lab evidence contracts first. Add a service adapter only after a buyer needs it. The agent may organize public evidence and execute bounded local checks; deterministic validators retain authority over validity. No trading capability, wallet, custody, autonomous price changes or purchased tools are part of this pilot.
