# MIR Liquity: economic experiment and data-access checkpoint

8 November 2026. Read-only/offline research. No financial execution, accounts, keys, purchases or background monitor.

## Evidence status

The previously saved eight-read preflight remains valid evidence of its observed state: the current Liquity V2 WETH manager was not shut down and reported 98 TroveIds. It does not contain position-level data, oracle rounds or gas usage. See [target selection](PROTOCOL-TARGET-DECISION-2026-11-08.md).

The reviewed detailed collector was also tried once with explicit sandbox network escalation to distinguish a local sandbox restriction from an external denial. Approval was granted, but the **same collector and endpoint still returned HTTP 403 at the first request**. New local record:

`data/liquity-screen/5f6c14fde0dfac9afc67412e6c778cfa064c097a6c5abedcbf9f07d1351a3b22.json`.

This does not establish the final cause of the refusal; it shows that granting that network permission did not fix it. No headers were spoofed, credentials supplied, challenge bypassed or requests routed through another client to work around the denial. Do not keep re-running the denied sources without a legitimate access-state change.

Official repository and subgraph documentation were reviewed for independent published data. No complete, permitted synchronized position/oracle snapshot was obtained. Public API code with aggregate branch statistics is not a replacement for position state. Frontend documentation also mentions origin-restricted subgraphs; no origin was forged or embedded client credential reused.

The JSON-RPC documentation supplied by the user describes a protocol, not an available node. Its `127.0.0.1:8545` is an example. No listener was found on the common local Ethereum ports checked (8545, 8546, 9545, 18545, 18546). Starting a Geth development chain would create synthetic state, not the real Liquity WETH branch. The linked browser playground did not open successfully in this session; no data result is attributed to it. Deployment/signing examples in the document are reference material, not new authority to execute them.

The collector already uses JSON Content-Type, empty `eth_chainId` params and canonical hexadecimal quantities. The refusal occurs before a block or contract call, so changing the later ABI or block parameter is not an evidence-based fix.

## Offline economic component built

`tools/research/liquity_economics.py` accepts only a complete capture that passes the existing replay verifier, plus a frozen explicit scenario policy. It makes **zero network requests**. The policy hash and source block/capture identities are saved with the result; unverified saved profit fields cannot supply a result.

The component supports the WETH branch only. It keeps all amounts as integer atomic units, uses WETH/native-wei unit equivalence rather than a USD peg, and requires an explicit settlement/unwrapping cost. Its gross formula is conditional on a full liquidation succeeding:

```
R = 0.0375 WETH + min(collateral / 200 rounded down, 2 WETH)
```

The constants were checked against [the pinned official source](https://github.com/liquity/bold/blob/d262669ef3c4d37bf0544df3bb2624c07b8a5ee0/contracts/src/Dependencies/Constants.sol). They are formula inputs, not observed payments. Full trove eligibility, oracle/state changes and actual transfers still need execution evidence.

The default policy in `config/liquity-economics-policy.json` leaves **every cost and the win probability unknown**. It does not assume that MIR beats other bots or that monitoring is free.

```
S = successGasUnits * gasPrice + successOtherCost + settlementCost
F = failedGasUnits * gasPrice + failedOtherCost
A = shared monitoring/data/maintenance/capital cost allocated per attempt

conditional net if successful = R - S - A
probability-weighted scenario = p * (R - S) - (1 - p) * F - A
```

All policies are labelled `assumed-scenario`; a caller cannot relabel them as measured evidence. A positive probability-weighted scenario is still not verified profit. Failed races retain their gas loss. No-attempt periods must also be allocated into shared operating costs before promotion; this calculator does not establish that work arrives regularly.

For exact rational `p = n/d`, the numerator is `n*(R-S) - (d-n)*F - d*A`, divided with conservative downward rounding. Break-even requires `p > (F+A)/(R-S+F)` when a feasible probability exists. Equality is zero, not a profitable case. Both successful-case and probability-weighted results are also computed with **all costs doubled** while the reward is unchanged.

If a material cost is missing, net stays unknown. If the win probability is missing, the probability-weighted result stays unknown even when the conditional successful-case result is positive. Candidate scenarios are independent alternatives; do not sum them as if they were a jointly costed batch.

## Validation and use

Six economic unit tests verify rounding/caps, unknown costs, unknown competition probability, a positive-success/negative-competition case, strict rational break-even, stress costs and input bounds. All values used in those tests are **fictional controls**, not live MIR returns. No economic result report was generated from a real candidate because no complete live position capture exists.

Run the local checks without network:

```powershell
tools/research/.venv-almanak/Scripts/python.exe tools/research/test_liquity_economics.py
tools/research/.venv-almanak/Scripts/python.exe tools/research/test_liquity_screen.py
```

Once a complete permitted capture actually exists, the economic CLI takes its real file path with `--capture` and an optional policy path with `--policy`. It does not collect missing source data, simulate a liquidation or fill unknown fees automatically. No new dependency was installed; the existing reviewed environment is reused.

## Remaining blocking input

A permitted Ethereum mainnet data source, local synchronized node or complete source-recorded snapshot is still required. It must provide block-aligned registry/settings/position/oracle reads, not just an API specification, price chart or aggregate TVL. No API secret is needed by the current plan, and none should be pasted into chat. Until that input is available, live candidates, gas simulation and actual net remain unknown.
