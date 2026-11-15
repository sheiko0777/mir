// Read-only catalogue of MIR service reports written by the Python workers in
// services/. Validation mirrors services/common/report.py; the two share
// test/fixtures/service-reports.json so they cannot drift apart silently.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

const SERVICE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const STATUSES = ['ok', 'incomplete', 'source-unavailable'];
const PROVENANCE = ['CHAIN_OBSERVED', 'PINNED_FIXTURE', 'FORK_SIMULATED', 'ASSUMED_INPUT'];
const MAX_STALE_SECONDS = 30 * 86400;
const MAX_REPORT_BYTES = 4 * 1024 * 1024;
const FUTURE_TOLERANCE_MS = 300_000;

export function parseTimestamp(value) {
  const match = typeof value === 'string' ? TIMESTAMP.exec(value) : null;
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const ms = Date.UTC(year, month - 1, day, hour, minute, second);
  const date = new Date(ms);
  // Reject dates Date.UTC would silently roll over, such as month 13.
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
    && date.getUTCHours() === hour && date.getUTCMinutes() === minute && date.getUTCSeconds() === second ? ms : null;
}

export function validateServiceReport(report) {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return ['report is not an object'];
  const errors = [];
  if (report.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof report.service !== 'string' || !SERVICE_ID.test(report.service)) errors.push('invalid service id');
  if (typeof report.title !== 'string' || !report.title.trim() || report.title.length > 120) errors.push('invalid title');
  if (!STATUSES.includes(report.status)) errors.push('invalid status');
  if (!PROVENANCE.includes(report.provenance)) errors.push('invalid provenance');
  if (parseTimestamp(report.generatedAt) === null) errors.push('invalid generatedAt');
  if (!Number.isInteger(report.staleAfterSeconds) || report.staleAfterSeconds < 1
    || report.staleAfterSeconds > MAX_STALE_SECONDS) errors.push('invalid staleAfterSeconds');
  if (report.executionEnabled !== false) errors.push('executionEnabled must be false');
  const summary = report.summary;
  if (summary === null || typeof summary !== 'object' || Array.isArray(summary)
    || Object.values(summary).some(value => value !== null && typeof value === 'object')) errors.push('invalid summary');
  if (!Array.isArray(report.caveats) || report.caveats.some(item => typeof item !== 'string')) errors.push('invalid caveats');
  if (report.data === null || typeof report.data !== 'object' || Array.isArray(report.data)) errors.push('invalid data');
  return errors;
}

function freshness(report, nowMs) {
  const generated = parseTimestamp(report.generatedAt);
  const ageSeconds = Math.floor((nowMs - generated) / 1000);
  const stale = generated > nowMs + FUTURE_TOLERANCE_MS || ageSeconds > report.staleAfterSeconds;
  return { ageSeconds, freshness: stale ? 'stale' : 'fresh' };
}

async function readReport(file, expectedService) {
  const raw = await readFile(file);
  if (raw.length > MAX_REPORT_BYTES) throw new Error('report too large');
  const report = JSON.parse(raw.toString('utf8'));
  if (validateServiceReport(report).length) throw new Error('report failed validation');
  if (report.service !== expectedService) throw new Error('service id does not match its directory');
  return report;
}

async function readOptional(file, expectedService) {
  try { return { report: await readReport(file, expectedService) }; }
  catch (error) { return error.code === 'ENOENT' ? {} : { invalid: true }; }
}

function describe(id, latest, attempt, nowMs) {
  if (latest.invalid) {
    return { id, available: false, status: 'invalid', freshness: 'unavailable', executionEnabled: false,
      error: 'Saved service report could not be validated. No sample data substituted.' };
  }
  const entry = { id, executionEnabled: false };
  if (latest.report) {
    const { title, status, provenance, generatedAt, staleAfterSeconds, summary, caveats } = latest.report;
    Object.assign(entry, { available: true, title, status, provenance, generatedAt, staleAfterSeconds,
      summary, caveats, ...freshness(latest.report, nowMs) });
  } else {
    Object.assign(entry, { available: false, status: 'no-report', freshness: 'unavailable' });
  }
  if (attempt.report) {
    const newer = !latest.report
      || parseTimestamp(attempt.report.generatedAt) > parseTimestamp(latest.report.generatedAt);
    // Only a failed attempt that is newer than the data matters to a reader.
    if (newer) entry.lastAttempt = { status: attempt.report.status, generatedAt: attempt.report.generatedAt };
  }
  return entry;
}

async function serviceIds(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter(item => item.isDirectory() && SERVICE_ID.test(item.name)).map(item => item.name).sort();
}

export async function loadServices(directory, nowMs = Date.now()) {
  const services = [];
  for (const id of await serviceIds(directory)) {
    const [latest, attempt] = await Promise.all([
      readOptional(path.join(directory, id, 'latest.json'), id),
      readOptional(path.join(directory, id, 'last-attempt.json'), id)
    ]);
    if (!latest.report && !latest.invalid && !attempt.report) continue;
    services.push(describe(id, latest, attempt, nowMs));
  }
  return { available: true, executionEnabled: false, services };
}

export async function loadService(directory, id, nowMs = Date.now()) {
  if (!SERVICE_ID.test(id)) { const error = new Error('unknown service'); error.code = 'ENOENT'; throw error; }
  const report = await readReport(path.join(directory, id, 'latest.json'), id);
  return { available: true, executionEnabled: false, ...freshness(report, nowMs), report };
}
