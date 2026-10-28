// The log list rows of DOM-011 (scripts/measure/ct-logs.mjs), on a synthetic
// list in the v3 shape (fixtures/tiles/fake-log.mjs fakeList).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fetchLogList, LOG_LIST_URL, logRows, shortName, tiledByName } from './ct-logs.mjs';
import { createClient, CtError } from './ct-tiles.mjs';
import { fakeFetch, fakeList } from './fixtures/tiles/fake-log.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'ct-logs.mjs');

const LIST = fakeList({
  logs: [
    ["Let's Encrypt", "Let's Encrypt Sycamore2026h2", 'usable', 'https://mon.sycamore.test/2026h2/'],
    ['Geomys', 'Geomys Tuscolo2027h1', 'usable', 'https://tuscolo2027h1.test/'],
    ['IPng Networks', 'IPng Networks Halloumi2026h2a', 'qualified', 'https://halloumi2026h2a.test/'],
  ],
  rfc6962: [['Google', 'Google Argon2026h2', 'usable', 'https://argon.test/2026h2/']],
});

test('ct logs: the list becomes rows with operator, kind, state, URL and a short name', () => {
  const rows = logRows(LIST);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0], {
    op: "Let's Encrypt",
    desc: "Let's Encrypt Sycamore2026h2",
    kind: 'tiled',
    state: 'usable',
    mon: 'https://mon.sycamore.test/2026h2/',
    url: null,
    name: 'sycamore2026h2',
    interval: null,
  });
  assert.equal(rows.find((r) => r.kind === 'rfc6962').url, 'https://argon.test/2026h2/');
  assert.equal(tiledByName(rows, 'halloumi2026h2a').state, 'qualified');
  assert.throws(() => tiledByName(rows, 'argon2026h2'), /no tiled log is named argon2026h2/);
  assert.equal(shortName('IPng Networks Halloumi2026h2a'), 'halloumi2026h2a');
});

test('ct logs: a list of another shape is refused rather than read in part', () => {
  assert.throws(() => logRows({}), /no operators array/);
  const twoStates = structuredClone(LIST);
  twoStates.operators[0].tiled_logs[0].state = { usable: {}, retired: {} };
  assert.throws(() => logRows(twoStates), /holds 2 keys, not one/);
  const http = structuredClone(LIST);
  http.operators[1].tiled_logs[0].monitoring_url = 'http://tuscolo2027h1.test/';
  assert.throws(() => logRows(http), /not an https URL/);
  const twice = structuredClone(LIST);
  twice.operators[1].tiled_logs.push({ ...twice.operators[1].tiled_logs[0] });
  assert.throws(() => logRows(twice), /two tiled logs are named tuscolo2027h1/);
  assert.throws(() => shortName('Log ?'), CtError);
});

test('ct logs: the fetched list carries its sha256, timestamp and version; a failed fetch is a CtError', async () => {
  const body = JSON.stringify(LIST);
  const ok = await fetchLogList(createClient({ fetchFn: fakeFetch({ [LOG_LIST_URL]: () => new Response(body) }) }));
  assert.equal(ok.timestamp, '2026-10-28T13:37:58Z');
  assert.equal(ok.version, '0.synthetic');
  assert.match(ok.sha256, /^[0-9a-f]{64}$/);
  assert.equal(ok.obs.bytes, Buffer.byteLength(body));
  await assert.rejects(fetchLogList(createClient({ fetchFn: fakeFetch({ [LOG_LIST_URL]: () => new Response('', { status: 503 }) }) })), /answered 503/);
  await assert.rejects(fetchLogList(createClient({ fetchFn: fakeFetch({ [LOG_LIST_URL]: () => new Response('<html>') }) })), /not JSON/);
});

test('ct logs: the command line writes the rows of a list file; no --out is a usage error', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'ct-logs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'list.json'), JSON.stringify(LIST));
  const r = spawnSync(process.execPath, [SCRIPT, '--in', join(dir, 'list.json'), '--out', join(dir, 'rows.json')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(readFileSync(join(dir, 'rows.json'), 'utf8')).length, 4);
  assert.match(r.stdout, /"tiled usable":2/);
  const bad = spawnSync(process.execPath, [SCRIPT, '--in', join(dir, 'list.json')], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});
