import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { parse } from 'yaml';
import { datedUrl } from '../../adapters/isc-new/src/index.ts';
import { checkText } from '../check-workflows.mjs';
import { ROOT } from '../files.mjs';
import { CREATED, TITLE } from '../ghcr/push.mjs';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { call, copied, inRegistry } from './fixture.mjs';
import { archiveTag, EXIT, FIRST_DAY, LAST_DAY, main, MAX_DAYS } from './isc-archive.mjs';

const SECOND_DAY = '2025-10-27';
const THIRD_DAY = '2025-10-28';
const NOW = '2026-11-27T10:00:00Z';
const P = 'dev.pkgforge.domains.';
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const gzip = (day, domainname = 'a.example.org') => gzipSync(JSON.stringify([{ domainname, firstseen: day, ip: null, score: 1, scorereason: 'example' }]));
const window = (from, to = from, ...flags) => ['--from', from, '--to', to, ...flags];

function isc(days) {
  const seen = [];
  return {
    seen,
    fetch: async (url, options) => {
      assert.equal(options.headers.get('user-agent'), USER_AGENT);
      assert.equal(options.headers.get('accept-encoding'), 'identity');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.has('if-none-match'), false);
      const day = /^https:\/\/isc\.sans\.edu\/feeds\/domaindata\.(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(url)?.[1];
      assert.ok(day, url);
      assert.ok(Object.hasOwn(days, day), `unexpected request for ${day}`);
      seen.push(day);
      const bytes = days[day];
      return bytes === null ? new Response(null, { status: 404 }) : new Response(bytes, { headers: { 'content-length': String(bytes.byteLength), 'content-type': 'application/x-gzip' } });
    },
  };
}

const run = (reg, feed, argv, now = NOW) => call(main, argv, { reg, now, extra: { fetch: feed.fetch } });

test('isc-archive: manual publication is bounded to valid inclusive pre-epoch dates before any reads', async () => {
  const feed = isc({ [LAST_DAY]: gzip(LAST_DAY) });
  const invalid = [
    ['--no-push'],
    window('2025-10-25', FIRST_DAY, '--no-push'),
    window(LAST_DAY, '2026-01-01', '--no-push'),
    window(FIRST_DAY, '2025-11-02', '--no-push'),
    window('2025-11-31', LAST_DAY, '--no-push'),
    window(SECOND_DAY, FIRST_DAY, '--no-push'),
    window(FIRST_DAY, FIRST_DAY, '--no-push', '--from', FIRST_DAY),
  ];
  for (const argv of invalid) assert.equal((await run(null, feed, argv)).code, EXIT.usage, argv.join(' '));
  const valuedSwitch = await run(null, feed, window(FIRST_DAY, FIRST_DAY, '--no-push=false'));
  assert.equal(valuedSwitch.code, EXIT.usage);
  assert.match(valuedSwitch.text, /--no-push takes no value/);
  const missingCredential = await run(null, feed, window(FIRST_DAY));
  assert.equal(missingCredential.code, EXIT.usage);
  assert.match(missingCredential.text, /publishing requires the workflow actor, run id and its own token/);
  assert.deepEqual(feed.seen, []);
  const r = await run(null, feed, window(LAST_DAY, LAST_DAY, '--no-push'));
  assert.equal(r.code, EXIT.ok, r.text);
  assert.deepEqual(feed.seen, [LAST_DAY]);
  assert.match(r.text, /verified 2025-12-31 .* 1 rows sha256:/);
  assert.equal(MAX_DAYS, 7);
  assert.equal(archiveTag(LAST_DAY), 'raw-isc-new.20251231t000000z.20260101t000000z');
});

test('isc-archive: the historical gzip, assigned calendar day, URL and original fetch time survive publishing and an unchanged retry', () =>
  inRegistry(async (reg) => {
    const bytes = gzip(FIRST_DAY);
    const feed = isc({ [FIRST_DAY]: bytes, [SECOND_DAY]: gzip(SECOND_DAY) });
    const args = window(FIRST_DAY, SECOND_DAY);
    const first = await run(reg, feed, args);
    assert.equal(first.code, EXIT.ok, first.text);
    assert.deepEqual(feed.seen, [FIRST_DAY, SECOND_DAY]);
    assert.deepEqual(copied(reg), [archiveTag(FIRST_DAY), archiveTag(SECOND_DAY)]);
    assert.equal(first.out.filter((l) => l.startsWith('public obs:')).length, 2, first.text);

    const key = `obs:${archiveTag(FIRST_DAY)}`;
    const original = reg.w.manifests.get(key);
    const m = JSON.parse(original);
    const rawHash = digest(bytes);
    assert.equal(m.artifactType, 'application/vnd.pkgforge.domains.raw.v1');
    assert.deepEqual(
      m.layers.map((l) => l.annotations[TITLE]),
      ['raw.000', 'members.json'],
    );
    assert.equal(m.layers[0].digest, rawHash);
    assert.equal(m.layers[0].size, bytes.length);
    assert.deepEqual(Buffer.from(reg.bytes.get(rawHash)), bytes);
    assert.equal(m.annotations[CREATED], `${SECOND_DAY}T00:00:00Z`);
    assert.equal(m.annotations[`${P}span.start`], `${FIRST_DAY}T00:00:00Z`);
    assert.equal(m.annotations[`${P}span.end`], `${SECOND_DAY}T00:00:00Z`);
    assert.equal(m.annotations[`${P}source`], 'isc-new');
    assert.equal(m.annotations[`${P}url`], datedUrl(FIRST_DAY));
    assert.equal(m.annotations[`${P}fetched`], NOW);
    assert.deepEqual(JSON.parse(Buffer.from(reg.bytes.get(m.layers[1].digest))), {
      format: 'domains.raw-members.v1',
      source: 'isc-new',
      start: `${FIRST_DAY}T00:00:00Z`,
      end: `${SECOND_DAY}T00:00:00Z`,
      members: [{ day: FIRST_DAY, url: datedUrl(FIRST_DAY), length: bytes.length, offset: 0, sha256: rawHash.slice(7) }],
    });

    const retry = await run(reg, feed, args, '2026-11-28T10:00:00Z');
    assert.equal(retry.code, EXIT.ok, retry.text);
    assert.equal(retry.out.filter((l) => l.startsWith('present ')).length, 2, retry.text);
    assert.equal(retry.out.filter((l) => l.startsWith('public obs:')).length, 2, retry.text);
    assert.deepEqual(copied(reg), [archiveTag(FIRST_DAY), archiveTag(SECOND_DAY)]);
    assert.equal(reg.w.manifests.get(key), original);
  }));

test('isc-archive: a later window needs its predecessor and a missing day stops further fetches and writes', () =>
  inRegistry(async (reg) => {
    const feed = isc({ [FIRST_DAY]: gzip(FIRST_DAY), [SECOND_DAY]: null });
    const outOfOrder = await run(reg, feed, window(SECOND_DAY));
    assert.equal(outOfOrder.code, EXIT.fault, outOfOrder.text);
    assert.match(outOfOrder.text, /first publish and verify its predecessor 2025-10-26/);
    assert.deepEqual(feed.seen, []);
    assert.deepEqual(copied(reg), []);

    const interrupted = await run(reg, feed, window(FIRST_DAY, THIRD_DAY));
    assert.equal(interrupted.code, EXIT.fault, interrupted.text);
    assert.match(interrupted.text, /2025-10-27: the dated file is missing/);
    assert.deepEqual(feed.seen, [FIRST_DAY, SECOND_DAY]);
    assert.deepEqual(copied(reg), [archiveTag(FIRST_DAY)]);

    const retry = await run(reg, isc({ [SECOND_DAY]: gzip(SECOND_DAY), [THIRD_DAY]: gzip(THIRD_DAY) }), window(SECOND_DAY, THIRD_DAY));
    assert.equal(retry.code, EXIT.ok, retry.text);
    assert.match(retry.text, /predecessor obs:raw-isc-new\.20251026t000000z\.20251027t000000z .* verified anonymously/);
    assert.deepEqual(copied(reg), [archiveTag(FIRST_DAY), archiveTag(SECOND_DAY), archiveTag(THIRD_DAY)]);
  }));

test('isc-archive: an empty, wrong-day or malformed gzip never reaches the writer', () =>
  inRegistry(async (reg) => {
    for (const [bytes, re] of [
      [gzipSync('[]'), /dated file has no rows/],
      [gzip(SECOND_DAY), /firstseen|dated file/],
      [Buffer.from('bad gzip'), /gzip/],
    ]) {
      const r = await run(reg, isc({ [FIRST_DAY]: bytes }), window(FIRST_DAY));
      assert.equal(r.code, EXIT.fault, r.text);
      assert.match(r.text, re);
      assert.deepEqual(reg.calls, []);
    }
  }));

test('isc-archive: a changed body conflicts with the immutable original and an accepted manifest must still yield the exact public blob', () =>
  inRegistry(async (reg) => {
    const original = gzip(FIRST_DAY);
    const feed = isc({ [FIRST_DAY]: original });
    const args = window(FIRST_DAY);
    const first = await run(reg, feed, args);
    assert.equal(first.code, EXIT.ok, first.text);
    const key = `obs:${archiveTag(FIRST_DAY)}`;
    const manifest = reg.w.manifests.get(key);

    const changed = await run(reg, isc({ [FIRST_DAY]: gzip(FIRST_DAY, 'b.example.org') }), args);
    assert.equal(changed.code, EXIT.fault, changed.text);
    assert.match(changed.text, /conflicts.*the archived original was kept/);
    assert.equal(reg.w.manifests.get(key), manifest);
    assert.deepEqual(copied(reg), [archiveTag(FIRST_DAY)]);

    const wrongUrl = JSON.parse(manifest);
    wrongUrl.annotations[`${P}url`] = datedUrl(SECOND_DAY);
    reg.w.manifests.set(key, JSON.stringify(wrongUrl));
    const wrongProvenance = await run(reg, feed, args);
    assert.equal(wrongProvenance.code, EXIT.fault, wrongProvenance.text);
    assert.match(wrongProvenance.text, /did not read back with the expected raw archive manifest/);
    assert.deepEqual(copied(reg), [archiveTag(FIRST_DAY)]);
    reg.w.manifests.set(key, manifest);

    const corrupt = Uint8Array.from(original);
    corrupt[corrupt.length - 1] ^= 1;
    reg.bytes.set(digest(original), corrupt);
    const retry = await run(reg, feed, args);
    assert.equal(retry.code, EXIT.fault, retry.text);
    assert.match(retry.text, /did not read back with the source gzip's SHA-256/);
    assert.ok(
      retry.out.some((l) => l.startsWith('present ')),
      retry.text,
    );
    assert.ok(!retry.out.some((l) => l.startsWith('public obs:')), retry.text);
    assert.deepEqual(copied(reg), [archiveTag(FIRST_DAY)]);
  }));

test('isc-archive workflow: only a manual main dispatch runs the serial archive and only its publish step receives the job token', () => {
  const rel = '.github/workflows/ingest-isc-archive.yml';
  const text = readFileSync(join(ROOT, rel), 'utf8');
  const wf = parse(text);
  assert.deepEqual(checkText(text, rel), []);
  assert.deepEqual(Object.keys(wf.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(wf.on.workflow_dispatch.inputs), ['from', 'to']);
  assert.deepEqual(wf.concurrency, { group: 'ingest-isc-archive', queue: 'max', 'cancel-in-progress': false });
  assert.deepEqual(Object.keys(wf.jobs), ['ingest']);
  assert.equal(wf.jobs.ingest.if, "github.ref == 'refs/heads/main'");
  assert.deepEqual(wf.jobs.ingest.permissions, { contents: 'read', packages: 'write' });
  assert.equal(wf.jobs.ingest.strategy, undefined);
  const tokenSteps = wf.jobs.ingest.steps.filter((step) => step.env?.REGISTRY_TOKEN === '${{ github.token }}');
  assert.equal(tokenSteps.length, 1);
  assert.equal(tokenSteps[0].run, 'node scripts/ingest/isc-archive.mjs --from "$FROM" --to "$TO"');
});
