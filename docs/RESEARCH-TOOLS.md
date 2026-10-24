# MIR research tool environments

Tools support the existing read-only and local simulation plan. Installation is separate from integration, and neither is evidence of a profitable strategy. No wallet, secret, paid subscription, live signer or autonomous financial execution is added.

## Anvil v1.8.6 — installed and locally exercised

- Only `anvil.exe` is extracted from the official Windows x64 release, under `tools/evm/.bin/v1.8.6/`. No PATH/global installation, Foundry shell installer, Forge or Cast installation is performed.
- The archive and upstream SPDX SBOM are checked against the release asset SHA-256 values in `tools/evm/anvil-resource.json`; the extracted executable is separately pinned. This is checksum verification, not independent Sigstore verification or a security audit.
- MIT/Apache notices are retained under `tools/evm/licenses`. The dependency SBOM and local installation receipt remain under ignored `data/evm/`.
- `local-quote-check.mjs` starts an ephemeral loopback chain with ID 31337, zero accounts and no mining. It uses only local read calls and per-call state overrides; no transaction submission or external RPC is used. The child process is stopped afterward.
- Seventy-two positive synthetic uint112 arithmetic cases, including both orientations, dust, large reserves and differing token scales, matched LXR exactly. The bytecode is an original arithmetic fixture, not Uniswap deployment bytecode. Token sellability, taxes, hooks, real swap execution, economic gas costs and profitability are not verified by this fixture.

```text
python tools/evm/install_anvil.py
node tools/evm/local-quote-check.mjs
```

Report: `outputs/evm/local-quote-check.json`. Upstream: [release v1.8.6](https://github.com/foundry-rs/foundry/releases/tag/v1.8.6), [MIT](https://github.com/foundry-rs/foundry/blob/v1.8.6/LICENSE-MIT), [Apache](https://github.com/foundry-rs/foundry/blob/v1.8.6/LICENSE-APACHE).

### Actual Router02 fork view comparison

`npm run test:fork` now compares eight exact-input view quotes against actual Ethereum Uniswap V2 Router02 code in an Anvil fork, including both USDC/WETH directions. It checks factory/token identity, router WETH/factory values, runtime code, reserves and block hash. Source reads pass through a fixed-block allowlist and a request/time/response-size budget; zero accounts and zero transaction submissions remain enforced. See [fork validation and replay evidence](FORK-QUOTE-VALIDATION.md). This is a view-quote comparison, not a swap, sellability check or economic return test.

## Almanak 2.29.2 — installed; offline HOLD probe passed

The reviewed source and distributed Windows wheel are pinned to 2.29.2. PyPI also offered 3.0.0 during this evaluation; that major version was not selected without review. Main MIR research remains in its existing environment; Almanak has a separate `.venv-almanak` environment.

The binary-wheel resolution contains 91 packages totaling 115,621,603 compressed bytes. Exact versions, wheel sources, SHA-256 values, dependency metadata and notice paths are retained in `almanak-resources.json` and `almanak-win-cp314.lock`. Packages are installed from the reviewed local wheel set without index access or source builds. This does not establish that every SDK feature works on Windows/Python 3.14.

Installed-version verification passed for all 91 packages, `pip check` reported no broken requirements, and the offline HOLD intent serialization round trip passed. The installation outlasted the initial shell observation timeout; the original process was allowed to finish, rather than running overlapping package writers. Final checks, not the initial timeout, establish this local installation status.

The wheel review retains 156 license/notice artifacts. Ten distributions omit a license metadata field; actual notice files, rather than metadata alone, are preserved. Two wheels omit notice files: jsonalias and pyluach. Their upstream notices are retained separately, and a Git blob comparison ties their initializer source to the wheel. This is limited source matching, not a whole-project license audit. The jsonalias upstream MIT notice contains template copyright fields; these are preserved verbatim and documented in `almanak-license-supplements.json`, not silently filled in. Redistribution terms still require review before distributing a bundled product.

The one observed startup `.pth` belongs to pywin32. Its bootstrap locates the installed DLL directory using `os.add_dll_directory`; it was read before installation. No SDK skill installer, strategy runner, managed gateway or wallet setup is run by these evaluation commands.

Local evaluation sequence:

```text
python -m venv tools/research/.venv-almanak
tools/research/.venv-almanak/Scripts/python.exe -m pip download --require-hashes --only-binary=:all: --no-deps --dest work/almanak-review/wheels -r tools/research/almanak-win-cp314.lock
python tools/research/review_almanak_wheels.py
tools/research/.venv-almanak/Scripts/python.exe -m pip install --no-index --find-links work/almanak-review/wheels --require-hashes --only-binary=:all: --no-deps -r tools/research/almanak-win-cp314.lock
tools/research/.venv-almanak/Scripts/python.exe tools/research/audit_almanak.py
tools/research/.venv-almanak/Scripts/python.exe -m pip check
node tools/research/run-almanak-probe.mjs
```

`prepare_almanak.py` records a reviewed pip resolution; it is not an automatic update mechanism. Any regenerated resolution requires a fresh wheel/license/startup-hook review. Other platforms/interpreters need a separately reviewed lock.

The runtime probe checks only a deterministic HOLD intent serialization round trip. Its launcher supplies a small environment without credential variables; the Python probe blocks Python socket connections and subprocess spawning before importing the intent module. These are evaluation guards, not an operating-system sandbox. `outputs/almanak/offline-probe.json` is produced only after a successful probe. Strategy/backtest/fork integration, default/fallback rates, modeled cost accuracy and return calculations require separate tests. MIR must not accept SDK defaults or externally reported winners as measured returns.

Upstream references: [reviewed manifest](https://github.com/almanak-co/sdk/blob/39cfabb780d297f5f90e2f3ee68215dfb382b5f2/pyproject.toml), [backtest caveats](https://github.com/almanak-co/sdk/blob/39cfabb780d297f5f90e2f3ee68215dfb382b5f2/README.md#backtesting).

## Deferred tools

Ponder remains a candidate for the event-journal benchmark, which first needs a fixed input/reorg fixture and an operational comparison with the existing collector. AgentKit, smart accounts, paid agent commerce and HyperIndex are not installed by this stage. Selection depends on a specific need, permissions, license and measurable benefit; listing a tool in the research file is not itself a reason to install it.
