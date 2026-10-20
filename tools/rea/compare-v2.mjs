import { createRequire } from 'node:module';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { amountOut } from '../../packages/lxr/index.mjs';

// Ordinary offline runtime observations; these are not REA static Evidence.
const root = fileURLToPath(new URL('../../', import.meta.url));
const referenceRequire = createRequire(new URL('./reference/package.json', import.meta.url));
const sdkEntry = referenceRequire.resolve('@uniswap/v2-sdk');
const sdkRequire = createRequire(sdkEntry);
const { Pair } = referenceRequire('@uniswap/v2-sdk');
// Resolve core from the shipped SDK, avoiding duplicate Token/CurrencyAmount classes.
const { Token, CurrencyAmount } = sdkRequire('@uniswap/sdk-core');
const targetVersion = '4.21.5';
async function packageInfo(entry, name) {
  for (let directory = dirname(entry); ; directory = dirname(directory)) {
    try {
      const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
      if (metadata.name === name) return { name, version: metadata.version, entry, packageJson: join(directory, 'package.json') };
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (dirname(directory) === directory) throw new Error(`Cannot locate metadata for ${name}`);
  }
}
const reference = await packageInfo(sdkEntry, '@uniswap/v2-sdk');
const core = await packageInfo(sdkRequire.resolve('@uniswap/sdk-core'), '@uniswap/sdk-core');
const rows = [];
const max112 = (1n << 112n) - 1n;
const tokens = decimals => decimals.map((value, index) => new Token(1,
  `0x${(index + 1).toString(16).padStart(40, '0')}`, value, `T${index}`, `Synthetic ${index}`));
function observe(callback) {
  try { return { kind: 'output', raw: callback().toString() }; }
  catch (error) {
    return { kind: 'rejection', errorClass: error.constructor.name, name: error.name,
      message: error.message, insufficientInputAmount: error.isInsufficientInputAmountError === true };
  }
}
function sdkQuote(input, reserveIn, reserveOut, tokenIn, tokenOut) {
  const pair = new Pair(CurrencyAmount.fromRawAmount(tokenIn, reserveIn.toString()),
    CurrencyAmount.fromRawAmount(tokenOut, reserveOut.toString()));
  return BigInt(pair.getOutputAmount(CurrencyAmount.fromRawAmount(tokenIn, input.toString()), false)[0].quotient.toString());
}
function compare({ id, input, reserveIn, reserveOut, tokenIn, tokenOut, rejection = false, category = 'single-hop' }) {
  const lxr = observe(() => amountOut(input, reserveIn, reserveOut, 30));
  const sdk = observe(() => sdkQuote(input, reserveIn, reserveOut, tokenIn, tokenOut));
  let classification = 'unexpected-mismatch';
  if (rejection && lxr.kind === 'rejection' && sdk.kind === 'rejection') classification = 'expected-rejection';
  else if (!rejection && lxr.kind === 'output' && sdk.kind === 'output' && lxr.raw === sdk.raw) classification = 'matching-output';
  else if (!rejection && lxr.kind === 'output' && lxr.raw === '0' && sdk.kind === 'rejection' &&
    (sdk.insufficientInputAmount || sdk.errorClass === 'InsufficientInputAmountError')) classification = 'expected-semantic-difference';
  const row = { id, category, input, reserveIn, reserveOut,
    inputToken: { address: tokenIn.address, decimals: tokenIn.decimals },
    outputToken: { address: tokenOut.address, decimals: tokenOut.decimals }, lxr, sdk, classification };
  if (classification === 'expected-semantic-difference') row.explanation = 'Positive input rounds to zero output: LXR returns 0; SDK rejects with InsufficientInputAmountError.';
  rows.push(row);
  return row;
}

const vectors = [
  ['balanced', 10_000n, 1_000_000n, 1_000_000n],
  ['one-unit-input', 1n, 1_000_000n, 1_000_000n],
  ['tiny-reserves', 1n, 1n, 1n],
  ['dust-asymmetric', 1n, max112, 1n],
  ['large-asymmetric', max112 / 13n, 19n, max112],
  ['max-reserves', max112, max112, max112],
  ['large-input', max112, 1n, max112],
  ['six-to-eighteen-scale', 1_000_000n, 1_000_000_000n, 1_000n * 10n ** 18n],
];
// Reproducible synthetic uint112 reserves; the seed and recurrence are recorded below.
let state = 0x5eed2026n;
function next() { state = (state * 6364136223846793005n + 1442695040888963407n) & ((1n << 128n) - 1n); return state; }
for (let index = 0; index < 64; index++) vectors.push([
  `generated-${index.toString().padStart(2, '0')}`, 1n + next() % max112,
  1n + next() % max112, 1n + next() % max112,
]);
for (const decimals of [[18, 18], [6, 18], [18, 6]]) {
  const [a, b] = tokens(decimals);
  for (const [label, input, reserveA, reserveB] of vectors) {
    compare({ id: `${decimals.join('-')}/${label}/a-to-b`, input, reserveIn: reserveA, reserveOut: reserveB, tokenIn: a, tokenOut: b });
    compare({ id: `${decimals.join('-')}/${label}/b-to-a`, input, reserveIn: reserveB, reserveOut: reserveA, tokenIn: b, tokenOut: a });
  }
  for (const [label, input, reserveIn, reserveOut] of [
    ['zero-input', 0n, 100n, 100n], ['empty-input-reserve', 1n, 0n, 100n],
    ['empty-output-reserve', 1n, 100n, 0n], ['both-empty', 1n, 0n, 0n],
  ]) compare({ id: `${decimals.join('-')}/${label}`, category: 'invalid-domain', input, reserveIn, reserveOut, tokenIn: a, tokenOut: b, rejection: true });
}

const routes = [];
for (const decimals of [[6, 18, 6], [18, 6, 18]]) {
  const routeTokens = tokens(decimals);
  for (const reverse of [false, true]) {
    const [a, b, c] = reverse ? [...routeTokens].reverse() : routeTokens;
    for (const [label, input, reserveA, reserveB] of vectors) {
      const id = `route/${decimals.join('-')}/${reverse ? 'reverse' : 'forward'}/${label}`;
      const first = compare({ id: `${id}/hop-1`, category: 'two-hop', input, reserveIn: reserveA, reserveOut: reserveB, tokenIn: a, tokenOut: b });
      if (first.classification === 'expected-semantic-difference') {
        routes.push({ id, classification: 'expected-semantic-difference', hopIds: [first.id], explanation: 'First hop rounds to zero; SDK rejects and no second quote is attempted.' });
        continue;
      }
      if (first.classification !== 'matching-output') {
        routes.push({ id, classification: 'unexpected-mismatch', hopIds: [first.id] });
        continue;
      }
      // Both implementations independently produced the same intermediate atomic amount.
      const second = compare({ id: `${id}/hop-2`, category: 'two-hop', input: BigInt(first.lxr.raw),
        reserveIn: reserveB, reserveOut: reserveA, tokenIn: b, tokenOut: c });
      routes.push({ id, classification: second.classification, hopIds: [first.id, second.id],
        lxrFinal: second.lxr, sdkFinal: second.sdk });
    }
  }
}
const countBy = records => records.reduce((counts, row) => {
  counts[row.classification] = (counts[row.classification] ?? 0) + 1; return counts;
}, {});
const unexpected = rows.filter(row => row.classification === 'unexpected-mismatch');
const versionMatches = reference.version === targetVersion;
const report = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), runtime: { node: process.version, platform: process.platform, architecture: process.arch },
  observationType: 'ordinary offline runtime harness; not REA static Evidence',
  reference: { ...reference, requestedVersion: targetVersion, versionMatches, core },
  scope: { subject: 'packages/lxr/index.mjs amountOut', feeBps: 30, sdkCalculateFotFees: false,
    arithmetic: 'integer raw token atomic amounts', reserves: 'positive synthetic uint112, except explicit invalid-domain cases',
    orientations: [[18, 18], [6, 18], [18, 6]], directions: 'both', twoHop: 'sequential independent pools with both directions and 6/18/6 plus 18/6/18 decimals',
    network: 'none; no RPC, wallet, or external network requests' },
  limitations: ['Finite deterministic synthetic cases do not prove equivalence for all inputs.',
    'No fee-on-transfer, rebasing, dynamic fees, token contracts, RPC snapshots, router execution, gas, profitability, or live-chain behavior is evaluated.',
    'Only the standard 0.3% fee is compared; configurable LXR fees are outside this comparison.',
    'Rejections are compared by rejection behavior, not by exact error class.',
    'Dust rejections are reported as expected semantic differences, not matching outputs.'],
  reproduction: { command: 'node tools/rea/compare-v2.mjs', fixtureVectors: vectors.length, generatedVectors: 64,
    seed: '0x5eed2026', recurrence: 'state=(state*6364136223846793005+1442695040888963407) mod 2^128; value=1+state mod (2^112-1)',
    referenceInstallation: 'Exact SDK installed separately under tools/rea/reference; harness does not install packages.' },
  summary: { status: versionMatches && unexpected.length === 0 ? 'completed-with-no-unexpected-mismatches' : 'failed',
    quoteCases: rows.length, quoteClassifications: countBy(rows), routes: routes.length, routeClassifications: countBy(routes), unexpectedMismatches: unexpected.length },
  cases: rows, routes,
};
const output = resolve(root, 'outputs/REA-Uniswap-V2/comparison.json');
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(report, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`);
console.log(JSON.stringify({ output, referenceVersion: reference.version, ...report.summary }, null, 2));
if (!versionMatches || unexpected.length) process.exitCode = 1;
