# Reusing existing projects in MIR

المبدأ: نعيد استخدام المكوّن المناسب بعد فحصه، ونوثق المصدر والإصدار والرخصة وحدود الاختبار. الكود المفتوح الكامل يُراجع مباشرة؛ الهندسة العكسية مفيدة للحزم الموزعة أو السلوك غير الموثق. لا نستخدمها لاستنساخ تنفيذ خاص أو تجاوز صلاحيات منصة.

| Resource | Verified version / identity | Role in MIR | License / scope |
|---|---|---|---|
| Uniswap V2 SDK | npm `@uniswap/v2-sdk@4.21.5`, lockfile under `tools/rea/reference` | Actual independent swap oracle for quote and costed-size regression checks in CI | Installed package LICENSE: MIT, copyright 2021 Uniswap Labs; keep notice with copies/substantial portions |
| REA | CLI 6.7.0; retained static Evidence ID in `REA-UNISWAP.md` | Inspection of the distributed JavaScript package | Analysis tool, not an imported production component; no claim that its own license transfers to MIR |
| EIP-1559 | linked normative specification | Reference for distinguishing historical base fee, priority fee and modeled cost | Specification reference; MIR's scenario arithmetic is independently implemented |

The SDK is genuinely executed by `compare-v2.mjs` and `compare-sizing.mjs`; naming it in a diagram is not counted as integration. Reference installation is isolated and disables lifecycle scripts. Version mismatches or unexpected results fail the harness; CI runs both comparisons. SDK source implementation has not been copied into LXR. Its license does not determine licenses of contracts or every transitive dependency. The actual package license and dependency manifest can be regenerated with `describe-target.mjs`.

For another candidate, record its concrete missing capability, immutable release or digest, actual license file and notices, dependency/security review, exported interface and read-only scope, and behavior tests against the existing module. Prefer an adapter over merging an entire unrelated project. Benchmark resource cost and latency before claiming improvement. Unknown licensing or unverified behavior means “not integrated,” not silently approved.

Commercial products may inform observed public behavior and interaction design; that observation does not grant rights to their code, private endpoints, credentials or proprietary assets. Any future paid service or external write stays within the user's authorized scope. No new API secrets are requested for this workflow.
