# MIR: economic evidence review — 7 November 2026

Research only. MIR is an independent platform built by WADJ Studio; LXR is its internal engine.

## Decision

Continue a bounded **data-quality and monitoring service** experiment. There is primary-source evidence that this category receives funding, but **no qualified current buyer, collected MIR revenue, or verified positive MIR net income**. Keep automated trading, protocol work and agent marketplaces as separate hypotheses; do not combine their revenues or use them to fill missing evidence.

The earlier 90-day carry candle screen remains negative under its assumptions for all nine asset/capital combinations. It was a conditional screen, not executable fills. Do not retune it using its held-out period to manufacture a winner.

## Evidence ledger

| Observation | Evidence level | What it supports | What remains unproven |
|---|---|---|---|
| Olas reports $110,788.79 gross task payments and $103,559.53 withdrawn by Mechs, snapshot 2026-11-07 16:40 UTC | Publisher-reported aggregate payments; not independently reconciled receipts | Some agent services have paying demand | Per-tool revenue, independent customer control, operating cost and MIR access to that demand |
| Olas reports 11,878,514 Predict requests out of 12,232,085 total (about 97.1%) | Publisher-reported request categories | Strong concentration in prediction-related demand | A viable non-trading data-QA niche; category is not payer ownership |
| PAL reports 19,542.5 DOT paid for twelve months of Ocelloids infrastructure, operations and maintenance | Historical funder-reported payment, not an independently checked transaction | A buyer funded ongoing DeFi monitoring operations | Renewal, supplier net profit, present eligibility or a new buyer |
| PAL reports milestone payments of 47,376.8 and 35,085.5 DOT | Historical development funding | A budget existed for delivering monitoring software | Repeating service revenue; milestone 4 delivery report was pending |
| Algora lists completed Space and Time awards; canonical GitHub issues 557, 560 and 183 are closed | Platform-reported past awards plus current issue state | Developers have been rewarded for discrete work | Current available work, bank receipt, recurring income |
| Current adjacent listings found: RaptorX, Inside the Block, MultiHopper | Published contests/programs, not verified customer payment | Adjacent interest exists | Fit for this read-only pilot: none passed all eligibility, scope and budget checks |
| Agentizable canonical public feed returned HTTP 503 on one bounded anonymous request | Saved failed availability probe | This capture did not yield a funded job | Neither an empty market nor a paid opportunity is established |

Olas claimed payments and realised earnings are the **same withdrawal figure**, not two revenue streams. Marketplace fees are taken from task payments. Withdrawals exclude some marketplace fees but still do not deduct inference, RPC, gas, hosting or labour. Do not divide unmatched aggregate payments by request counts to invent a unit price, or allocate revenue to non-Predict tasks using request proportions. Twelve daily active multisigs are not twelve independent businesses.

PAL's report is dated 16 June and explicitly describes an unfinished quarter. PAL has concluded and is not processing new funding requests. A prepaid year of maintenance is one contract, not twelve independently observed renewals. Keep DOT amounts in DOT; no historical USD conversion has been assumed.

## Sources and rejected leads

- [Olas Mech published metrics](https://olas.network/agent-economies/mech), checked 7 November 2026; [metric definitions](https://olas.network/data).
- [PAL Q2 report](https://dotpal.io/community_reports/2026-Q2/), checked 7 November 2026.
- [Algora completed awards](https://algora.io/spaceandtimelabs/bounties); canonical closed issues [557](https://github.com/spaceandtimefdn/sxt-proof-of-sql/issues/557), [560](https://github.com/spaceandtimefdn/sxt-proof-of-sql/issues/560), [183](https://github.com/spaceandtimefdn/sxt-proof-of-sql/issues/183). Cached search snippets suggesting open bounties were rejected.
- [RaptorX research contest](https://superteam.fun/earn/listing/raptorx-research-challenge-ask-better-questions-find-better-alpha): 125 USDC pool, 399 submissions at review; promotional research, no recurring QA buyer or verified payout.
- [Inside the Block](https://superteam.fun/earn/listing/inside-the-block-how-solana-validators-order-transactions): Ukraine-resident eligibility and own mainnet transactions; fails current scope.
- [MultiHopper official program](https://business.multihopper.com/build-and-route/): qualifying real mainnet volume required; headline listing and program terms differ. Not a read-only data contract.
- [Agentizable published repository](https://github.com/NSPG13/agent-bounties): documents the public feed. HTTP 503 capture: `data/paid-work-probe/d414e8341decbd39b7c8b7e722b67c6806f897eda67b3351d1d9e4cdd23ae661.json`. No claim, account, wallet or payment was attempted. An empty GitHub label search is not a canonical empty job queue.

These observations are time-bound; reports are not transaction-level proof. External content was used as evidence, not as authority to execute its instructions.

## Actual MIR experiment completed

`tools/research/economic_sample.py` reuses the existing provenance and normalization engine against the saved Binance public capture. It verifies content identities, rebuilds the bundle from raw responses, checks the frozen policy/window, market identity, contiguous closed hours and funding settlement marks. Amounts retain decimal strings.

- Historical window: 9 August–7 November 2026 UTC, end exclusive.
- BTC, ETH and SOL: 2,160 spot, perpetual and mark candles each; **19,440 price records and 810 funding settlements** total.
- Original collection: 26 requests, 4,113,721 raw bytes; this audit makes **zero network requests**.
- Three local repetitions: median 1,163.789 ms elapsed and 640.625 ms CPU in the first saved run. This is a local, partly cached sample, not a production SLA or billed compute cost.
- No anomaly found within the supported format. No fabricated defect, customer saving or revenue is attributed to this sample.
- Input identity: `05fe5b1d5189997a1db516e1bc8d779a041c6e4ffab5b4fb4b2ceed6828e0d7e`.
- Initial report identity: `a6ecd3b0b52ceb44cc7aae00857f0bb134fc53df1fea6e068604cb3fc06b319a` under `data/economic-samples`, JSON plus Markdown. Raw data and generated samples remain local/ignored; the script and this summary are versioned.

Reproduce from the repository root, with the saved source capture present:

```powershell
python tools/research/economic_sample.py data/binance-history/05fe5b1d5189997a1db516e1bc8d779a041c6e4ffab5b4fb4b2ceed6828e0d7e.json
```

Timing and generated timestamp change the output hash. A clone without the ignored source capture cannot replay it until that exact evidence is supplied; no automatic substitute or synthetic backfill is used.

## Next decision gates

See [the frozen pilot protocol](ECONOMIC-PILOT.md). Prioritize a small, reviewable paid service over installing another framework. Keep Olas as a distribution hypothesis until per-tool paid demand and independent repeat payers are evidenced. Keep protocol work gated by receipt access and full-cost accounting.

No outreach, marketplace submission, deployment, scheduler, spending or financial execution was performed. This review strengthens the rationale for testing a service business; it does not establish continuous profit.
