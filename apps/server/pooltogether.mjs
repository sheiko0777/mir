import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, mkdir, writeFile, lstat, link, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { replayClaimCapture } from '../../packages/bots/pooltogether.mjs';

export async function saveClaimCapture(directory, capture) {
  await replayClaimCapture(capture, capture.capturedAtMs);
  const raw = JSON.stringify(capture) + '\n';
  if (Buffer.byteLength(raw) > 2 * 1024 * 1024) throw new Error('Capture storage budget exceeded');
  const id = createHash('sha256').update(raw).digest('hex');
  await mkdir(directory, { recursive: true });
  const pending = join(directory, `.${id}.${randomUUID()}.pending`), target = join(directory, id + '.json');
  try {
    await writeFile(pending, raw, { flag: 'wx' });
    try { await link(pending, target); }
    catch (error) { if (error.code !== 'EEXIST' || await readFile(target, 'utf8') !== raw) throw error; }
  } finally { await unlink(pending).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  return id;
}

export async function loadClaimBot(directory, nowMs = Date.now()) {
  let files;
  try { files = await readdir(directory); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { available: false, status: 'awaiting-data', botId: 'pooltogether-claimer', batches: [],
      qualified: false, executionEnabled: false, verifiedNetAtomic: null };
  }
  const names = files.filter(name => name.endsWith('.json'));
  if (names.length > 50) throw new Error('Claim history review budget exceeded; archive older captures explicitly');
  const captures = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new Error('Invalid claim evidence filename');
    const file = join(directory, name), info = await lstat(file);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error('Invalid claim evidence file');
    const raw = await readFile(file);
    if (createHash('sha256').update(raw).digest('hex') + '.json' !== name) throw new Error('Claim evidence hash mismatch');
    const capture = JSON.parse(raw);
    const report = await replayClaimCapture(capture, nowMs);
    captures.push({ capturedAtMs: capture.capturedAtMs, id: name.slice(0, -5), report });
  }
  if (!captures.length) return { available: false, status: 'awaiting-data', batches: [], qualified: false, executionEnabled: false };
  // Never replace a newer failed public capture with an older successful one or a demo.
  const publicCaptures = captures.filter(c => c.report.source.kind === 'public-rpc');
  const selected = (publicCaptures.length ? publicCaptures : captures).sort((a, b) => b.capturedAtMs - a.capturedAtMs || a.id.localeCompare(b.id))[0];
  return { ...selected.report, evidenceId: selected.id, capturesReviewed: captures.length };
}
