# MIR — Uniswap V2 fork view validation

Observed 2026-10-24. This extends the offline arithmetic fixture to actual deployed Uniswap V2 Router02 view calls. It does not establish profitability or authorize execution.

## Recorded live-state result

- Source: the existing public Ethereum endpoint `https://ethereum-rpc.publicnode.com`; source chain ID 1, local chain ID 31337, pinned Anvil v1.8.6 executable.
- Source block: `0x190b522`; hash `0x8aa7f4b9eab4d6dc4733b7be8488ad64754c351dbdb7614530f216d25fb50595`.
- Router02: `0x7a250d5630b4cf539739df2c5dacb4c659f2488d`. Factory: `0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f`. Addresses were checked against the [official deployments page](https://developers.uniswap.org/docs/protocols/v2/deployments). The pair is discovered using the factory and the existing USDC/WETH watchlist; no pair is trusted by symbol alone.
- Factory membership, token ordering, router factory/WETH identity, runtime bytecode and reserves were compared. Runtime hashes in the report are SHA-256 evidence hashes, not Ethereum `EXTCODEHASH` values or independent state proofs.
- Eight `getAmountsOut` calls matched LXR exactly: inputs 1/500/5,000/50,000 USDC and 0.0001/0.01/0.1/1 WETH, expressed and calculated as atomic integer amounts. USDC sizes are quote probes, not USD capital experiments or an assumed dollar peg.
- Thirty public source reads; zero unlocked accounts, zero transaction submissions, no funded accounts or altered token storage. Canonical source hash was checked again after the live comparison.

The successful live archive is local and ignored by Git: `data/evm/fork-checks/1792825096604.json`.

Its SHA-256 is `d08021d9b0a7063b76f9361def544c689673a8cbcec3097d660077d6a39c61e6`.

## Restricted source transport

The temporary loopback proxy accepts individually validated JSON-RPC requests, restricts state reads to the selected block number or its exact EIP-1898 block hash and restricts addresses/selectors. It rejects public transaction submission, account changes, state overrides, arbitrary targets, changed hashes and moving block tags. Anvil's legitimate full-block reads remain pinned. No unrestricted raw RPC forwarding is added to MIR.

Bounds: 100 source requests, 180 seconds for admission, 250 ms between source admissions, 64 KiB incoming proxy requests, 2 MiB per successful upstream response and 8 MiB aggregate successful response bytes. An in-flight request can finish after the admission deadline. Failed requests and rejected proxy requests are retained. The public endpoint is fixed; no credentials or URL secrets are accepted.

Local gas price is explicitly set to the pinned base fee to avoid querying a moving gas price during fork initialization. Priority fee, complete swap gas usage, denomination conversion and net PnL remain unknown; `gasCostUsd` and `netUsd` are null. View call gas must not be substituted for swap costs.

## Exact recorded-state replay

A later attempt to read historical state from the public endpoint returned HTTP 403 with a personal-token requirement. The attempt was saved as unavailable; no personal token, subscription or alternate identity was requested. Existing captured responses provide a finite local replay fixture without requesting restricted archive access.

```text
# Fresh finalized state (public data availability required)
npm run test:fork

# Live historical request (may be unavailable on the free endpoint)
node tools/evm/fork-quote-check.mjs --block=0x190b522

# Re-run the recorded state without external RPC
node tools/evm/fork-quote-check.mjs --replay=data/evm/fork-checks/1792825096604.json --sha256=d08021d9b0a7063b76f9361def544c689673a8cbcec3097d660077d6a39c61e6
```

The original archive must exist locally; it is not bundled in Git. Replay requires its expected digest, checks provenance/capture times, rejects conflicting responses and fails on any uncaptured read. It never falls back to network or invented state. Stored winner flags and stored quote outputs are not accepted as results: Anvil re-executes the recorded contract code/state and LXR recalculates outputs.

The observed replay reproduced all eight view comparisons, using only the loopback RPC proxy and zero external source calls. Replay mode records the original capture time and reports canonical checks as recorded at capture. It is not a new canonical-chain check or a new market observation. The digest detects changed bytes; it does not prove that the original provider was truthful. This finite fixture cannot answer arbitrary future queries or simulate previously uncaptured paths.

Reports are written to `outputs/evm/fork-quote-check.json` and per-run local archives under `data/evm/fork-checks/`. The latest report represents the latest attempt, including failure; older successful and failed archives are preserved. Initial setup failures revealed Anvil's full-block and block-hash request forms and remain archived too.

## Remaining gates

No token transfers, actual swap path, sellability, taxes, unusual token behavior, MEV, slippage during inclusion, full swap gas economics, capital/margin strategy, independent test period or forward return are validated here. No data for these gaps is synthesized. A broader source or a later local transfer simulation requires separate evaluation. All reports remain unqualified with net profit unknown.
