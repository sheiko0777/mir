# Bounded discovery research

Run `node apps/monitor/discovery-search.mjs --limit 3` for a read-only one-shot sample of the last three entries in each supported Ethereum factory (Uniswap V2 and Sushi V2). `npm run research:discover` uses the same default limit. Limit is 1–10 per factory. This does not change discovery, research, agent, or forward-paper checkpoints.

The scanner retains the exact pinned snapshots it already reads; pricing makes no additional network requests. Each supported two-venue pair is tested in both directions at eight sizes using existing LXR integer arithmetic, fee, size, freshness and provenance checks. Reports retain losing candidates. Inputs range from 0.0125 to 1.6 WETH, or 12.5 to 1600 USDC; size constraints can exclude any of these.

Gas assumptions: 300,000 units, pinned base fee plus 1 gwei priority fee, and a 50 bps uncertainty buffer. USDC costs stay unknown without a pinned conversion pool. Unknown token behavior, transfer taxes, sell restrictions, MEV, failed attempts and inclusion are not solved by a positive scenario. No candidate is qualified and no transaction is submitted.

Reports include raw snapshots, discovery coverage, exclusions, analysis and assumptions under ignored `data/discovery-search/`. RPC budget: 1,000 logical calls, with a 180 second admission deadline (an in-flight call may finish later). Adapter retries remain bounded separately. Failure does not publish a success report or advance a checkpoint.

Recent factory entries do not establish token age. This sample does not cover other chains, V3, all historical pools, or all new tokens. Repeated runs are independent samples, not durable monitoring. Use the existing discovery monitor for checkpointed tracking.

Next evidence gates: broader protocol adapters with verified pricing, timestamped forward observations, token sellability checks, realistic transaction simulation, then out-of-sample analysis including losses and failed attempts. A positive grid result alone is not evidence of sustainable profit.

## Timing evidence

Reports include monotonic `collectionMs` and `analysisMs`, plus nearest-rank p50/p95/max duration for completed logical RPC calls. Failed calls remain in the distribution. Admission, completion, failure, in-flight and budget rejection counts are separate. Logical call duration includes the existing adapter's retries and backoff; `networkAttempts` stays unknown. Empty distributions are null, not zero.

These are per-run measurements, not service-level latency percentiles. Collection includes validation and network reads; analysis measures local calculations, and report writing is excluded. Event-to-capture and event-to-evaluation remain unknown until an event indexer provides authoritative event timing. A fast local calculation does not prove an execution advantage. The monotonic admission deadline prevents new calls after expiry; it does not cancel an existing adapter call.

## Reusing pinned reads

Each invocation has a bounded 1,000-entry cache tied to its one RPC provider. Only successful hex responses to exact `eth_call` requests with `requireCanonical: true` are reused; keys include block hash, contract address and calldata. The underlying transport still validates allowed selectors. Failures are never cached; different blocks never share results. The cache is discarded after the collection cycle.

Chain identity and block-header reads always reach the provider, including the final canonical check. This cache must not be used as a standalone proof of current canonicality. Its integration test verifies identical full discovery output, reduced provider calls, unchanged header checks and rejection of a reorg. `timing.cache` reports hits, misses and bypasses; `timing.rpc` measures only calls forwarded to the adapter. Cache hits do not count as network calls. Comparing live runs on different blocks/providers is observational, not a controlled speed benchmark.
