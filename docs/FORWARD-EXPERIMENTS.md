# Forward quote experiments / متابعة الفرضيات الورقية

MIR records a hypothesis **before** a later observation is available. This is a durable reserve-quote experiment, not a funded paper trade, transaction simulation, live execution or achieved profit. It intentionally cannot enter `PaperLedger` and never changes a balance.

## One cycle

```sh
npm run research -- --gas-units 300000 --priority-fee-wei 1000000000 --size-steps 8 --buffer-bps 50
npm run paper:forward
```

The numeric gas parameters above are illustrative caller assumptions, not recommended trading settings. The research collector performs bounded read-only RPC collection. `paper:forward` only reads the committed local checkpoint; it does not start RPC collection, timers, a watcher or an automation. Run another research collection and forward cycle later to evaluate pending hypotheses. Without supplied gas assumptions, costs remain unknown and no costed entry is registered.

The first fresh costed snapshot registers the deterministic best candidate of the tested grid, including negative scenarios. Its raw snapshot, exact policy, chosen size/direction, wall-clock registration time and ID are retained. Another capture of the same block cannot register a second hypothesis even if its policy changes.

A subsequent cycle evaluates pending hypotheses **before** registering a new hypothesis from that cycle. The default observation delay is 60 seconds after registration, with a six-hour expiry. A comparable observation must have a strictly higher block and different hash, and both block time and capture time must be at least registration time plus the delay. Re-reading an older finalized block later cannot satisfy this requirement. Ethereum finality can therefore make the actual wait much longer than 60 seconds. The first comparable captured block is used; missing blocks are not reconstructed.

The later evaluation freezes the entry's route, input, gas-unit assumption, priority fee, base-fee factor, buffer, budget and minimum threshold. It uses the later pinned base fee and later reserves, with no reranking against the later best route. Token identity, decimals, pool identity, fee and factory must match. Missing routes/unknown costs do not create a zero-valued result. Expired hypotheses retain unknown outcomes. A changed hash at the same height, backwards source/clock, malformed journal or corrupt checkpoint fails closed without overwriting the saved journal.

## Storage and interpretation

`data/forward/journal.json` is ignored by Git. A single-writer lock and atomic rename protect each update. The bounded journal retains up to 32 hypotheses, each with at most a 64 KiB raw entry/outcome snapshot; it stops opening new entries at capacity and continues resolving pending entries. It does not silently delete history. Preserve a completed journal before starting a separately named future experiment; no reset command is provided. After a crash, inspect the process before manually removing a stale `run.lock`.

On load, entries/outcomes are validated and quotes recomputed rather than trusting stored winner or profit fields. Entry hashes detect accidental changes, not malicious tampering or authenticity of the RPC provider. Local checkpoint publication controls ingestion, not an independent chain oracle.

CLI JSON includes `initialScenarioNetQuote`, `laterScenarioNetQuote`, `scenarioChangeQuote`, frozen policy, both block identities, observed delay and threshold persistence. `scenarioChangeQuote` measures change between two modeled route results; it is not a return earned by holding a position. `laterAboveThreshold` also requires later size/finality/budget constraints. Every record remains `qualified:false`, `actualNetQuote:null`, with zero paper fills.

Experiments can overlap and have no shared capital model. Their net figures must not be added as portfolio PnL, compounded, or used as a drawdown/win-rate claim. WETH and USDC are never aggregated into a single profit. Gas units, token behavior, transfer taxes, approvals, MEV, inclusion latency, reverted attempts and real execution costs remain unverified. This workflow supports forward evidence gathering, not proof of continuous profitability.

## Verified behavior

Synthetic tests exercise adverse later prices, frozen assumptions, no lookahead, duplicate/reorg rejection, unknown/stale evidence, missing routes, corrupted persistence, restart deduplication, lock exclusion and bounded history. Synthetic reserves are labeled in the tests. Live observations, when collected, remain local and are reported separately from test cases. The platform UI currently previews research; this forward journal is available through CLI and file only.

### Initial local registration — 20 October 2026

A bounded read-only collection captured two venues at finalized block `26235313`, hash `0x68c1c0ba809d2eaff022d9fd822c2386ead57135e672d9e32850d255b99e0e58`. Eight sizes produced 16 direction/size candidates. With explicitly assumed 300000 gas units, 1000000000 wei priority fee and a 50 bps buffer, no tested scenario was positive. The forward CLI registered one pending hypothesis and the next process returned `DUPLICATE_BLOCK` with no new action. No later result was available at registration, and no paper fill or balance change was produced. Raw observations and the journal remain local under ignored `data/`.
