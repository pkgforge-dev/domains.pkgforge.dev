// scripts/ingest/adopt.mjs (DOM-029, design D22 and section 6.4): the
// proposal of a day's two segments that a run pushed and no state took, built
// from their manifests alone, and the proposal of a gap day; each run through
// advance of @domains/state, as the push job of ingest-thc.yml runs it. The
// manifests are the ones run.mjs writes for the synthetic answers of
// adapters/thc-ct/fixtures/ (the slice of 2026-10-31), with --no-push.
//
//   node scripts/test.mjs scripts/ingest --name adopt
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { advance, emptyState, encodeProposal, parseProposal } from '@domains/state';
import { ROOT } from '../files.mjs';
import { Fault } from '../root/lib.mjs';
import { DEFAULT_SOURCES, loadRegistry } from '../verify-pack.mjs';
import { adoptProposal, gapProposal } from './adopt.mjs';
import { call, inTmp, PSL_FILE, stateFile } from './fixture.mjs';
import { main as runMain } from './run.mjs';

const FIXTURES = join(ROOT, 'adapters', 'thc-ct', 'fixtures');
const META = JSON.parse(readFileSync(join(FIXTURES, 'recorded.json'), 'utf8'));
const DAY = META.day;
const TAG = `thc-ct.${DAY.replaceAll('-', '')}.${META.slice.gzip_sha256.slice(0, 12)}`;
const ROWS = loadRegistry(DEFAULT_SOURCES).filter((r) => r.adapter === 'thc-ct');
const CURSOR = { next: '2026-11-01', open: [] };
const STATE = { ...emptyState('2026-11-01T01:00:00Z'), cursors: { 'thc-ct': CURSOR }, moved: { 'thc-ct': { at: '2026-11-01T01:00:00Z', run: '41000000001' } } };
const NOW = '2026-11-02T05:00:00Z';
const CTX = { run: '41000000009', attempt: 1, at: NOW };
const sha = (text) => `sha256:${createHash('sha256').update(text).digest('hex')}`;

// The two manifests run.mjs writes for the day, as { tag, digest, json }.
async function dayManifests(tmp) {
  const out = join(tmp, 'out');
  const r = await call(
    runMain,
    ['--adapter', 'thc-ct', '--out', out, '--recordings', FIXTURES, '--psl', PSL_FILE, '--now', '2026-11-01T00:30:00Z', '--run', '41000000002', '--no-push', '--state', join(tmp, 'state.json')],
    {
      env: {},
    },
  );
  assert.equal(r.code, 0, r.text);
  return [TAG, `${TAG}-d`].map((tag) => {
    const text = readFileSync(join(out, 'work', 'thc-ct', tag, 'manifest.json'), 'utf8');
    return { tag, digest: sha(text), json: JSON.parse(text) };
  });
}

async function withManifests(fn) {
  await inTmp(async (tmp) => {
    // The run reads the day before its now: the cursor of the live run that read 2026-10-31.
    stateFile(tmp, { ...STATE, cursors: { 'thc-ct': { next: DAY, open: [] } } });
    await fn(await dayManifests(tmp));
  });
}

const withAnnotation = (m, key, value) => {
  const annotations = { ...m.json.annotations };
  if (value === undefined) delete annotations[key];
  else annotations[key] = value;
  return { ...m, json: { ...m.json, annotations } };
};

test('adopt: the two manifests of a day give one proposal that keeps the live cursor, names both segments by digest, and carries the day once with the raw file size; advance accepts it and owes both', () =>
  withManifests(async (manifests) => {
    const p = adoptProposal({ adapter: 'thc-ct', rows: ROWS, manifests, state: STATE, ...CTX });
    assert.deepEqual([p.adapter, p.lane, p.run, p.attempt, p.at, p.before, p.after], ['thc-ct', null, CTX.run, 1, NOW, CURSOR, CURSOR]);
    assert.deepEqual(
      p.segments.map((s) => [s.ref, s.digest, s.source, s.dataset, s.start, s.end, s.quarantined]),
      manifests.map((m, i) => [`obs:${m.tag}`, m.digest, 'thc-ct', ['names', 'domains'][i], `${DAY}T00:00:00Z`, '2026-11-01T00:00:00Z', false]),
    );
    assert.deepEqual(
      p.segments.map((s) => s.count),
      manifests.map((m) => Number(m.json.annotations['dev.pkgforge.domains.count'])),
    );
    assert.deepEqual(p.raw, []);
    // The band of thc-ct measures the file's bytes: the raw layer's size, the gzip as fetched.
    assert.deepEqual(p.history, [{ source: 'thc-ct', day: DAY, count: META.slice.gzip_bytes, quarantined: false }]);
    assert.equal(p.gaps, undefined);
    assert.deepEqual(parseProposal(encodeProposal(p)), p, 'the proposal round-trips its file');

    const digests = new Map(manifests.map((m) => [`obs:${m.tag}`, m.digest]));
    const next = advance(STATE, [p], (ref) => digests.get(ref) ?? null, { now: NOW, run: '41000000010' });
    assert.deepEqual(next.dropped, []);
    assert.equal(next.accepted.length, 1);
    assert.deepEqual(next.state.cursors, { 'thc-ct': CURSOR }, 'the cursor stays');
    assert.deepEqual(
      next.state.owed.map((o) => [o.ref, o.digest, o.tier, o.since]),
      manifests.map((m) => [`obs:${m.tag}`, m.digest, 'seg', NOW]),
    );
    assert.deepEqual(next.state.history['thc-ct'], [{ day: DAY, count: META.slice.gzip_bytes, quarantined: false }]);
    // A tag that holds another digest drops it, as a leg's proposal.
    const moved = advance(STATE, [p], (ref) => (ref.endsWith('-d') ? `sha256:${'e'.repeat(64)}` : digests.get(ref)), { now: NOW, run: '41000000010' });
    assert.deepEqual(
      moved.dropped.map((x) => x.code),
      ['digest'],
    );
  }));

test('adopt: a quarantined pair (dev.pkgforge.domains.quarantine=1) is adopted marked, its history day quarantined, and owed like any other (D7)', () =>
  withManifests(async (manifests) => {
    const marked = manifests.map((m) => withAnnotation(m, 'dev.pkgforge.domains.quarantine', '1'));
    const p = adoptProposal({ adapter: 'thc-ct', rows: ROWS, manifests: marked, state: STATE, ...CTX });
    assert.deepEqual(
      p.segments.map((s) => s.quarantined),
      [true, true],
    );
    assert.deepEqual(p.history, [{ source: 'thc-ct', day: DAY, count: META.slice.gzip_bytes, quarantined: true }]);
    const next = advance(STATE, [p], (ref) => marked.find((m) => `obs:${m.tag}` === ref)?.digest ?? null, { now: NOW, run: '41000000010' });
    assert.equal(next.state.owed.length, 2);
    // Only the names segment marked: its verdict is the day's, so the history day is quarantined.
    const one = adoptProposal({ adapter: 'thc-ct', rows: ROWS, manifests: [marked[0], manifests[1]], state: STATE, ...CTX });
    assert.equal(one.history[0].quarantined, true);
  }));

test('adopt: a manifest that is not a segment of the adapter, a mark other than 1, a missing raw layer, two files of one day, or another dataset or precision is refused naming the tag', () =>
  withManifests(async (manifests) => {
    const [names, domains] = manifests;
    const refuse = (list, re) =>
      assert.throws(
        () => adoptProposal({ adapter: 'thc-ct', rows: ROWS, manifests: list, state: STATE, ...CTX }),
        (e) => e instanceof Fault && re.test(e.message),
      );
    refuse(
      [{ ...names, json: { ...names.json, artifactType: 'application/vnd.pkgforge.domains.pack.v1' } }, domains],
      /adopt obs:thc-ct\.20261031\.[0-9a-f]{12}: is .*, not application\/vnd\.pkgforge\.domains\.segment/,
    );
    refuse([withAnnotation(names, 'dev.pkgforge.domains.quarantine', 'yes'), domains], /quarantine="yes"; a quarantined segment is pushed with "1"/);
    refuse([withAnnotation(names, 'dev.pkgforge.domains.quarantine', 'true'), domains], /no other value is read/);
    refuse([withAnnotation(names, 'dev.pkgforge.domains.source', 'oi-nrd'), domains], /is of "oi-nrd", which is not a source of the adapter \(thc-ct\)/);
    refuse([withAnnotation(names, 'dev.pkgforge.domains.tier', 'd'), domains], /has the tier d, not seg/);
    refuse([withAnnotation(names, 'dev.pkgforge.domains.precision', 'second'), domains], /has the precision second, and thc-ct is of precision day/);
    refuse([withAnnotation(names, 'dev.pkgforge.domains.dataset', 'feed'), domains], /holds feed, which thc-ct does not write/);
    refuse([withAnnotation(names, 'dev.pkgforge.domains.count', '1e3'), domains], /has the count "1e3", not a whole number/);
    refuse([withAnnotation(names, 'dev.pkgforge.domains.span.end', undefined), domains], /has no annotation dev\.pkgforge\.domains\.span\.end/);
    const noRaw = { ...names, json: { ...names.json, layers: names.json.layers.filter((l) => l.annotations['org.opencontainers.image.title'] !== 'raw') } };
    refuse([noRaw, domains], /carries no layer raw, and the band of thc-ct measures the file's bytes/);
    const otherFile = {
      ...domains,
      json: {
        ...domains.json,
        layers: domains.json.layers.map((l) => (l.annotations['org.opencontainers.image.title'] === 'raw' ? { ...l, digest: `sha256:${'f'.repeat(64)}` } : l)),
      },
    };
    refuse([names, otherFile], /two files of one day are not adopted together/);
    refuse([], /no manifest to adopt/);
    // A tag that is not the segment's own is refused by propose (segmentTagProblem of @domains/ghcr).
    refuse([{ ...names, tag: TAG.replace('20261031', '20261030') }, domains], /adopt thc-ct: proposal: segments\[0\]\.ref/);
  }));

test('adopt: a gap proposal keeps the live cursor and names the day alone; advance accepts it beside an adopted day and holds the day pending in gaps', () =>
  withManifests(async (manifests) => {
    const gap = gapProposal({ adapter: 'thc-ct', gaps: [{ source: 'thc-ct', day: '2026-10-04' }], state: STATE, ...CTX });
    assert.deepEqual([gap.before, gap.after, gap.segments, gap.raw, gap.history, gap.gaps], [CURSOR, CURSOR, [], [], [], [{ source: 'thc-ct', day: '2026-10-04' }]]);
    const adopt = adoptProposal({ adapter: 'thc-ct', rows: ROWS, manifests, state: STATE, ...CTX });
    const digests = new Map(manifests.map((m) => [`obs:${m.tag}`, m.digest]));
    // Two keeping proposals of one adapter in one push (D13 of DOM-029).
    const next = advance(STATE, [gap, adopt], (ref) => digests.get(ref) ?? null, { now: NOW, run: '41000000010' });
    assert.deepEqual(next.dropped, []);
    assert.equal(next.accepted.length, 2);
    assert.deepEqual(next.state.gaps, { 'thc-ct': ['2026-10-04'] });
    assert.equal(next.state.owed.length, 2);
    assert.throws(
      () => gapProposal({ adapter: 'thc-ct', gaps: [], state: STATE, ...CTX }),
      (e) => e instanceof Fault && /no day to declare/.test(e.message),
    );
    // A day after the day of at is refused by the proposal's own rule.
    assert.throws(
      () => gapProposal({ adapter: 'thc-ct', gaps: [{ source: 'thc-ct', day: '2026-11-03' }], state: STATE, ...CTX }),
      (e) => e instanceof Fault && /after the day of at/.test(e.message),
    );
    // With no live cursor, before and after are both null.
    const first = gapProposal({ adapter: 'thc-ct', gaps: [{ source: 'thc-ct', day: '2026-10-04' }], state: emptyState(NOW), ...CTX });
    assert.deepEqual([first.before, first.after], [null, null]);
  }));
