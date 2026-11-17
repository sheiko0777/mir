import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateServiceReport, parseTimestamp, loadServices, loadService } from '../apps/server/services.mjs';
import { createMirServer } from '../apps/server/server.mjs';

const fixtures = JSON.parse(await readFile(new URL('./fixtures/service-reports.json', import.meta.url), 'utf8'));
const NOW = Date.UTC(2026, 10, 15, 12, 30, 0);

function report(overrides = {}) { return { ...structuredClone(fixtures.valid[0]), ...overrides }; }

async function withServices(layout, run) {
  const root = await mkdtemp(join(tmpdir(), 'mir-services-'));
  try {
    for (const [file, content] of Object.entries(layout)) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), typeof content === 'string' ? content : JSON.stringify(content));
    }
    return await run(root);
  } finally { await rm(root, { recursive: true, force: true }); }
}

test('service report validation agrees with the shared fixtures', () => {
  for (const valid of fixtures.valid) assert.deepEqual(validateServiceReport(valid), []);
  for (const { reason, report: invalid } of fixtures.invalid) {
    assert.notEqual(validateServiceReport(invalid).length, 0, reason);
  }
  assert.notEqual(validateServiceReport(null).length, 0);
  assert.notEqual(validateServiceReport([]).length, 0);
  assert.equal(parseTimestamp('2026-02-30T00:00:00Z'), null);
});

test('service catalogue reports freshness and never substitutes data', async () => {
  await withServices({
    'fresh-one/latest.json': report({ service: 'fresh-one' }),
    'old-one/latest.json': report({ service: 'old-one', generatedAt: '2026-11-14T00:00:00Z' }),
    'future-one/latest.json': report({ service: 'future-one', generatedAt: '2026-11-16T00:00:00Z' }),
    'broken-one/latest.json': '{not json',
    'renamed/latest.json': report({ service: 'someone-else' }),
    'enabled/latest.json': report({ service: 'enabled', executionEnabled: true }),
    'empty-dir/notes.txt': 'ignored',
    'Bad_Name/latest.json': report({ service: 'fresh-one' })
  }, async root => {
    const result = await loadServices(root, NOW);
    assert.equal(result.executionEnabled, false);
    const byId = Object.fromEntries(result.services.map(item => [item.id, item]));
    assert.deepEqual(Object.keys(byId).sort(), ['broken-one', 'enabled', 'fresh-one', 'future-one', 'old-one', 'renamed']);
    assert.equal(byId['fresh-one'].freshness, 'fresh');
    assert.equal(byId['fresh-one'].ageSeconds, 1800);
    assert.equal(byId['fresh-one'].provenance, 'PINNED_FIXTURE');
    assert.equal('data' in byId['fresh-one'], false);
    assert.equal(byId['old-one'].freshness, 'stale');
    assert.equal(byId['future-one'].freshness, 'stale');
    for (const id of ['broken-one', 'renamed', 'enabled']) {
      assert.equal(byId[id].available, false);
      assert.equal(byId[id].status, 'invalid');
      assert.equal('summary' in byId[id], false);
    }
  });
});

test('a newer failed attempt is shown beside the last good report', async () => {
  const failed = report({ service: 'watch', status: 'source-unavailable', generatedAt: '2026-11-15T12:20:00Z', data: {} });
  await withServices({
    'watch/latest.json': report({ service: 'watch' }),
    'watch/last-attempt.json': failed,
    'older/latest.json': report({ service: 'older' }),
    'older/last-attempt.json': report({ service: 'older', status: 'source-unavailable', generatedAt: '2026-11-15T11:00:00Z' }),
    'never/last-attempt.json': report({ service: 'never', status: 'source-unavailable' })
  }, async root => {
    const byId = Object.fromEntries((await loadServices(root, NOW)).services.map(item => [item.id, item]));
    assert.equal(byId.watch.status, 'ok');
    assert.deepEqual(byId.watch.lastAttempt, { status: 'source-unavailable', generatedAt: '2026-11-15T12:20:00Z' });
    assert.equal('lastAttempt' in byId.older, false);
    assert.equal(byId.never.available, false);
    assert.equal(byId.never.status, 'no-report');
    assert.equal(byId.never.lastAttempt.status, 'source-unavailable');
  });
});

test('missing services directory is an empty catalogue', async () => {
  assert.deepEqual((await loadServices(join(tmpdir(), 'mir-services-does-not-exist'), NOW)).services, []);
});

test('single service lookup rejects traversal and invalid reports', async () => {
  await withServices({
    'good/latest.json': report({ service: 'good' }),
    'bad/latest.json': report({ service: 'bad', provenance: 'TRUST_ME' })
  }, async root => {
    const good = await loadService(root, 'good', NOW);
    assert.equal(good.report.data.rows.length, 2);
    assert.equal(good.freshness, 'fresh');
    await assert.rejects(loadService(root, '../good', NOW), { code: 'ENOENT' });
    await assert.rejects(loadService(root, 'missing', NOW), { code: 'ENOENT' });
    await assert.rejects(loadService(root, 'bad', NOW), /validation/);
  });
});

test('services API is read-only and fails closed', async () => {
  await withServices({
    'services/good/latest.json': report({ service: 'good' }),
    'services/bad/latest.json': '{'
  }, async root => {
    const server = createMirServer({ labDirectory: join(root, 'lab'), now: () => NOW });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const list = await fetch(base + '/api/services');
      assert.equal(list.status, 200);
      const body = await list.json();
      assert.equal(body.executionEnabled, false);
      assert.deepEqual(body.services.map(item => [item.id, item.available]), [['bad', false], ['good', true]]);
      assert.equal((await fetch(base + '/api/services', { method: 'POST' })).status, 405);
      assert.equal((await fetch(base + '/api/services', { method: 'HEAD' })).status, 200);
      const one = await fetch(base + '/api/services/good');
      assert.equal(one.status, 200);
      assert.equal((await one.json()).report.service, 'good');
      assert.equal((await fetch(base + '/api/services/missing')).status, 404);
      const broken = await fetch(base + '/api/services/bad');
      assert.equal(broken.status, 503);
      assert.equal((await broken.json()).available, false);
      assert.equal((await fetch(base + '/api/services/..%2Fgood')).status, 404);
      assert.equal((await fetch(base + '/api/services/good/latest.json')).status, 404);
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
