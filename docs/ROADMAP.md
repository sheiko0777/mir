# Phased roadmap

| Phase | Work | Exit criteria |
|---|---|---|
| 0 — Foundation (this starter) | WADJ → MIR → modular LXR, synthetic routes, risk gates, paper math | Demo and tests pass; synthetic data clearly labeled |
| 1 — Read-only discovery | Choose one chain/protocol; verify factories and tokens; enumerate an allowlisted pool universe | Reproducible discovery list with chain/address/model/decimals and source evidence; unsupported pools excluded |
| 2 — Pool monitoring | Poll pinned blocks; store snapshots in SQLite initially; source health, backoff, confirmations and reorg handling | Restart resumes monitoring; stale/missing/reorged data cannot qualify; fixtures replay consistently |
| 3 — Opportunity research | Compare same-pair routes and size candidates; value gas in quote token; capture independent risk evidence | Golden protocol quote comparisons within integer rounding; costs and assumptions visible; unsafe/unknown cases rejected |
| 4 — Paper simulation | Persistent virtual balances, hypothetical fills with delay, failures and changing reserves; replayable journal | Deterministic replay; no double counting; balance reconciliation; negative scenarios included |
| 5 — MIR platform | Dashboard with pool watchlists, evidence, costs, rejected reasons and paper history; API and user settings | End-to-end read-only demo; clear data freshness and simulation labels; access controls where needed |
| 6 — Release preparation | Monitoring, backups, operational limits, dependency review, deployment preview | Reviewed preview and restore check; confirm domain ownership/configuration before using tentative mir.wadj.online |

Progress after foundation: a bounded Ethereum/Uniswap V2 read adapter now implements factory checks, finalized hash pinning, token decimals, reserve decoding, canonical recheck, JSON archives and optional 60-second polling. Mock-RPC tests cover validation and transport failures. This partially implements phases 1–2; it does not meet their full exit criteria. See LIVE-MONITOR.md for limits and run instructions.

Progress after monitoring: explicit USDC/WETH selection and a second verified factory (SushiSwap V2) now support two-direction LXR research on one shared finalized hash. Reports retain missing-market exclusions and keep net profit unknown without costs. Research output cannot create paper fills.

Discovery engine added: bounded incremental factory enumeration, durable cursor with canonical checkpoint validation, local token first-seen catalogue, a retry queue for empty/one-venue pairs with supported quote tokens, exact reserve-price gap detection and size-aware LXR research. Bootstrap history coverage is explicit. Token deployment age, exhaustive history, all-pool price monitoring and independent contract-risk evidence remain unimplemented.

MIR workspace delivered locally: responsive reference-aligned landing, MIR/LXR desktop and mobile views, dark/light themes, saved-report API, explicit sample mode, evidence dialogs, local watchlists, search/filtering and export. The server binds to loopback and serves GET/HEAD only. Saved observations show capture age and never qualify a route. This partially implements phase 5; it does not add persistent paper history, accounts or deployment.

The visual delivery includes original vector masters, a 20-page brand book, tokens, reusable patterns, optimized imagery, social templates, fonts/licenses, browser screenshots and an editable Figma identity board. See outputs/MIR-Brand-Kit-v2 and outputs/reference-alignment.

Next practical milestone: read-only protocol router quote comparisons, source-health evidence, independent token-risk checks and gas conversion evidence. Keep synthetic and mock-RPC adapters for offline regression checks. Real opportunity qualification remains blocked pending that evidence.

Current layout: `apps/web` for the MIR dashboard, `apps/server` for read-only queries and local assets, `apps/monitor` for collection, `packages/lxr` for research math, `packages/adapters` for sources and `packages/paper` for simulation. Add `packages/storage` once persistent snapshots and paper history are implemented. Do not create empty application frameworks before these responsibilities are needed.

Real-money execution, wallet custody, approvals and autonomous transactions are outside all phases of this roadmap. No network service or domain has been provisioned.
