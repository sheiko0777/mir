# MIR by WADJ

MIR is the independent Web3 research platform. **LXR (Liquidity X-Ray)** is its replaceable liquidity and opportunity analysis engine. WADJ remains the parent brand. `mir.wadj.online` is a tentative domain only; no DNS or deployment was performed.

## Discovery — 18 October 2026

The GitHub API confirmed that [sheiko0777/mir](https://github.com/sheiko0777/mir) is public, has size 0, and its contents endpoint reports **This repository is empty**. There were no existing source files, README, stack, tests or deployment configuration to reuse. The earlier chat's assistant replies were returned as content-reference placeholders, so no additional architecture was inferred from them.

This project started as a local implementation; discovery above records the initial repository state.

## Connected local workspace

The source and completed MIR identity kit now live together in `C:/Users/sheri/Documents/ChatGPT/MIR`. Start the local workspace with `npm start`, then open `http://127.0.0.1:4173/`. It binds to loopback only. No installation, wallet or API secret is required.

`apps/web` contains the branded responsive landing page, MIR overview, LXR discovery and component gallery. `apps/server` serves static assets and the read-only `GET /api/discovery` endpoint. The default view reads only the last report referenced by the discovery checkpoint. Sample data require explicit selection and are never a fallback for failed or missing observations. Capture age, block/hash, unknown token age and risk reasons are visible. Reports older than 30 minutes are flagged stale; capture freshness does not establish current market conditions.

Run `npm run discover` separately for a bounded new collection, then reload the report in the UI. The reload button reads stored data and does not trigger RPC collection. Missing/corrupt reports clear the table; net profit remains unknown and every route stays unqualified. No background monitoring is started by the server. The identity kit and original sample pages remain unchanged under `outputs/MIR-Brand-Kit-v1`.

## Run

Requires Node.js 22 or newer; no dependencies, installation, wallet or API secrets required.

```sh
npm test
npm start
npm run demo
node apps/monitor/live.mjs --count 1
npm run research
npm run discover
npm run agent
```

The demo reads two synthetic pool snapshots, evaluates both swap directions, rejects routes that fail policy and records at most one eligible route in an in-memory paper ledger. All integer output amounts are strings in atomic units; the synthetic quote token has 6 decimals. This is a one-shot pipeline, not a continuous live monitor. Restarting resets the ledger.

## Initial structure

```text
apps/monitor/demo.mjs       MIR demonstration entry point
packages/adapters/fixture.mjs  Synthetic source; replace via snapshot contract
packages/lxr/index.mjs      Pure AMM calculation and risk gates
packages/paper/index.mjs    Paper-only accounting
test/lxr.test.mjs           Math, validation and accounting checks
docs/ARCHITECTURE.md        Boundaries and data contract
docs/ROADMAP.md             Phases and acceptance criteria
```

Built: fixture ingestion, constant-product two-pool route estimation, integer fee math, freshness and block alignment gates, token-check gate, size caps, cost-adjusted net results, duplicate-resistant paper accounting and tests.

Added next: a read-only Ethereum/Uniswap V2 adapter, bounded factory discovery, finalized hash-pinned snapshots, atomic JSON persistence and optional polling. See [live monitor setup and limitations](docs/LIVE-MONITOR.md). Live token checks remain unknown and no live opportunity is qualified.

Two-venue research now selects USDC/WETH on Uniswap V2 and SushiSwap V2 at one shared finalized hash and evaluates both directions with LXR. Gross results exclude gas; net results remain unknown and cannot create paper fills. See [research setup and limitations](docs/RESEARCH.md).

LXR now detects newly appended factory pools with persistent checkpoints, distinguishes local first-seen tokens from unknown token age, compares same-pair prices across both venues, and revisits empty or one-venue pairs with supported quote tokens. See [new pool discovery guide (Arabic)](docs/NEW-POOLS.md). This does not certify a token as newly launched or safe.

Still needed: full discovery/event indexing, queryable historical storage/reorg invalidation, independent token-risk evidence, gas valuation, an authenticated hosted platform, historical dashboard views, durable paper journal, observability and deployment. The current server is a local read-only workspace, not a hosted multi-user service. Concentrated-liquidity pools, stable-swap curves, token taxes, MEV and cross-chain routes are unsupported. No license was selected on the owner's behalf.

Fees and reserve price impact are included in each swap estimate. Gas and buffer are explicit synthetic quote-token inputs. A positive estimate does not establish that a trade could execute or earn that amount. The token-check fixture flag is not a security audit.

No signing, private keys, wallet connections, token approvals, transaction submission or autonomous real-money execution is included.

## Evidence agent

Costed-size research is now available through `npm run size:demo` (explicit synthetic data) and `npm run research` (saved live observations with optional explicit gas assumptions). It compares a bounded size grid after pool fees, gas scenarios and buffer, retaining losses and unknowns. The best modeled case remains unqualified. See [cost identity, commands and limitations](docs/SIZING.md), and [verified open-source reuse](docs/OPEN-SOURCE-REUSE.md).

`npm run agent` plans bounded evidence-collection decisions from saved discovery observations. `npm run agent -- --watch` revisits new reports with adaptive polling, persistent deduplication and an atomic local journal. It is an auditable rules-based agent; no LLM integration is claimed. Unknown token checks and gas valuation keep every live signal unqualified. See [agent scope and phased development](docs/AGENT.md) and [SDK reference research](docs/REA-UNISWAP.md). Processing latency is recorded; it is not a claim of end-to-end market latency or continuous profits.

## Costed research and agent review

`npm run research` publishes a validated local research checkpoint. `GET /api/research` recomputes its bounded size matrix and provides a read-only agent preview in MIR overview and LXR. Gas remains unknown unless explicit scenario assumptions are supplied. Mock mode clears this independent panel. `npm run agent` maintains separate persistent discovery/research decision histories; page reloads do not collect data or save decisions. See [research storage and provenance](docs/RESEARCH.md) and [agent boundaries](docs/AGENT.md).

`npm run paper:forward` registers a costed hypothesis before a later observation, then replays the frozen direction, size and policy on a later committed block. Its bounded atomic journal survives restarts, retains expired/unknown results and creates no balances or fills. This CLI workflow is separate from the UI preview. See [forward experiments and limitations](docs/FORWARD-EXPERIMENTS.md).
