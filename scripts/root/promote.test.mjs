// scripts/root/promote.mjs against the GHCR double of scripts/root/fixture.mjs,
// which stands on packages/testkit's world: packages/ghcr's reader runs its
// production dial (the global fetch the world replaces), push.mjs runs
// in-process with the double's oras, and no test reaches the network. Each
// test also fails when a GHCR answer body was left neither read nor
// cancelled. Each refusal is planted alone, so the guard the test names is the
// only one that can catch it. Every root, pack, digest and token is synthetic.
//
//   node scripts/test.mjs scripts/root --name promote
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { artifactType, refTag, repoOf, rootTag } from '@domains/ghcr';
import { buildRoot, EMPTY_COVERAGE, layerBytes, RootError, SOURCES_LAYER_FORMAT } from '@domains/root';
import { pack as entry } from '../../packages/root/test/helpers.ts';
import { ROOT } from '../files.mjs';
import { anonymousReader } from '../ghcr/check-public.mjs';
import { depsFor, PSL_LIVE, PSL_TAG, registry, runFixture, sha } from './fixture.mjs';
import { Fault, guardLatest, readRoot } from './lib.mjs';
import { EXIT, keepLiveSet, main, parsePromoteArgs } from './promote.mjs';

const SCRIPT = fileURLToPath(new URL('./promote.mjs', import.meta.url));
// The synthetic registry of the verifier's fixtures: thc-ct (bit 0) and ct-le (bit 5).
const REG = join(ROOT, 'packages', 'pack', 'test', 'verify', 'registry.json');
const TITLE = 'org.opencontainers.image.title';

// A test in a fresh double; it fails if an answer body was left unread.
async function inRegistry(fn) {
  const reg = registry();
  const tmp = mkdtempSync(join(tmpdir(), 'root-promote-test-'));
  try {
    await fn(reg, tmp);
    assert.deepEqual(reg.w.unusedBodies(), [], 'every GHCR answer body is read or cancelled');
  } finally {
    reg.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

async function promote(reg, tmp, argv, { now, attempt = '1' }) {
  const out = [];
  const err = [];
  const code = await main(argv, depsFor(reg, { now, attempt, tmp, out: (l) => out.push(l), err: (l) => err.push(l) }));
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

// The root a tag of the double holds: { digest, root, manifest }, or null.
function rootAt(reg, ref) {
  const text = reg.w.manifests.get(`root:${ref}`);
  if (text === undefined) return null;
  const manifest = JSON.parse(text);
  const layer = (t) => JSON.parse(new TextDecoder().decode(reg.bytes.get(manifest.layers.find((l) => l.annotations[TITLE] === t).digest)));
  return { digest: sha(text), manifest, root: layer('root.json'), sources: layer('sources.json'), coverage: layer('coverage.json') };
}

const verbs = (reg) => reg.calls.map((c) => c.verb);

test('promote: the first promotion bootstraps root_seq 1 with no previous, no pack and the pinned PSL, under a dated tag, and moves latest last', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    const r = await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' });
    assert.equal(r.code, EXIT.ok, r.text);
    const latest = rootAt(reg, 'latest');
    assert.deepEqual(
      { seq: latest.root.root_seq, previous: latest.root.previous, as_of: latest.root.as_of, datasets: latest.root.datasets, psl: latest.root.psl, psl_live: latest.root.psl_live },
      { seq: 1, previous: null, as_of: null, datasets: {}, psl: PSL_LIVE, psl_live: [] },
    );
    // The dated tag is rootTag(created), and latest names the same manifest.
    assert.equal(rootAt(reg, rootTag('2026-10-29T09:00:00Z')).digest, latest.digest);
    assert.equal(latest.manifest.artifactType, artifactType('root'));
    assert.deepEqual(
      latest.manifest.layers.map((l) => l.annotations[TITLE]),
      ['root.json', 'sources.json', 'coverage.json'],
    );
    assert.equal(latest.manifest.annotations['dev.pkgforge.domains.root_seq'], '1');
    assert.equal(latest.manifest.annotations['org.opencontainers.image.created'], '2026-10-29T09:00:00Z');
    // config/sources.json holds no source yet, and no coverage table exists.
    assert.deepEqual(latest.sources, { format: SOURCES_LAYER_FORMAT, sources: [] });
    assert.deepEqual(latest.coverage, EMPTY_COVERAGE);
    // latest moves last: after the copy of the dated root, and after three
    // reads of latest with the token (the absent root of the first promotion,
    // then the guard before the push and the guard before the move).
    const v = verbs(reg);
    const tagAt = v.indexOf('tag');
    assert.ok(tagAt > v.indexOf('copy'), v.join(' '));
    assert.deepEqual(
      reg.calls
        .slice(0, tagAt)
        .flatMap((c, i) => (c.verb === 'manifest fetch' && c.args.at(-1).endsWith('root:latest') ? [i] : []))
        .map((i) => (i < v.indexOf('push') ? 'before the push' : 'after the copy')),
      ['before the push', 'before the push', 'after the copy'],
      v.join(' '),
    );
    assert.equal(v.filter((x) => x === 'tag').length, 1);
    assert.match(r.out.at(-1), /^latest ghcr\.io\/pkgforge-dev\/domains\.pkgforge\.dev\/root:latest sha256:[0-9a-f]{64} root_seq 1 as_of none \(r-20261029t090000z\), read back with no credential$/);
    // The token reached oras on stdin, in the logins alone.
    for (const c of reg.calls) assert.equal(c.input !== '', c.verb === 'login', c.verb);
  }));

test('promote: the first root needs --psl, and a psl tag whose layer is not its annotation is refused', () =>
  inRegistry(async (reg, tmp) => {
    const none = await promote(reg, tmp, [], { now: '2026-10-29T09:00:00Z' });
    assert.equal(none.code, EXIT.usage, none.text);
    assert.match(none.text, /the first root needs --psl psl-<sha12>/);
    reg.seedPsl(PSL_LIVE, 'psl-0000000000aa');
    const wrong = await promote(reg, tmp, ['--psl', 'psl-0000000000aa'], { now: '2026-10-29T09:00:00Z' });
    assert.equal(wrong.code, EXIT.fault, wrong.text);
    assert.match(wrong.text, /pins 1f96bae40adf.*, whose tag is psl-1f96bae40adf/);
    assert.equal(reg.w.manifests.has('root:latest'), false);
  }));

test('promote: a pack added to the live root is listed with its index head, under root_seq 2 with previous the live digest', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const first = rootAt(reg, 'latest');
    const p = await reg.seedPack('names', 'names-d-20261026', { tier: 'd', start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' });
    const r = await promote(reg, tmp, ['--add', p.ref, '--sources', REG, '--fetched', 'thc-ct=2026-10-27T00:20:00Z'], { now: '2026-10-29T09:10:00Z' });
    assert.equal(r.code, EXIT.ok, r.text);
    const two = rootAt(reg, 'latest');
    assert.equal(two.root.root_seq, 2);
    assert.equal(two.root.previous, first.digest);
    assert.equal(two.root.as_of, '2026-10-27T00:00:00Z');
    const [listed] = two.root.datasets.names;
    assert.equal(listed.manifest, p.digest);
    assert.deepEqual([listed.tier, listed.count, listed.key_min, listed.key_max, listed.sources, listed.psl], ['d', 3, 'com.synthetic0000', 'com.synthetic0002', ['thc-ct'], PSL_LIVE]);
    assert.deepEqual(two.root.psl_live, [PSL_LIVE]);
    assert.deepEqual(
      two.sources.sources.map((s) => [s.id, s.through, s.fetched]),
      [
        ['thc-ct', '2026-10-27T00:00:00Z', '2026-10-27T00:20:00Z'],
        ['ct-le', null, null],
      ],
    );
  }));

test("promote: a feed day pack's time copy is read by its time index head and listed as time { idx, parts }; an hour pack without one lists none", () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const day = await reg.seedPack('feed', 'feed-d-20261026', { dataset: 'feed', tier: 'd', start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z', sources: ['ct-le'], records: 5, time: true });
    const hour = await reg.seedPack('feed', 'feed-h-2026102700', { dataset: 'feed', tier: 'h', start: '2026-10-27T00:00:00Z', end: '2026-10-27T01:00:00Z', sources: ['ct-le'], records: 2 });
    const r = await promote(reg, tmp, ['--add', day.ref, '--add', hour.ref, '--sources', REG], { now: '2026-10-29T09:10:00Z' });
    assert.equal(r.code, EXIT.ok, r.text);
    const [d, h] = rootAt(reg, 'latest').root.datasets.feed;
    // The layers of the day pack's manifest, by title, as the double holds them.
    const layers = new Map(JSON.parse(reg.w.manifests.get(`feed:${day.digest}`)).layers.map((l) => [l.annotations[TITLE], { digest: l.digest, size: l.size }]));
    assert.deepEqual(d.time, { idx: layers.get('time.idx'), parts: [layers.get('time.part.000')] });
    assert.notDeepEqual(d.time.idx, d.idx);
    assert.deepEqual([d.count, h.count, Object.hasOwn(h, 'time')], [5, 2, false]);
  }));

test('promote: a time.idx layer that is not the time copy of its pack (the key index under that title) is refused, exit 1, and nothing is written', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const first = rootAt(reg, 'latest');
    const good = await reg.seedPack('feed', 'feed-d-20261026', { dataset: 'feed', tier: 'd', start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z', sources: ['ct-le'], time: true });
    // The same manifest with its time.idx layer pointing at the key copy's idx blob.
    const m = JSON.parse(reg.w.manifests.get(`feed:${good.digest}`));
    const idx = m.layers.find((l) => l.annotations[TITLE] === 'idx');
    m.layers = m.layers.map((l) => (l.annotations[TITLE] === 'time.idx' ? { ...l, digest: idx.digest, size: idx.size } : l));
    const text = JSON.stringify(m);
    reg.w.manifests.set('feed:feed-d-20261026', text);
    reg.w.manifests.set(`feed:${sha(text)}`, text);
    const r = await promote(reg, tmp, ['--add', 'feed:feed-d-20261026', '--sources', REG], { now: '2026-10-29T09:10:00Z' });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /feed:feed-d-20261026: the time index holds dataset 3 \(feed\); the time copy of feed is dataset 6 \(feed-time\)/);
    assert.equal(rootAt(reg, 'latest').digest, first.digest);
    assert.equal(reg.w.manifests.has(`root:${rootTag('2026-10-29T09:10:00Z')}`), false);
  }));

test('promote: a root that names a pack GHCR does not hold fails with exit 1, and nothing is written', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    // The live root names a pack whose manifest the double never received.
    const live = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z', add: [entry('names', 'd', '2026-10-26T00:00:00Z')] });
    const liveDigest = reg.seedRoot(live, { sources: { format: SOURCES_LAYER_FORMAT, sources: [{ id: 'thc-ct', through: '2026-10-27T00:00:00Z', fetched: null }] } });
    const calls = reg.calls.length;
    const r = await promote(reg, tmp, ['--gap', 'thc-ct=2026-10-04', '--sources', REG], { now: '2026-10-29T09:00:00Z' });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /the next root names 1 pack\(s\) GHCR does not hold, so latest is left as it is: names:names-d-20261026 sha256:[0-9a-f]{64}/);
    assert.equal(rootAt(reg, 'latest').digest, liveDigest);
    assert.equal(reg.w.manifests.has(`root:${rootTag('2026-10-29T09:00:00Z')}`), false);
    assert.deepEqual(verbs(reg).slice(calls), ['login']);
  }));

test('promote: --fixture stale, a second writer moving latest after this run read it, exits 1 with latest as that writer left it and no tag written', async () => {
  const out = [];
  const code = await runFixture('stale', main, { out: (l) => out.push(l), err: () => undefined });
  assert.equal(code, EXIT.fault);
  assert.match(out.at(-1), /^fixture stale: exit 1; root:latest holds the second writer's root; this run's dated tag r-20261029t082000z was not written$/);
});

test("promote: the guard immediately before the move refuses a latest moved after the dated push; latest stays the other writer's, the dated root unreferenced", () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const one = rootAt(reg, 'latest');
    const other = buildRoot({ live: { root: one.root, digest: one.digest }, psl: PSL_LIVE, now: '2026-10-29T09:05:00Z', gaps: { 'thc-ct': ['2026-10-04'] } });
    const otherDigest = reg.seedRoot(other, { latest: false });
    // The second read of latest with the token in this run comes after the dated push.
    let latestReads = 0;
    reg.hooks.beforeFetch = (key) => {
      if (key !== 'root:latest') return;
      latestReads += 1;
      if (latestReads === 2) reg.w.manifests.set('root:latest', reg.w.manifests.get(`root:${otherDigest}`));
    };
    const r = await promote(reg, tmp, ['--gap', 'thc-ct=2026-10-09'], { now: '2026-10-29T09:10:00Z' });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /root:latest holds sha256:[0-9a-f]{64} \(root_seq 2, as_of null; this root is root_seq 2\), and this run planned on sha256:[0-9a-f]{64}: another writer moved it/);
    assert.equal(rootAt(reg, 'latest').digest, otherDigest);
    // The dated root of this run exists, unreferenced, and nothing moved it to latest.
    assert.equal(rootAt(reg, rootTag('2026-10-29T09:10:00Z')).root.root_seq, 2);
    assert.equal(verbs(reg).filter((v) => v === 'tag').length, 1, 'only the first promotion tagged latest');
  }));

// guardLatest called directly: no CLI path reaches its forward half, since
// buildRoot refuses the same pair first and a race is refused by the digest.
test('promote: guardLatest alone refuses a root that is not above the live one it is given', async () => {
  const live = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z', add: [entry('names', 'd', '2026-10-26T00:00:00Z')] });
  const d = `sha256:${'a'.repeat(64)}`;
  const next = buildRoot({ live: { root: live, digest: d }, psl: PSL_LIVE, now: '2026-10-29T08:10:00Z' });
  // Latest holds the digest the plan read: only the forward check is left to refuse.
  await guardLatest({ expected: d, found: d, live, next }, null);
  for (const [planted, re] of [
    [{ ...next, root_seq: live.root_seq }, /refused: the new root has root_seq 1, and the live root 1; root_seq only grows\. latest is left as it is/],
    [{ ...next, as_of: null }, /refused: the new root has as_of null, below the live root's 2026-10-27T00:00:00Z/],
  ]) {
    await assert.rejects(guardLatest({ expected: d, found: d, live, next: planted }, null), (e) => e instanceof Fault && re.test(e.message));
  }
  // A rollback may lower as_of, never root_seq.
  await guardLatest({ expected: d, found: d, live, next: { ...next, as_of: null }, rollback: true }, null);
});

test('promote: two promotions race; the second is refused, and its re-run reads the first and rebuilds on it', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const a = await reg.seedPack('names', 'names-d-20261026', { tier: 'd', start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' });
    const b = await reg.seedPack('names', 'names-d-20261027', { tier: 'd', start: '2026-10-27T00:00:00Z', end: '2026-10-28T00:00:00Z' });
    // B reads latest (root_seq 1) and plans; A then runs whole before B's guard.
    let raced = null;
    reg.hooks.beforeFetch = async (key) => {
      if (key !== 'root:latest' || raced !== null) return;
      raced = 'running';
      raced = await promote(reg, tmp, ['--add', a.ref, '--sources', REG], { now: '2026-10-29T09:01:00Z' });
    };
    const first = await promote(reg, tmp, ['--add', b.ref, '--sources', REG], { now: '2026-10-29T09:02:00Z' });
    reg.hooks.beforeFetch = undefined;
    assert.equal(raced.code, EXIT.ok, raced.text);
    assert.equal(first.code, EXIT.fault, first.text);
    assert.match(first.text, /another writer moved it/);
    const afterA = rootAt(reg, 'latest');
    assert.deepEqual([afterA.root.root_seq, afterA.root.datasets.names.map((p) => p.tag)], [2, ['names-d-20261026']]);
    // B's re-run reads A's root and builds root_seq 3 on it, with both packs.
    const rerun = await promote(reg, tmp, ['--add', b.ref, '--sources', REG], { now: '2026-10-29T09:03:00Z', attempt: '2' });
    assert.equal(rerun.code, EXIT.ok, rerun.text);
    const three = rootAt(reg, 'latest');
    assert.equal(three.root.root_seq, 3);
    assert.equal(three.root.previous, afterA.digest);
    assert.deepEqual(
      three.root.datasets.names.map((p) => p.tag),
      ['names-d-20261026', 'names-d-20261027'],
    );
  }));

test('promote: a re-run drops what the live root already names or supersedes, and a promotion that changes nothing writes nothing', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const a = await reg.seedPack('names', 'names-d-20261026', { tier: 'd', start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' });
    const h = await reg.seedPack('names', 'names-h-2026102605', { tier: 'h', start: '2026-10-26T05:00:00Z', end: '2026-10-26T06:00:00Z' });
    assert.equal((await promote(reg, tmp, ['--add', a.ref, '--sources', REG], { now: '2026-10-29T09:10:00Z' })).code, EXIT.ok);
    const live = rootAt(reg, 'latest');
    const tags = verbs(reg).filter((v) => v === 'tag').length;
    const rerun = await promote(reg, tmp, ['--add', a.ref, '--add', h.ref, '--sources', REG], { now: '2026-10-29T09:20:00Z', attempt: '2' });
    assert.equal(rerun.code, EXIT.ok, rerun.text);
    assert.match(rerun.text, /dropped names-d-20261026 sha256:[0-9a-f]{64}: the live root names it \(datasets\.names\) \(re-run, attempt 2\)/);
    assert.match(rerun.text, /dropped names-h-2026102605 sha256:[0-9a-f]{64}: the live root supersedes it with names-d-20261026/);
    assert.match(rerun.text, /unchanged root:latest sha256:[0-9a-f]{64} root_seq 2: nothing to promote, nothing written/);
    assert.equal(rootAt(reg, 'latest').digest, live.digest);
    assert.equal(verbs(reg).filter((v) => v === 'tag').length, tags);
    // The first attempt does not drop: the same pack twice is refused loud.
    const again = await promote(reg, tmp, ['--add', a.ref, '--sources', REG], { now: '2026-10-29T09:30:00Z' });
    assert.equal(again.code, EXIT.fault, again.text);
    assert.match(again.text, /datasets\.names\[1\] names the manifest sha256:[0-9a-f]{64}, which datasets\.names\[0\] names too/);
  }));

test('promote: the 24 hour packs of a day replaced by its day pack keep as_of, and the day is listed alone', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const hours = [];
    for (let h = 0; h < 24; h += 1) {
      const hh = String(h).padStart(2, '0');
      const end = h === 23 ? '2026-10-27T00:00:00Z' : `2026-10-26T${String(h + 1).padStart(2, '0')}:00:00Z`;
      hours.push((await reg.seedPack('names', `names-h-20261026${hh}`, { tier: 'h', start: `2026-10-26T${hh}:00:00Z`, end, records: 2 })).ref);
    }
    const added = await promote(reg, tmp, [...hours.flatMap((r) => ['--add', r]), '--sources', REG], { now: '2026-10-29T09:10:00Z' });
    assert.equal(added.code, EXIT.ok, added.text);
    const before = rootAt(reg, 'latest');
    assert.deepEqual(before.root.counts.names, { packs: 24, records: 48 });
    const day = await reg.seedPack('names', 'names-d-20261026', { tier: 'd', start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z', records: 5 });
    const r = await promote(reg, tmp, ['--replace', `${hours.join(',')}=${day.ref}`, '--sources', REG], { now: '2026-10-29T09:20:00Z' });
    assert.equal(r.code, EXIT.ok, r.text);
    const after = rootAt(reg, 'latest');
    assert.equal(after.root.as_of, before.root.as_of);
    assert.deepEqual(after.root.counts.names, { packs: 1, records: 5 });
    assert.deepEqual(
      after.root.datasets.names.map((p) => p.tag),
      ['names-d-20261026'],
    );
    // A replacement that names a pack the live root does not hold is refused.
    const absent = await promote(reg, tmp, ['--replace', `names:names-h-2026102600=${day.ref}`, '--sources', REG], { now: '2026-10-29T09:30:00Z' });
    assert.equal(absent.code, EXIT.fault, absent.text);
    assert.match(absent.text, /names names:names-h-2026102600, which is not a live names pack/);
  }));

test('promote: --partial adds the packs the live-set rule allows, before and after the live ones and in passes both ways, and prints each other one as waiting; without it the same promotion is refused whole', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const day = async (d) =>
      (await reg.seedPack('names', `names-d-202610${d}`, { tier: 'd', start: `2026-10-${d}T00:00:00Z`, end: `2026-10-${String(Number(d) + 1).padStart(2, '0')}T00:00:00Z` })).ref;
    assert.equal((await promote(reg, tmp, ['--add', await day('26'), '--sources', REG], { now: '2026-10-29T09:10:00Z' })).code, EXIT.ok);
    const two = rootAt(reg, 'latest');
    const tags = () => verbs(reg).filter((v) => v === 'tag').length;
    const [d24, d25, d27, d28, d29] = [await day('24'), await day('25'), await day('27'), await day('28'), await day('29')];
    const hole = (from, to) => `datasets.names: a hole from 2026-10-${from}T00:00:00Z to 2026-10-${to}T00:00:00Z: no pack covers it`;

    // Without --partial a pack across a hole refuses the whole promotion.
    const whole = await promote(reg, tmp, ['--add', d28, '--add', d29, '--sources', REG], { now: '2026-10-29T09:20:00Z' });
    assert.equal(whole.code, EXIT.fault, whole.text);
    assert.ok(whole.text.includes(hole('27', '28')), whole.text);
    assert.doesNotMatch(whole.text, /^waiting /m);
    assert.equal(rootAt(reg, 'latest').digest, two.digest);

    // With it, both wait and nothing else changes: unchanged, nothing written.
    const t0 = tags();
    const wait = await promote(reg, tmp, ['--add', d28, '--add', d29, '--sources', REG, '--partial'], { now: '2026-10-29T09:30:00Z' });
    assert.equal(wait.code, EXIT.ok, wait.text);
    assert.deepEqual(
      wait.out.filter((l) => l.startsWith('waiting ')),
      [`waiting ${d28}: ${hole('27', '28')}`, `waiting ${d29}: ${hole('27', '29')}`],
    );
    assert.match(wait.out.at(-1), /^unchanged root:latest sha256:[0-9a-f]{64} root_seq 2: nothing to promote, nothing written$/);
    assert.equal(rootAt(reg, 'latest').digest, two.digest);
    assert.equal(tags(), t0);
    assert.equal(reg.w.manifests.has(`root:${rootTag('2026-10-29T09:30:00Z')}`), false);

    // Given out of order: 27 closes the hole 28 and 29 need, 25 and then 24
    // extend the corpus back (24 joins on the pass against span order), and
    // an hour pack of the live day overlaps it and waits.
    const h = (await reg.seedPack('names', 'names-h-2026102605', { tier: 'h', start: '2026-10-26T05:00:00Z', end: '2026-10-26T06:00:00Z' })).ref;
    const some = await promote(reg, tmp, ['--add', d29, '--add', h, '--add', d24, '--add', d28, '--add', d27, '--add', d25, '--sources', REG, '--partial'], { now: '2026-10-29T09:40:00Z' });
    assert.equal(some.code, EXIT.ok, some.text);
    assert.deepEqual(
      some.out.filter((l) => l.startsWith('waiting ')),
      [
        `waiting ${h}: datasets.names: names:names-d-20261026 (d, 2026-10-26T00:00:00Z to 2026-10-27T00:00:00Z) and names:names-h-2026102605 (h, 2026-10-26T05:00:00Z to 2026-10-26T06:00:00Z) overlap; two compacted packs never do`,
      ],
    );
    assert.ok(some.out.findIndex((l) => l.startsWith('waiting ')) < some.out.findIndex((l) => l.startsWith('built ')), some.text);
    const three = rootAt(reg, 'latest');
    assert.equal(three.root.root_seq, 3);
    assert.equal(three.root.previous, two.digest);
    assert.deepEqual(
      three.root.datasets.names.map((p) => p.tag),
      ['names-d-20261024', 'names-d-20261025', 'names-d-20261026', 'names-d-20261027', 'names-d-20261028', 'names-d-20261029'],
    );
    assert.equal(three.root.corpus_since.names, '2026-10-24T00:00:00Z');
    assert.equal(three.root.as_of, '2026-10-30T00:00:00Z');
  }));

test('promote: --partial defers only the live-set refusal: a quarantined pack, a pack GHCR does not hold and a refused replacement still exit 1, and a promotion the rule allows whole is the one without it', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const seedDay = (d, extra = {}) =>
      reg.seedPack('names', `names-d-202610${d}`, { tier: 'd', start: `2026-10-${d}T00:00:00Z`, end: `2026-10-${String(Number(d) + 1).padStart(2, '0')}T00:00:00Z`, extra });
    const [d19, d20] = [await seedDay('19'), await seedDay('20')];
    const both = await promote(reg, tmp, ['--add', d19.ref, '--add', d20.ref, '--sources', REG, '--partial'], { now: '2026-10-29T09:10:00Z' });
    assert.equal(both.code, EXIT.ok, both.text);
    assert.doesNotMatch(both.text, /^waiting /m);
    assert.deepEqual(
      rootAt(reg, 'latest').root.datasets.names.map((p) => p.tag),
      ['names-d-20261019', 'names-d-20261020'],
    );
    const live = rootAt(reg, 'latest').digest;
    // A quarantined manifest, beside a pack that would wait.
    const q = await seedDay('22', { 'dev.pkgforge.domains.quarantine': '1' });
    const d23 = await seedDay('23');
    const quarantined = await promote(reg, tmp, ['--add', q.ref, '--add', d23.ref, '--sources', REG, '--partial'], { now: '2026-10-29T09:20:00Z' });
    assert.equal(quarantined.code, EXIT.fault, quarantined.text);
    assert.match(quarantined.text, /carries dev\.pkgforge\.domains\.quarantine="1": a quarantined pack joins no root/);
    // A replacement the live-set rule refuses (the week of 19 overlaps the day
    // 20 it does not replace) is refused whole, not deferred.
    const week = await reg.seedPack('names', 'names-w-2026w43', { tier: 'w', start: '2026-10-19T00:00:00Z', end: '2026-10-26T00:00:00Z' });
    const replaced = await promote(reg, tmp, ['--replace', `${d19.ref}=${week.ref}`, '--add', d23.ref, '--sources', REG, '--partial'], { now: '2026-10-29T09:30:00Z' });
    assert.equal(replaced.code, EXIT.fault, replaced.text);
    assert.match(
      replaced.text,
      /datasets\.names: names:names-w-2026w43 \(w, 2026-10-19T00:00:00Z to 2026-10-26T00:00:00Z\) and names:names-d-20261020 \(d, .+\) overlap; two compacted packs never do/,
    );
    assert.doesNotMatch(replaced.text, /^waiting /m);
    assert.equal(rootAt(reg, 'latest').digest, live);
    // A pack the next root names and GHCR does not hold: the live root's own,
    // its manifest gone from the double.
    reg.w.manifests.delete(`names:${d20.digest}`);
    const d21 = await seedDay('21');
    const missing = await promote(reg, tmp, ['--add', d21.ref, '--add', d23.ref, '--sources', REG, '--partial'], { now: '2026-10-29T09:40:00Z' });
    assert.equal(missing.code, EXIT.fault, missing.text);
    assert.ok(missing.out.includes(`waiting ${d23.ref}: datasets.names: a hole from 2026-10-22T00:00:00Z to 2026-10-23T00:00:00Z: no pack covers it`), missing.text);
    assert.match(missing.text, /the next root names 1 pack\(s\) GHCR does not hold, so latest is left as it is: names:names-d-20261020 sha256:[0-9a-f]{64}/);
    assert.equal(rootAt(reg, 'latest').digest, live);
  }));

test('promote: keepLiveSet returns the additions as given when the root with all of them passes, keeps the rest in the order given, and holds a manifest the root names already as a live-set refusal', () => {
  const d = (day) => entry('names', 'd', `2026-10-${day}T00:00:00Z`);
  const liveRoot = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z', add: [d('26')] });
  const input = (add, replace = []) => ({ live: { root: liveRoot, digest: `sha256:${'a'.repeat(64)}` }, add, replace, psl: PSL_LIVE, now: '2026-10-29T09:00:00Z', gaps: {} });
  const all = [d('27'), d('28')];
  const whole = keepLiveSet(input(all));
  assert.equal(whole.add, all, 'the same list, untouched');
  assert.deepEqual(whole.waiting, []);
  const given = [d('28'), d('24'), d('30'), d('25'), d('27'), d('26')];
  const r = keepLiveSet(input(given));
  assert.deepEqual(
    r.add.map((np) => np.pack.tag),
    ['names-d-20261028', 'names-d-20261024', 'names-d-20261025', 'names-d-20261027'],
  );
  assert.deepEqual(r.waiting, [
    { ref: 'names:names-d-20261030', message: 'datasets.names: a hole from 2026-10-29T00:00:00Z to 2026-10-30T00:00:00Z: no pack covers it' },
    { ref: 'names:names-d-20261026', message: `datasets.names: names:names-d-20261026 names the manifest ${liveRoot.datasets.names[0].manifest}, which the root names already` },
  ]);
  // The root the caller builds with the kept ones passes whole.
  assert.equal(buildRoot({ ...input(r.add) }).datasets.names.length, 5);
  // One PKG:TAG given twice is kept once, and no copy waits on the other.
  const d29 = d('29');
  const hole = d('31');
  const twice = keepLiveSet(input([d29, d('27'), d29, d('28'), hole]));
  assert.deepEqual(
    twice.add.map((np) => np.pack.tag),
    ['names-d-20261029', 'names-d-20261027', 'names-d-20261028'],
  );
  assert.deepEqual(
    twice.waiting.map((w) => w.ref),
    ['names:names-d-20261031'],
  );
  // Two refs of one manifest are two additions: the second waits on the first, kept.
  const alias = { ...d29, pack: { ...d29.pack, tag: 'names-d-20261029-r2' } };
  const two = keepLiveSet(input([d('27'), d('28'), d29, alias]));
  assert.deepEqual(
    two.waiting.map((w) => [w.ref, w.message]),
    [['names:names-d-20261029-r2', `datasets.names: names:names-d-20261029-r2 names the manifest ${d29.pack.manifest}, which the root names already`]],
  );
  // A refusal of another code is thrown, as buildRoot throws it.
  assert.throws(
    () => keepLiveSet(input([d('28')], [{ old: [`sha256:${'b'.repeat(64)}`], new: d('27') }])),
    (e) => e instanceof RootError && e.code === 'replace',
  );
  // An addition the live root withdrew is refused for itself, never kept by the pass that tries the additions one at a time.
  const d27 = d('27');
  const withdrew = { ...liveRoot, withdrawn: [{ manifest: d27.pack.manifest, at: '2026-10-29T08:00:00Z' }] };
  assert.throws(
    () => keepLiveSet({ ...input([d27, d('28')]), live: { root: withdrew, digest: `sha256:${'a'.repeat(64)}` } }),
    (e) => e instanceof RootError && e.code === 'withdrawn' && e.message.startsWith('the addition names:names-d-20261027 '),
  );
});

test('promote: a dated root that reads back as another root.json is refused, and latest does not move', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const live = rootAt(reg, 'latest');
    const d19 = await reg.seedPack('names', 'names-d-20261019', { tier: 'd', start: '2026-10-19T00:00:00Z', end: '2026-10-20T00:00:00Z' });
    // Planted: a root read by a digest other than the live one answers the live
    // root, from the second read of that digest on. The first read is push.mjs's
    // own read back, which refuses another manifest before publish reads it.
    const real = anonymousReader();
    const ROOT_REPO = repoOf('root');
    const reads = new Map();
    const planted = (repo, ref) => {
      if (repo !== ROOT_REPO || !ref.startsWith('sha256:') || ref === live.digest) return ref;
      reads.set(ref, (reads.get(ref) ?? 0) + 1);
      return reads.get(ref) >= 2 ? live.digest : ref;
    };
    const reader = new Proxy(real, {
      get: (target, key) => {
        if (key === 'getManifest') return (repo, ref, opts) => target.getManifest(repo, planted(repo, ref), opts);
        const v = target[key];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const out = [];
    const err = [];
    const code = await main(['--add', d19.ref, '--sources', REG], { ...depsFor(reg, { now: '2026-10-29T09:10:00Z', tmp, out: (l) => out.push(l), err: (l) => err.push(l) }), reader });
    const text = `${out.join('\n')}\n${err.join('\n')}`;
    assert.equal(code, EXIT.fault, text);
    assert.match(text, /root@sha256:[0-9a-f]{64} holds another root\.json than this run built/);
    assert.equal(rootAt(reg, 'latest').digest, live.digest);
    assert.ok(reg.w.manifests.has(`root:${rootTag('2026-10-29T09:10:00Z')}`), 'the dated root was pushed, and latest left');
  }));

test('promote: a dated tag that holds another manifest is exit 3, and latest does not move', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const live = rootAt(reg, 'latest');
    // Another manifest already under the dated tag this run would write.
    reg.seed('root', rootTag('2026-10-29T09:10:00Z'), artifactType('root'), {}, [{ title: 'root.json', bytes: new TextEncoder().encode('{}\n') }]);
    const r = await promote(reg, tmp, ['--gap', 'thc-ct=2026-10-04'], { now: '2026-10-29T09:10:00Z' });
    assert.equal(r.code, EXIT.replaced, r.text);
    assert.match(r.text, /^replaced ghcr\.io\/pkgforge-dev\/domains\.pkgforge\.dev\/root:r-20261029t091000z holds sha256:[0-9a-f]{64}, not sha256:[0-9a-f]{64}; nothing was written$/m);
    assert.equal(rootAt(reg, 'latest').digest, live.digest);
  }));

test('promote: latest read back as another root than the one moved is a fault', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const first = rootAt(reg, 'latest');
    // Planted: oras tag answers 0 and leaves latest on the first root.
    const real = reg.oras;
    const planted = async (args, opts) => (args[0] === 'tag' ? { code: 0, stdout: 'Tagged latest\n', stderr: '' } : real(args, opts));
    const out = [];
    const err = [];
    const code = await main(['--gap', 'thc-ct=2026-10-04'], { ...depsFor(reg, { now: '2026-10-29T09:10:00Z', tmp, out: (l) => out.push(l), err: (l) => err.push(l) }), oras: planted });
    assert.equal(code, EXIT.fault, err.join('\n'));
    assert.match(err.join('\n'), /root:latest reads as sha256:[0-9a-f]{64} with no credential, not sha256:[0-9a-f]{64}/);
    assert.equal(rootAt(reg, 'latest').digest, first.digest);
  }));

test('promote: a root:latest that exists and does not read with no credential is PRIVATE PACKAGE, exit 4, nothing written', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    const live = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z' });
    const d = reg.seedRoot(live);
    const prev = reg.w.intercept;
    reg.w.intercept = (url, init) => (url.endsWith('/root/manifests/latest') ? reg.w.response(404, '{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', {}, { url }) : prev(url, init));
    const r = await promote(reg, tmp, ['--gap', 'thc-ct=2026-10-04'], { now: '2026-10-29T09:00:00Z' });
    assert.equal(r.code, EXIT.private, r.text);
    assert.deepEqual(r.out, ['PRIVATE PACKAGE']);
    assert.match(r.text, /root:latest holds sha256:[0-9a-f]{64}, and it does not read with no credential/);
    assert.equal(sha(reg.w.manifests.get('root:latest')), d);
    assert.deepEqual(verbs(reg), ['login', 'manifest fetch']);
  }));

// A promotion with `oras` in place of the double's own.
async function promoteWith(reg, tmp, argv, now, oras) {
  const out = [];
  const err = [];
  const code = await main(argv, { ...depsFor(reg, { now, tmp, out: (l) => out.push(l), err: (l) => err.push(l) }), oras });
  return { code, text: `${out.join('\n')}\n${err.join('\n')}` };
}

test('promote: an oras tag that exits 1 after it landed is a success, and one that fails after another writer moved latest is refused, latest left theirs', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const one = rootAt(reg, 'latest');
    // Planted: the tag lands, and oras still exits 1 (a timeout on the answer).
    const real = reg.oras;
    const landed = async (args, opts) => {
      if (args[0] !== 'tag') return real(args, opts);
      await real(args, opts);
      return { code: 1, stdout: '', stderr: 'Error: i/o timeout\n' };
    };
    const ok = await promoteWith(reg, tmp, ['--gap', 'thc-ct=2026-10-04'], '2026-10-29T09:10:00Z', landed);
    assert.equal(ok.code, EXIT.ok, ok.text);
    assert.match(ok.text, /oras tag: attempt 1 exited 1, and latest holds sha256:[0-9a-f]{64}: it landed/);
    const two = rootAt(reg, 'latest');
    assert.equal(two.root.root_seq, 2);
    // Planted: the first tag call fails after another writer moved latest to its own root_seq 3.
    const other = buildRoot({ live: { root: two.root, digest: two.digest }, psl: PSL_LIVE, now: '2026-10-29T09:15:00Z', gaps: { 'thc-ct': ['2026-10-04', '2026-10-05'] } });
    const otherDigest = reg.seedRoot(other, { latest: false });
    let tags = 0;
    const moved = async (args, opts) => {
      if (args[0] === 'tag' && tags++ === 0) {
        reg.w.manifests.set('root:latest', reg.w.manifests.get(`root:${otherDigest}`));
        return { code: 1, stdout: '', stderr: 'Error: 500 Internal Server Error\n' };
      }
      return real(args, opts);
    };
    const refused = await promoteWith(reg, tmp, ['--gap', 'thc-ct=2026-10-09'], '2026-10-29T09:20:00Z', moved);
    assert.equal(refused.code, EXIT.fault, refused.text);
    assert.match(
      refused.text,
      /oras tag failed \(Error: 500 Internal Server Error\), and ghcr\.io\/pkgforge-dev\/domains\.pkgforge\.dev\/root:latest now holds sha256:[0-9a-f]{64}: another writer moved it/,
    );
    assert.equal(tags, 1, 'no second oras tag');
    assert.equal(rootAt(reg, 'latest').digest, otherDigest);
    assert.notEqual(one.digest, otherDigest);
  }));

test('promote: a failed read of latest with the token that is not a not-found is retried, never taken for an absent root', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    const d = reg.seedRoot(buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z' }));
    // The anonymous read of latest answers 404, and the first oras read of it times out.
    const prev = reg.w.intercept;
    reg.w.intercept = (url, init) => (url.endsWith('/root/manifests/latest') ? reg.w.response(404, '{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', {}, { url }) : prev(url, init));
    const real = reg.oras;
    let fetches = 0;
    const flaky = async (args, opts) => (args[0] === 'manifest' && fetches++ === 0 ? { code: 1, stdout: '', stderr: 'Error: dial tcp: i/o timeout\n' } : real(args, opts));
    const r = await promoteWith(reg, tmp, ['--psl', PSL_TAG], '2026-10-29T09:00:00Z', flaky);
    assert.equal(r.code, EXIT.private, r.text);
    assert.match(r.text, /read ghcr\.io\/pkgforge-dev\/domains\.pkgforge\.dev\/root:latest: attempt 1 of \d+ failed \(exit 1\): Error: dial tcp: i\/o timeout/);
    assert.equal(sha(reg.w.manifests.get('root:latest')), d, 'latest is the root it was');
    assert.equal(reg.w.manifests.has(`root:${rootTag('2026-10-29T09:00:00Z')}`), false);
  }));

test('promote: a latest that reads with no credential and is not a root is a fault, exit 1, not PRIVATE PACKAGE', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    reg.seed('root', 'latest', artifactType('ref'), {}, [{ title: 'root.json', bytes: new TextEncoder().encode('{}\n'), mediaType: 'application/json' }]);
    const r = await promote(reg, tmp, ['--gap', 'thc-ct=2026-10-04'], { now: '2026-10-29T09:00:00Z' });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /root:latest is "application\/vnd\.pkgforge\.domains\.ref\.v1", not application\/vnd\.pkgforge\.domains\.root\.v1/);
    assert.doesNotMatch(r.text, /PRIVATE PACKAGE/);
  }));

test('promote: a writer refuses a live root that holds a field it does not know, and writes nothing', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    const d = reg.seedRoot({ ...buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z' }), later: 1 });
    const r = await promote(reg, tmp, ['--gap', 'thc-ct=2026-10-04'], { now: '2026-10-29T09:00:00Z' });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /root\.json holds the unknown field\(s\) later/);
    assert.equal(sha(reg.w.manifests.get('root:latest')), d);
  }));

test('promote: a promotion whose only change is the PSL pin, the coverage table, a fetched time or the registry writes a root; the same fetched time again is unchanged', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    // The first root under the default registry (config/sources.json, no source yet).
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const steps = [];
    const step = async (argv, now, what) => {
      const r = await promote(reg, tmp, argv, { now });
      assert.equal(r.code, EXIT.ok, `${what}: ${r.text}`);
      steps.push([what, /unchanged/.test(r.text), rootAt(reg, 'latest').root.root_seq]);
      return rootAt(reg, 'latest');
    };
    // The registry alone.
    const reg2 = await step(['--sources', REG], '2026-10-29T09:10:00Z', 'registry');
    assert.deepEqual(
      reg2.sources.sources.map((s) => s.id),
      ['thc-ct', 'ct-le'],
    );
    // A new PSL pin alone (a synthetic second list).
    const list = new TextEncoder().encode('// a second synthetic list\n');
    const x = sha(list).slice(7);
    reg.seed('ref', refTag('psl', x), artifactType('ref'), { 'dev.pkgforge.domains.sha256': x }, [{ title: 'public_suffix_list.dat', bytes: list, mediaType: 'text/plain' }]);
    assert.equal((await step(['--sources', REG, '--psl', refTag('psl', x)], '2026-10-29T09:20:00Z', 'psl')).root.psl, x);
    // The coverage table alone.
    const file = join(tmp, 'coverage.json');
    writeFileSync(file, JSON.stringify({ as_of: '2026-10-29T00:00:00Z', day: '2026-10-28', pairs: [], gaps: {} }));
    assert.equal((await step(['--sources', REG, '--coverage', file], '2026-10-29T09:30:00Z', 'coverage')).coverage.day, '2026-10-28');
    // A fetched time alone, then the same time again.
    const fetched = await step(['--sources', REG, '--fetched', 'thc-ct=2026-10-29T08:00:00Z'], '2026-10-29T09:40:00Z', 'fetched');
    assert.deepEqual(
      fetched.sources.sources.map((s) => [s.id, s.fetched]),
      [
        ['thc-ct', '2026-10-29T08:00:00Z'],
        ['ct-le', null],
      ],
    );
    await step(['--sources', REG, '--fetched', 'thc-ct=2026-10-29T08:00:00Z'], '2026-10-29T09:50:00Z', 'the same fetched');
    assert.deepEqual(steps, [
      ['registry', false, 2],
      ['psl', false, 3],
      ['coverage', false, 4],
      ['fetched', false, 5],
      ['the same fetched', true, 5],
    ]);
  }));

test('promote: the gaps, the fetched times and the coverage table carry forward across promotions that do not name them', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const file = join(tmp, 'coverage.json');
    writeFileSync(file, JSON.stringify({ as_of: '2026-10-29T00:00:00Z', day: '2026-10-28', pairs: [], gaps: {} }));
    const a = await promote(reg, tmp, ['--gap', 'thc-ct=2026-10-04', '--sources', REG, '--fetched', 'thc-ct=2026-10-29T08:00:00Z', '--coverage', file], { now: '2026-10-29T09:10:00Z' });
    assert.equal(a.code, EXIT.ok, a.text);
    const b = await promote(reg, tmp, ['--gap', 'thc-ct=2026-10-09', '--gap', 'ct-le=2026-10-05', '--sources', REG], { now: '2026-10-29T09:20:00Z' });
    assert.equal(b.code, EXIT.ok, b.text);
    const three = rootAt(reg, 'latest');
    assert.equal(three.root.root_seq, 3);
    assert.deepEqual(three.root.gaps, { 'ct-le': ['2026-10-05'], 'thc-ct': ['2026-10-04', '2026-10-09'] });
    assert.equal(three.sources.sources.find((s) => s.id === 'thc-ct').fetched, '2026-10-29T08:00:00Z', 'fetched carried from the live layer');
    assert.equal(three.coverage.day, '2026-10-28', 'coverage carried from the live root');
  }));

test('promote: a missing pack is found in every dataset, by the digest the root names, not by its tag', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    const sources = { format: SOURCES_LAYER_FORMAT, sources: [{ id: 'thc-ct', through: '2026-10-27T00:00:00Z', fetched: null }] };
    // Two datasets, feed first in key order, neither pack ever pushed.
    const both = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z', add: [entry('names', 'd', '2026-10-26T00:00:00Z'), entry('feed', 'd', '2026-10-26T00:00:00Z')] });
    const bothDigest = reg.seedRoot(both, { sources });
    const r = await promote(reg, tmp, ['--gap', 'thc-ct=2026-10-04', '--sources', REG], { now: '2026-10-29T09:00:00Z' });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /the next root names 2 pack\(s\) GHCR does not hold, so latest is left as it is: feed:feed-d-20261026 sha256:[0-9a-f]{64} .*; names:names-d-20261026 sha256:[0-9a-f]{64}/);
    assert.equal(rootAt(reg, 'latest').digest, bothDigest);
  }));

test('promote: a pack whose tag now holds another manifest than the digest the root names is missing', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    const sources = { format: SOURCES_LAYER_FORMAT, sources: [{ id: 'thc-ct', through: '2026-10-27T00:00:00Z', fetched: null }] };
    const live = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z', add: [entry('names', 'd', '2026-10-26T00:00:00Z')] });
    const liveDigest = reg.seedRoot(live, { sources });
    const p = await reg.seedPack('names', 'names-d-20261026', { tier: 'd', start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' });
    assert.notEqual(p.digest, live.datasets.names[0].manifest);
    const r = await promote(reg, tmp, ['--gap', 'thc-ct=2026-10-04', '--sources', REG], { now: '2026-10-29T09:00:00Z' });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /the next root names 1 pack\(s\) GHCR does not hold, so latest is left as it is: names:names-d-20261026 sha256:[0-9a-f]{64}/);
    assert.equal(rootAt(reg, 'latest').digest, liveDigest);
  }));

test('promote: a psl tag whose layer is not its annotation, with a second layer, another title or another type is refused, and nothing is written', () =>
  inRegistry(async (reg, tmp) => {
    let n = 0;
    // A ref psl manifest whose tag and annotation are its one list's hash, with one planted fault.
    const seedRef = ({ type = artifactType('ref'), title = 'public_suffix_list.dat', extra = [] }) => {
      n += 1;
      const bytes = new TextEncoder().encode(`// synthetic list ${n}\n`);
      const x = sha(bytes).slice(7);
      reg.seed('ref', refTag('psl', x), type, { 'dev.pkgforge.domains.sha256': x }, [{ title, bytes, mediaType: 'text/plain' }, ...extra]);
      return refTag('psl', x);
    };
    // The annotation and the tag pin PSL_LIVE; the one layer holds other bytes.
    reg.seed('ref', PSL_TAG, artifactType('ref'), { 'dev.pkgforge.domains.sha256': PSL_LIVE }, [
      { title: 'public_suffix_list.dat', bytes: new TextEncoder().encode('// not the pinned list\n'), mediaType: 'text/plain' },
    ]);
    for (const [what, tag, re] of [
      ['the layer is not the annotation', PSL_TAG, /does not hold one layer public_suffix_list\.dat whose digest is its dev\.pkgforge\.domains\.sha256/],
      ['a second layer', seedRef({ extra: [{ title: 'other', bytes: new TextEncoder().encode('x'), mediaType: 'text/plain' }] }), /does not hold one layer/],
      ['another title', seedRef({ title: 'other.dat' }), /does not hold one layer/],
      ['another type', seedRef({ type: artifactType('pack') }), /is "application\/vnd\.pkgforge\.domains\.pack\.v1", not a ref/],
    ]) {
      const r = await promote(reg, tmp, ['--psl', tag], { now: '2026-10-29T09:00:00Z' });
      assert.equal(r.code, EXIT.fault, `${what}: ${r.text}`);
      assert.match(r.text, re, what);
      assert.equal(reg.w.manifests.has('root:latest'), false, what);
    }
  }));

test('promote: readRoot refuses a root of another type, a layer twice, a layer it does not know, and a sources layer that disagrees with root.json', () =>
  inRegistry(async (reg) => {
    const root = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z', add: [entry('names', 'd', '2026-10-26T00:00:00Z')] });
    const L = (title, value) => ({ title, bytes: layerBytes(value), mediaType: 'application/json' });
    const sourcesAt = (through) => L('sources.json', { format: SOURCES_LAYER_FORMAT, sources: [{ id: 'thc-ct', through, fetched: null }] });
    const [rootJson, sources, coverage] = [L('root.json', root), sourcesAt('2026-10-27T00:00:00Z'), L('coverage.json', EMPTY_COVERAGE)];
    const deps = { sleep: async () => undefined, random: () => 0, log: () => undefined };
    const reader = anonymousReader();
    reg.seed('root', 'ok', artifactType('root'), {}, [rootJson, sources, coverage]);
    assert.equal((await readRoot(reader, 'ok', deps)).root.root_seq, 1, 'the control reads');
    for (const [what, type, layers, re] of [
      ['another type', artifactType('ref'), [rootJson, sources, coverage], /root:bad is "application\/vnd\.pkgforge\.domains\.ref\.v1", not application\/vnd\.pkgforge\.domains\.root\.v1/],
      ['a layer twice', artifactType('root'), [rootJson, sources, coverage, coverage], /root:bad holds the layer coverage\.json twice/],
      [
        'a layer it does not know',
        artifactType('root'),
        [rootJson, sources, coverage, L('tidx.json', {})],
        /root:bad holds the layer "tidx\.json"; a root holds root\.json, sources\.json, coverage\.json/,
      ],
      [
        'a sources layer that disagrees',
        artifactType('root'),
        [rootJson, sourcesAt('2026-10-28T00:00:00Z'), coverage],
        /sources\.json: thc-ct is through "2026-10-28T00:00:00Z", and the root says "2026-10-27T00:00:00Z"/,
      ],
    ]) {
      reg.seed('root', 'bad', type, {}, layers);
      await assert.rejects(readRoot(reader, 'bad', deps), (e) => e instanceof Fault && re.test(e.message), what);
    }
    // A reader (strict false) takes the layer it does not know.
    reg.seed('root', 'later', artifactType('root'), {}, [rootJson, sources, coverage, L('tidx.json', {})]);
    assert.equal((await readRoot(reader, 'later', deps, { strict: false })).root.root_seq, 1);
  }));

test('promote: bad arguments and a missing token are exit 2 before anything is read', async () => {
  for (const [argv, re] of [
    [['--bogus', 'x'], /unknown flag --bogus/],
    [['--add', 'names-d-20261026'], /is not PACKAGE:TAG/],
    [['--replace', 'names:a'], /is not OLD\[,OLD\.\.\.\]=NEW/],
    [['--psl', 'psl-1f96'], /is not a tag psl-<12 hex>/],
    [['--gap', 'thc-ct=2026-10'], /is not SOURCE=YYYY-MM-DD/],
    [['--psl', PSL_TAG, '--psl', PSL_TAG], /--psl is given twice/],
    [['--fixture', 'stale', '--psl', PSL_TAG], /--fixture NAME takes no other flag/],
    [['--fixture', 'stale', '--partial'], /--fixture NAME takes no other flag/],
    [['--partial=true'], /--partial takes no value/],
    [['--partial', '--partial'], /--partial is given twice/],
    [['names:a'], /is not a flag/],
  ]) {
    assert.throws(() => parsePromoteArgs(argv), re, argv.join(' '));
    const err = [];
    assert.equal(await main(argv, { err: (l) => err.push(l), env: {} }), EXIT.usage);
  }
  const err = [];
  assert.equal(await main(['--psl', PSL_TAG], { env: { GITHUB_ACTOR: 'a' }, err: (l) => err.push(l) }), EXIT.usage);
  assert.match(err.join('\n'), /REGISTRY_TOKEN is not set/);
  assert.equal(await main(['--fixture', 'nope'], { err: () => undefined, out: () => undefined }), EXIT.usage);
});

test('promote: a malformed GITHUB_RUN_ATTEMPT is exit 2 before anything is read, and latest keeps its digest', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await promote(reg, tmp, ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' })).code, EXIT.ok);
    const live = rootAt(reg, 'latest');
    const calls = reg.calls.length;
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Number() reads '1e0' and ' 2' as 1 and 2: digits only are an attempt.
    for (const attempt of ['abc', '0', '1.5', '', '1e0', ' 2']) {
      const r = await promote(reg, tmp, ['--gap', 'thc-ct=2026-10-04'], { now: '2026-10-29T09:10:00Z', attempt });
      assert.equal(r.code, EXIT.usage, `${JSON.stringify(attempt)}: ${r.text}`);
      assert.match(r.text, new RegExp(`GITHUB_RUN_ATTEMPT ${esc(JSON.stringify(attempt))} is not a whole number of at least 1`), attempt);
      assert.equal(rootAt(reg, 'latest').digest, live.digest, attempt);
    }
    assert.equal(reg.calls.length, calls, 'no oras call: not even the login');
    assert.equal(reg.w.manifests.has(`root:${rootTag('2026-10-29T09:10:00Z')}`), false);
  }));

test('promote: a RUNNER_TEMP that cannot be used is exit 2 before the login, and latest is not read', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    const r = await promote(reg, join(tmp, 'no-such-dir'), ['--psl', PSL_TAG], { now: '2026-10-29T09:00:00Z' });
    assert.equal(r.code, EXIT.usage, r.text);
    assert.match(r.text, /the temporary directory .*no-such-dir \(RUNNER_TEMP\) cannot be used/);
    assert.deepEqual(reg.calls, [], 'no oras call: not even the login');
    assert.equal(reg.w.manifests.has('root:latest'), false);
  }));

test('promote: as a process, --fixture stale exits 1 and writes nothing to the network', () => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.REGISTRY_TOKEN;
  const r = spawnSync(process.execPath, [SCRIPT, '--fixture', 'stale'], { cwd: ROOT, env, encoding: 'utf8' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, /^fixture stale: exit 1; root:latest holds the second writer's root; this run's dated tag r-20261029t082000z was not written$/m);
  assert.match(r.stderr, /fixture stale: a second writer moved root:latest from sha256:[0-9a-f]{64} \(root_seq 1\) to sha256:[0-9a-f]{64} \(root_seq 2\)/);
});
