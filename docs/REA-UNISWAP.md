# Uniswap V2 SDK reference research

Isolated reference: `@uniswap/v2-sdk@4.21.5` under `tools/rea/reference`, not an application runtime dependency. Its actual LICENSE declares MIT; retain notices with copies or substantial portions. Do not infer licenses of Uniswap contracts or all transitive files from this declaration.

After `npm install --prefix tools/rea/reference --ignore-scripts --no-audit --no-fund`, run `node tools/rea/compare-v2.mjs`. Observed: 1008 quotes, 959 matching outputs, 37 expected dust differences, 12 shared invalid-domain rejections, zero unexpected differences. The overlapping 288 two-hop routes had 272 matches and 16 expected dust differences. Finite synthetic observations use fixed 0.3% fees with fee-on-transfer calculations disabled; they do not prove equivalence for all inputs or live profitability.

LXR returns zero for rounded-away output; SDK throws `InsufficientInputAmountError`. Existing LXR `DUST_OUTPUT` rejects the route. No arithmetic change was warranted within tested scope.

Separate REA 6.7.0 static analysis: 57 relevant files, 40 JavaScript files parsed, zero parse failures; 315 application nodes, 534 edges; 6902 semantic nodes, 4821 relations and 2225 unknown records. Application coverage is partial and aggregate semantic coverage unknown. The 454 findings are observations, not a vulnerability count. Static relationships do not prove runtime reachability.

Evidence ID: `ev_11f11c298defd19f57d8fc8e5be85e64e947f4277abea18d664c8bdb2a4c3839`.

REA target SHA-256: `21d8f7c927032e429af0da69f66424abb68dd67923439194e56fb9f61196543b`.

Full Evidence, cases, license and manifest remain local artifacts under `outputs/REA-Uniswap-V2`. Recreate with `describe-target.mjs`, `compare-v2.mjs`, `capture-analysis.mjs`, `retain-analysis.mjs outputs/REA-Uniswap-V2/rea-cli-stdout.txt`, then `summarize-evidence.mjs`. Complete stdout/stderr are captured directly to files to avoid shell output caps. These utilities do not change Codex settings; local approved REA setup was a separate action.

Official source: https://github.com/Uniswap/sdks/tree/main/sdks/v2-sdk. The package and lockfile pin the actual version examined.
