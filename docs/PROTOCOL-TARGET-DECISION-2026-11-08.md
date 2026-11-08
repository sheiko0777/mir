# MIR protocol income: target viability before more indexing

**Superseded research priority:** the [historical economic decision](PROTOCOL-INCOME-DECISION-2026-11-08.md) pauses WETH liquidation development as the first recurring-income bot. Alchemy resolved access and all 98 tracked positions were screened; the earlier data-gap statement below is historical. No profitable MIR model has been established.

Follow-up: [JSON-RPC clarification, network-access diagnostic and offline economics](LIQUITY-ECONOMIC-EXPERIMENT.md). The detailed data gap remains unresolved; no real candidate result is implied by the new calculator.

8 November 2026. All observations below are read-only snapshots, not permission to execute financially. MIR is independent, built by WADJ Studio; LXR is its internal engine.

## Decision and correction

**Pause holder-index expansion for the specific PoolTogether deployments tested.** Our earlier successful code/relationship reads established that contracts existed, not that they still accepted prize claims. The new preflight checks reveal that these are currently unsuitable targets for a claim bot. Preserve the worker and accounting code for reuse; do not force a profitable result or keep expanding an inactive target.

Continue research on the **current Liquity V2 WETH branch**. Its registry wiring matches current official addresses, shutdown time is zero, and the observed TroveIds array length is 98. That count is not a liquidation-candidate count, not necessarily 98 active positions, and not a revenue estimate.

## Actual observations

| Target | Observation at its saved block | Decision / evidence ID |
|---|---|---|
| PoolTogether Base `0x45b2010d8a4f08b53c9fa7544c51dfd9733732cb` | `isShutdown=true`, `isDrawFinalized=true`; last awarded 2026-09-04 22:39:49 UTC; claim window ended 2026-09-05 22:00 UTC | Not claimable at observed state. `6a242ebeb37ce03e4ac5abd5776e999a9b89ce5b051bccd87e0125784e0d9d1a` |
| PoolTogether Arbitrum `0x52e7910c4c287848c8828e8b17b8371f4ebc5d42` | `isShutdown=true`, last awarded draw 826 | Pause this target. `1229df701ca7601c63979f187144266052832c4ebf833d333ed9d80ccd00bb0e` |
| PoolTogether Ethereum `0x7865d01da4c9ba2f69b7879e6d2483ab6b354d95` | Claim window finalized/expired, last awarded draw 25 | No current claim opportunity established; not a statement that it can never award again. `bf2cfa24365de007b1ad169286ca925211a13775188ece147dd5d812b8969abd` |
| Liquity V2 WETH manager `0x7bcb64b2c9206a5b699ed43363f6f98d4776cf5a` | Ethereum registry branch 0 matches manager and WETH; `shutdownTime=0`; `getTroveIdsCount=98` | Eligible for further investigation only. `048638cc940b9333d9cf0b9f0f021d990c29f5b8a4772800b7f63cf82265f8d8` |

Base capture is under `data/bots/pooltogether`; the other three are under `data/protocol-survey`. Raw captures are local/ignored, content-addressed, and retain ordered RPC requests/results. No provider challenge or credentials requirement was bypassed. These observations concern these exact deployments at these blocks; do not generalize them to every PoolTogether deployment or UI listing.

The Base guarded run made 16 public reads, the two PoolTogether survey runs ten each, and Liquity's preflight eight. No retries, subscriptions, paid source or scheduler were used. Source views are not independent audited-bytecode matches or proof of current reward availability.

## Changes inside MIR

- Default PoolTogether policy now checks shutdown, award time, claim count, finality and the exact claim-window end **before** looking for more candidates. Closed cases skip discovery/winner/fee reads.
- Optional vault checks compare `prizePool()` and `claimer()` to the selected route. Getter agreement does not validate bytecode or simulate user hooks.
- The read budget is now at most 128 calls to accommodate those checks; elapsed/time/byte budgets remain bounded. Old captures without these optional flags replay with viability explicitly unverified.
- MIR Lab labels a verified real-source closed target `protocol-ineligible`. Its next task changes to selecting/verifying another target. Fictional controls cannot redirect the research plan.
- Closed-window rejection does not manufacture zero income observations for a working bot. No MIR cash receipt or net profit is asserted.

## Current Liquity screen implementation and limits

`tools/research/liquity_screen.py` is a fixed-target research screen, not an executor. It reuses the existing reviewed eth-abi/eth-utils environment, checks registry/settings/helper relationships at one hash, reads the sorted list in one bounded batch (maximum 128 positions), and checks the WETH branch's primary Chainlink metadata and round before calculating protocol collateral ratios with integers.

The minimum ratio is read from settings, not assumed from a marketing percentage. Equality at MCR is not flagged; zero collateral with positive debt is retained. The exact maximum integer oracle price producing a below-MCR ratio is `(debt * MCR - 1) // collateral` when collateral is positive. This is a state threshold, not a price forecast.

Coverage distinguishes TroveIds array count from sorted-list count and scanned rows. Zombies are excluded by this helper and coverage remains incomplete for the whole branch. Sorting is by interest rate, not proximity to liquidation. Additional conservative oracle round checks can reject data beyond the deployed feed's minimum validity rule; this is not a claim of full liquidation equivalence.

Even a below-MCR row remains **unqualified**: trove status and complete liquidation rules, gas, failed attempts, competition, full costs and transaction/withdrawal evidence still require validation. Net and actual receipts stay unknown. BOLD debt units here are protocol ratio units, not an assumption of a market USD peg.

Live detailed captures were attempted once per independent source:

- PublicNode Ethereum, HTTP 403 at the first request: `data/liquity-screen/f427d8e5563c85abbba63ab742aee4baf8e613e48ef1a235f24e0eaf004a81b9.json`.
- LlamaNodes' separately documented free public Ethereum endpoint, also HTTP 403 at the first request: `data/liquity-screen/ac736b18e073bd5550b41844cd09bec752805d562dafc663bd106211b937c907.json`.

**No live position-level screen completed. Candidate count is unknown, not zero.** The successful earlier Node preflight is retained as its own evidence; it does not supply missing position/oracle data. We did not retry these denied detailed reads, spoof headers or reroute them through another client.

The screen also supports offline replay of a complete capture, verifying filename/content identity, engine/reference hashes, request sequence, ABI canonical encoding and recomputed analysis. Failed captures cannot be promoted or substituted with fixtures. Existing failed captures have earlier engine identities and are retained as failure evidence, not replayable positive results.

## Sources, licensing and reproducibility

- [PoolTogether claim implementation](https://github.com/GenerationSoftware/pt-v5-prize-pool/blob/main/src/PrizePool.sol): finalized draws reject claims. Its ABI remains pinned to the existing published Base artifact.
- [Claimable vault source, pinned commit](https://github.com/GenerationSoftware/pt-v5-vault/blob/e328b319b66a341ea45d7aa565095888f2008294/src/abstract/Claimable.sol): public pool/claimer getters and hooks. Getter metadata is reconstructed from reviewed public declarations, not claimed to come from the deployment ABI or a compiled vault.
- Arbitrum and Ethereum PoolTogether deployment versions are 1.0.0; survey profiles pin publisher commits `72816ec8a6b506c570f09e60bd0b6f71a3cf36d6` and `ca2acf967a962355b921fd4893306b961e7bc62a` respectively.
- [Current Liquity contracts](https://docs.liquity.org/v2-documentation/technical-docs-and-audits), [pinned address manifest](https://github.com/liquity/bold/blob/d262669ef3c4d37bf0544df3bb2624c07b8a5ee0/contracts/addresses/1.json). The separately titled Legacy V2/Testnet page was rejected as the source for current target selection.
- Liquity getters and tuple layout are source-reviewed at commit `d262669ef3c4d37bf0544df3bb2624c07b8a5ee0`. Core contracts carry BUSL-1.1; several interfaces/feed sources carry MIT. No core implementation was copied, compiled, installed, forked or redistributed. MIR uses factual public interfaces and original read/analysis code. No new package was installed.
- Public endpoint documentation: [Arbitrum PublicNode](https://arbitrum.publicnode.com/), [Ethereum PublicNode](https://ethereum.publicnode.com/), [LlamaNodes](https://llamarpc.com/eth).

Local checks:

```powershell
npm test
tools/research/.venv-almanak/Scripts/python.exe tools/research/test_liquity_screen.py
```

Validation completed: **108 Node tests and seven Python screen/replay tests passed**. The Python positive controls are fictional unit tests and are not live liquidation findings. No funding, wallet or financial transaction was used.

The diagnostic survey uses only fixed reviewed targets. Its capture files are research reports, not imported Lab experiments or a financial execution queue. Re-running its default command would repeat source requests; respect recorded access denials rather than rerun blindly. Further live collection from denied sources is not part of this checkpoint.

## Next economic gate

Obtain permitted, synchronized position/oracle data, reproduce the screen, cover zombies/remaining positions, and simulate actual liquidation behavior and costs on local state before ranking a policy. No further index expansion for the rejected prize pools is justified without new target evidence. Success remains a positive, reproducible full-cost result plus forward evidence; it has not been achieved here.
