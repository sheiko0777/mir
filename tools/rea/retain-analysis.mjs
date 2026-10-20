import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Retain complete CLI Evidence from the tool's untruncated archive, not its preview.
const source = process.argv[2];
if (!source) throw new Error('Supply the exact archive path returned by the analysis tool.');
if ((await stat(source)).size > 256 * 1024 * 1024) throw new Error('Archive exceeds retention budget.');
const raw = await readFile(source, 'utf8');
const records = [];
for (let cursor = 0; cursor < raw.length;) {
const start = raw.indexOf('{', cursor);
let depth = 0, quoted = false, escaped = false, end = -1;
for (let i = start; i >= 0 && i < raw.length; i++) {
  const c = raw[i];
  if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; continue; }
  if (c === '"') quoted = true;
  else if (c === '{' || c === '[') depth++;
  else if (c === '}' || c === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
}
if (start < 0) break;
if (end < 0) throw new Error('Incomplete JSON in source archive; do not treat a preview as complete Evidence.');
try { records.push(JSON.parse(raw.slice(start, end))); } catch {}
cursor = end;
}
const candidates = records.filter(record => !record.rea_progress &&
  ('normalized_result' in record || 'evidence_id' in record || 'operation' in record || 'error' in record));
if (candidates.length !== 1) throw new Error(`Expected one complete Evidence or error record, found ${candidates.length}. Inspect the archive schema.`);
const evidence = candidates[0];
const root = fileURLToPath(new URL('../../', import.meta.url));
const out = resolve(root, 'outputs/REA-Uniswap-V2');
await mkdir(out, { recursive: true });
const canonical = JSON.stringify(evidence, null, 2) + '\n';
await writeFile(resolve(out, 'rea-evidence.json'), canonical);
const identity = {
  sourceArchive: source, sourceArchiveSha256: createHash('sha256').update(raw).digest('hex'),
  retainedJsonSha256: createHash('sha256').update(canonical).digest('hex'),
  retainedBytes: Buffer.byteLength(canonical), rootKeys: Object.keys(evidence),
};
await writeFile(resolve(out, 'rea-retention.json'), JSON.stringify(identity, null, 2) + '\n');
console.log(JSON.stringify(identity));
