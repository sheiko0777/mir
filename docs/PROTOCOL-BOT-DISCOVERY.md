# MIR protocol bot: bounded participant discovery

8 November 2026. Read-only research. No customer, wallet, secrets, transaction submission, paid source or unattended scheduler.

## What changed

The first worker required explicit account/vault/prize seeds. It can now optionally bootstrap those seeds from **previous ClaimedPrize events** at the published Base PrizePool. Existing manual-only captures still replay without changing their frozen policy.

This is a deliberately biased participant sample, not an eligible-holder index and not a new profitable strategy. Claim events describe already performed work. They are used to find account/vault/tier combinations to inspect again; neither winner payouts nor historical claim credits are attributed to MIR.

The event layout is taken from the already pinned ABI and checked against the existing accounting reference. [Official source](https://raw.githubusercontent.com/GenerationSoftware/pt-v5-prize-pool/main/src/PrizePool.sol) defines the emitting contract event; no upstream execution code was copied or installed.

## Algorithm and limits

1. Verify network, observed deployed code, Claimer→PrizePool and WETH token/decimal relationships as before.
2. Request only ClaimedPrize logs for that exact pool/topic in a fixed numeric block interval ending at the selected head. Default: 128 blocks; maximum: 512. No automatic history widening after seeing an empty result.
3. Reject removed logs, wrong source/topic, malformed ABI words, invalid draw IDs, out-of-window blocks and duplicate log positions. Monetary fields are only width-checked, not counted as income.
4. Select up to four most recent distinct vault/winner/tier combinations from at most 128 returned logs. Check each selected source block's canonical hash through its header. Reject conflicting hashes.
5. For each selected participant, inspect the observed prize index and a small deterministic sample of early indices, at most four indices total. Merge with manual seeds without duplicates, never exceeding sixteen seeds. Invalid current tiers/indices remain visible rejections.
6. Recompute `isWinner`, `wasClaimed` and batch fees at the common pinned current block. A previous win does not establish a current win or an unclaimed prize. Reconfirm the head's canonical hash after the scan.

`eth_getLogs` uses a bounded numbered range, not a hash parameter; selected source block hashes and the head are checked separately. This is RPC-provider evidence, not cryptographic receipt proof or validation of every ancestor/event. Provider completeness is explicitly unverified. Exact topic/address/range allowlists remain in the transport; transaction methods stay forbidden.

Coverage reports retain the queried range, observed event count, sampled participants, checked source hashes, added seeds, selection bias and `wholePoolComplete: false`. No events in a short window does not mean no eligible accounts or no protocol work. Holders who have never won, other tiers/indices and older events are not comprehensively covered.

## Observed runs, including the negative result

| Saved capture | Actual observation | Economic conclusion |
|---|---|---|
| `565e0b0c6340b93db9fdcf7d7fd34ec258291f8353dbc3d65aa1ef878d76346f` | Earlier run stopped at the contract-code read after network/header responses | Source unavailable for that run; no quote |
| `c5392f9dad8c41cd9de57d68be0fef98741fa596a33acd0d9803c2a2d3aa8bcf` | Later manual-only empty-watchlist run completed 11 public reads, 70,497 response bytes | Deployment relationships observed; no candidates evaluated |
| `670b53931b6bdbc1912b3f5fea8eccc3373eaf1b73e933534f5afe7f292c8b6d` | Automatic discovery completed 12 reads, 71,779 response bytes, zero retries; provider returned an empty event array for blocks `0x344d8be`–`0x344d93d` inclusive (128 blocks) | Zero sampled participants in that query; no live reward/net result, not a rejection of the whole mechanism |

All captures are local under `data/bots/pooltogether`; they are ignored by Git. The earlier failed request was retained. Later success on the same public provider does not identify the exact cause of the earlier generic error. Newly captured HTTP/RPC error classifications are now exposed without logging arbitrary provider text.

The successful current-block capture records head hash `0x850f167f72b55c424e2b6673cc33f5f03d0684918ff00a47d68d1615496a82e6`. These are historical observations; UI freshness is recomputed at read time and does not imply the data remain recent.

## Reproduce and next evidence gate

```powershell
npm run bot:pooltogether:live
npm test
npm start
```

The first command makes one bounded public capture under the configured discovery policy. It does not poll. API/page refreshes read saved captures and do not collect more data. A clone without ignored captures starts without live evidence and never substitutes the fictional fixture.

Six discovery tests cover ABI/topic agreement, event rejection, bounded selection and deduplication, selected-block reorg checks, discovery→current claim checks→replay, and the read-only transport filters. They complement the existing accounting and watcher tests.

The full Node suite passed **98 tests** after this integration. The earlier first-worker result of 92 tests remains recorded in its dated guide; six discovery tests were added here.

Next: a coverage-accounted holder/TWAB index and vault/claimer/hook verification, then block-specific claim simulation and full-cost competition measurement. Do not enlarge the bot's role to financial execution, assume probability of winning is one, or call successful RPC reads economic profit. MIR protocol receipts and verified net remain unknown.
