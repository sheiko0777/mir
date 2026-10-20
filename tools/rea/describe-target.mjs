import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve, relative, sep } from 'node:path';

const root = fileURLToPath(new URL('../../', import.meta.url));
const reference = resolve(root, 'tools/rea/reference');
const target = resolve(reference, 'node_modules/@uniswap/v2-sdk');
const out = resolve(root, 'outputs/REA-Uniswap-V2');
const metadata = JSON.parse(await readFile(resolve(target, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(resolve(reference, 'package-lock.json'), 'utf8'));
const expectedIntegrity = 'sha512-vhGJ8vHRMKxuolR47RXOF9DXARUxNujVQg+kSwu+an5YiTwNBlyCp7ewkJvFLPVeE3UFvYt11NguQuf+vE0wNg==';
if (metadata.version !== '4.21.5' || lock.packages['node_modules/@uniswap/v2-sdk']?.integrity !== expectedIntegrity) throw new Error('Unexpected reference version/integrity');
const files = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error('Unexpected symbolic link in selected package');
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) {
      const bytes = await readFile(path);
      files.push({ path: relative(target, path).split(sep).join('/'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
    }
  }
}
await walk(target); files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
const license = await readFile(resolve(target, 'LICENSE'), 'utf8');
const dependencies = [];
for (const [path, record] of Object.entries(lock.packages)) {
  if (!path) continue;
  const directory = resolve(reference, path);
  if (!directory.startsWith(reference + sep)) throw new Error('Invalid lockfile location');
  const pkg = JSON.parse(await readFile(resolve(directory, 'package.json'), 'utf8'));
  dependencies.push({ name: pkg.name, version: pkg.version, declaredLicense: pkg.license ?? null, integrity: record.integrity ?? null });
}
const report = {
  generatedAt: new Date().toISOString(), observationType: 'ordinary package-file inspection; not REA static Evidence',
  target: { name: metadata.name, version: metadata.version, path: target, registryIntegrity: expectedIntegrity, repository: metadata.repository, exports: metadata.exports },
  license: { declared: metadata.license, fullTextInspected: true, file: 'UNISWAP-V2-SDK-LICENSE.txt', copyright: 'Copyright (c) 2021 Uniswap Labs',
    noticeRequirement: 'Retain copyright and permission notice with copies or substantial portions; dependencies have separate notices.',
    scope: 'Inspection/reference use only in MIR. No upstream implementation was copied into production LXR.' },
  installedDependencyMetadata: dependencies,
  dependencyLicenseLimit: 'Declared metadata is inventoried; this is not a completed review of every transitive license text.',
  inventoryAlgorithm: 'SHA-256 per distributed file; symlinks rejected. This inventory is independent of REA artifact identity.', files,
};
await mkdir(out, { recursive: true });
await writeFile(resolve(out, 'UNISWAP-V2-SDK-LICENSE.txt'), license);
await writeFile(resolve(out, 'target-manifest.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ version: metadata.version, declaredLicense: metadata.license, distributedFiles: files.length, dependencyPackages: dependencies.length, integrityMatches: true }));
