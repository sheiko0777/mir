# Read-only Ethereum monitor

MIR now includes a dependency-free JSON-RPC adapter for the Ethereum mainnet Uniswap V2 factory. This is bounded factory discovery and snapshot collection, not opportunity qualification or a trade service.

```sh
node apps/monitor/live.mjs --count 1
node apps/monitor/live.mjs --start 0 --count 3 --watch
```

Default public provider: `https://ethereum-rpc.publicnode.com`. No account or API secret is needed. Optionally set `MIR_PUBLIC_RPC_URL` to a trusted, credential-free HTTPS public Ethereum endpoint. Provider URLs and remote error bodies are not logged. Public providers can be unavailable, rate limited, or lack required historical/hash-pinned reads; the monitor rejects the collection instead of falling back to inconsistent latest-block reads.

`--start` is the factory pair index, `--count` is 1–10. The first pools in factory order are not curated or recommended assets. Repeated watch runs poll the same bounded window every 60 seconds; Ctrl+C stops them. This does not enumerate the entire factory or incrementally ingest PairCreated events.

The adapter checks chain ID 1, selects the finalized block, rejects block timestamps older than 30 minutes or in the future, then pins all contract reads to its hash with `requireCanonical: true` (EIP-1898). It verifies factory membership in both directions, token ordering, token decimals and reserve ABI widths, and rechecks the canonical block before returning a collection. Empty pools are reported separately. Unsupported token metadata, malformed responses or RPC failures reject the whole collection; no partial snapshot is published.

Snapshots are saved atomically in ignored `data/snapshots/` files. File identity includes block number/hash and discovery window; repeated collection of the same finalized block replaces that window's snapshot. Bigint amounts are decimal strings; decimals are stored separately. `observedAtMs` is the block time, while `capturedAtMs` is collection start. A reserve's last update timestamp is separately retained; old update time alone does not prove that reserves are stale.

Every live pool has `tokenChecksPassed: null` and explicit missing-risk/gas reasons. No live pool is sent to the paper ledger automatically. The existing demo's 30-second freshness policy is deliberately too strict for finalized historical observations; live research will need a separate, explicit evidence/finality policy before qualifying routes.

Limitations: one RPC provider is trusted for chain responses; no independent consensus verification or bytecode proof is performed. Finality and the post-read hash check reduce reorg exposure but do not implement historical invalidation after exceptional finality reversals. JSON files are a starter archive, not a query database or a durable paper journal. Multiple independent monitor processes should use separate working directories. Symbol strings are omitted because token addresses are the identifiers. No price USD valuation is inferred.

Protocol references checked on 18 October 2026:

- [Official Uniswap V2 deployments](https://developers.uniswap.org/docs/protocols/v2/deployments)
- [Factory interface](https://github.com/Uniswap/v2-core/blob/master/contracts/interfaces/IUniswapV2Factory.sol)
- [Pair interface](https://github.com/Uniswap/v2-core/blob/master/contracts/interfaces/IUniswapV2Pair.sol)
- [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/)
- [EIP-1898 block hash pinning](https://eips.ethereum.org/EIPS/eip-1898)
- [PublicNode Ethereum service](https://ethereum.publicnode.com/)

## Verified run — 18 October 2026

All 11 offline tests passed. A one-pool public RPC run completed successfully, checking factory index 0 and saving a snapshot at finalized Ethereum block **26220104**, hash `0x4ba3d093a0d9c335481eac7feac279d18c339ef301dced0e547a48d3166128ae`. The discovered pair was `0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc`; decimals were read as 6 and 18. There were no excluded pools in this bounded run, and no opportunity was qualified or paper-filled. The historical result is retained in `samples/ethereum-uniswap-v2-26220104.json`; it is not current market data. Continuous monitoring was not left running.

The standard npm argument-forwarding form failed in this environment's command wrapper. The direct Node commands above were used successfully.
