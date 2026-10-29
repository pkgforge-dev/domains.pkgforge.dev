// scripts/root/rollback.mjs against the GHCR double of scripts/root/fixture.mjs
// (packages/testkit's world): a rollback is a new root with a higher
// root_seq that names an older root's packs, moved by the same guard, push,
// move and read-back as a promotion. Every root, pack and digest is synthetic.
//
//   node scripts/test.mjs scripts/root --name rollback
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactType, refTag } from '@domains/ghcr';
import { buildRoot, EMPTY_COVERAGE, SOURCES_LAYER_FORMAT } from '@domains/root';
import { pack as entry } from '../../packages/root/test/helpers.ts';
import { ROOT } from '../files.mjs';
import { depsFor, PSL_LIVE, PSL_TAG, registry, sha } from './fixture.mjs';
import { EXIT } from './lib.mjs';
import { main as promote } from './promote.mjs';
import { main } from './rollback.mjs';

const REG = join(ROOT, 'packages', 'pack', 'test', 'verify', 'registry.json');
const TITLE = 'org.opencontainers.image.title';
// The dated tag of root 2 of chain().
const TWO = 'r-20261029t091000z';
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function inRegistry(fn) {
  const reg = registry();
  const tmp = mkdtempSync(join(tmpdir(), 'root-rollback-test-'));
  try {
    await fn(reg, tmp);
    assert.deepEqual(reg.w.unusedBodies(), [], 'every GHCR answer body is read or cancelled');
  } finally {
    reg.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

const run = async (fn, reg, tmp, argv, now, attempt = '1') => {
  const lines = [];
  const code = await fn(argv, depsFor(reg, { now, tmp, attempt, out: (l) => lines.push(l), err: (l) => lines.push(l) }));
  return { code, text: lines.join('\n') };
};

function rootAt(reg, ref) {
  const text = reg.w.manifests.get(`root:${ref}`);
  const m = JSON.parse(text);
  const layer = (t) => JSON.parse(new TextDecoder().decode(reg.bytes.get(m.layers.find((l) => l.annotations[TITLE] === t).digest)));
  return { digest: sha(text), root: layer('root.json'), coverage: layer('coverage.json') };
}

const tagsOf = (root) =>
  Object.values(root.datasets)
    .flat()
    .map((p) => p.tag);

// Roots 1 (empty), 2 (+ day 26) and 3 (+ day 27).
async function chain(reg, tmp) {
  reg.seedPsl();
  assert.equal((await run(promote, reg, tmp, ['--psl', PSL_TAG], '2026-10-29T09:00:00Z')).code, EXIT.ok);
  const a = await reg.seedPack('names', 'names-d-20261026', { tier: 'd', start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' });
  assert.equal((await run(promote, reg, tmp, ['--add', a.ref, '--sources', REG], '2026-10-29T09:10:00Z')).code, EXIT.ok);
  const b = await reg.seedPack('names', 'names-d-20261027', { tier: 'd', start: '2026-10-27T00:00:00Z', end: '2026-10-28T00:00:00Z' });
  assert.equal((await run(promote, reg, tmp, ['--add', b.ref, '--sources', REG], '2026-10-29T09:20:00Z')).code, EXIT.ok);
}

test('rollback: a new root with root_seq 4 names the packs of root 2, previous the live digest, and as_of falls with them', () =>
  inRegistry(async (reg, tmp) => {
    await chain(reg, tmp);
    const three = rootAt(reg, 'latest');
    const two = rootAt(reg, 'r-20261029t091000z');
    const r = await run(main, reg, tmp, ['--to', 'r-20261029t091000z'], '2026-10-29T09:30:00Z');
    assert.equal(r.code, EXIT.ok, r.text);
    const four = rootAt(reg, 'latest');
    assert.equal(four.root.root_seq, 4);
    assert.equal(four.root.previous, three.digest);
    assert.deepEqual(four.root.datasets, two.root.datasets);
    assert.equal(four.root.as_of, '2026-10-27T00:00:00Z');
    assert.equal(rootAt(reg, 'r-20261029t093000z').digest, four.digest);
    // Nothing is deleted: the newer root and its pack stay in GHCR.
    assert.equal(rootAt(reg, 'r-20261029t092000z').digest, three.digest);
    assert.ok(reg.w.manifests.has('names:names-d-20261027'));
  }));

test('rollback: a target that is not older than the live root, and no live root, are refused with exit 1', () =>
  inRegistry(async (reg, tmp) => {
    const none = await run(main, reg, tmp, ['--to', 'r-20261029t091000z'], '2026-10-29T09:30:00Z');
    assert.equal(none.code, EXIT.fault, none.text);
    assert.match(none.text, /root:latest does not exist: there is nothing to roll back/);
    await chain(reg, tmp);
    const live = rootAt(reg, 'latest');
    const same = await run(main, reg, tmp, ['--to', 'r-20261029t092000z'], '2026-10-29T09:30:00Z');
    assert.equal(same.code, EXIT.fault, same.text);
    assert.match(same.text, /a rollback goes to an older root: the target has root_seq 3, and the live root 3/);
    assert.equal(rootAt(reg, 'latest').digest, live.digest);
  }));

test("rollback: the new root keeps the live PSL pin, and takes the target's coverage table", () =>
  inRegistry(async (reg, tmp) => {
    await chain(reg, tmp);
    // Root 4 pins a second synthetic list and carries a coverage table; root 2 has neither.
    const list = new TextEncoder().encode('// a second synthetic list\n');
    const x = sha(list).slice(7);
    reg.seed('ref', refTag('psl', x), artifactType('ref'), { 'dev.pkgforge.domains.sha256': x }, [{ title: 'public_suffix_list.dat', bytes: list, mediaType: 'text/plain' }]);
    const file = join(tmp, 'coverage.json');
    writeFileSync(file, JSON.stringify({ as_of: '2026-10-29T00:00:00Z', day: '2026-10-28', pairs: [], gaps: {} }));
    const r4 = await run(promote, reg, tmp, ['--sources', REG, '--psl', refTag('psl', x), '--coverage', file], '2026-10-29T09:25:00Z');
    assert.equal(r4.code, EXIT.ok, r4.text);
    assert.equal(rootAt(reg, 'latest').coverage.day, '2026-10-28');
    const r = await run(main, reg, tmp, ['--to', 'r-20261029t091000z'], '2026-10-29T09:30:00Z');
    assert.equal(r.code, EXIT.ok, r.text);
    const back = rootAt(reg, 'latest');
    assert.equal(back.root.root_seq, 5);
    assert.equal(back.root.psl, x, 'the live pin, not the target root 2 pin');
    assert.deepEqual(back.coverage, EMPTY_COVERAGE, 'the coverage of root 2, which had none');
  }));

test('rollback: a target that names a pack GHCR does not hold is refused, and latest does not move', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    const sources = { format: SOURCES_LAYER_FORMAT, sources: [{ id: 'thc-ct', through: '2026-10-27T00:00:00Z', fetched: null }] };
    // Root 1 names a pack whose manifest the double never received; root 2, live, names none.
    const older = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z', add: [entry('names', 'd', '2026-10-26T00:00:00Z')] });
    const olderDigest = reg.seedRoot(older, { latest: false, sources });
    const newer = buildRoot({ live: { root: older, digest: olderDigest }, psl: PSL_LIVE, now: '2026-10-29T08:10:00Z', gaps: { 'thc-ct': ['2026-10-04'] } });
    const newerDigest = reg.seedRoot(newer, { sources });
    const r = await run(main, reg, tmp, ['--to', 'r-20261029t080000z'], '2026-10-29T09:00:00Z');
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /the rolled-back root names 1 pack\(s\) GHCR does not hold, so latest is left as it is: names:names-d-20261026 sha256:[0-9a-f]{64}/);
    assert.equal(sha(reg.w.manifests.get('root:latest')), newerDigest);
  }));

test('rollback: a re-run writes nothing: unchanged when the target is live already, refused when the gaps alone or the datasets alone moved since', () =>
  inRegistry(async (reg, tmp) => {
    await chain(reg, tmp);
    assert.equal((await run(main, reg, tmp, ['--to', TWO], '2026-10-29T09:30:00Z')).code, EXIT.ok);
    const four = rootAt(reg, 'latest');
    // The re-run of the rollback that landed.
    const same = await run(main, reg, tmp, ['--to', TWO], '2026-10-29T09:35:00Z', '2');
    assert.equal(same.code, EXIT.ok, same.text);
    assert.match(same.text, /unchanged root:latest sha256:[0-9a-f]{64} root_seq 4 already names the datasets and gaps of r-20261029t091000z: nothing written \(re-run, attempt 2\)/);
    assert.equal(rootAt(reg, 'latest').digest, four.digest);
    // A gap promoted after the rollback (root 5): the datasets of root 2, not its gaps.
    assert.equal((await run(promote, reg, tmp, ['--gap', 'thc-ct=2026-10-04', '--sources', REG], '2026-10-29T09:40:00Z')).code, EXIT.ok);
    const five = rootAt(reg, 'latest');
    assert.deepEqual(five.root.datasets, rootAt(reg, TWO).root.datasets);
    assert.deepEqual(five.root.gaps, { 'thc-ct': ['2026-10-04'] });
    const gaps = await run(main, reg, tmp, ['--to', TWO], '2026-10-29T09:45:00Z', '2');
    assert.equal(gaps.code, EXIT.fault, gaps.text);
    assert.match(gaps.text, /a re-run \(attempt 2\) of a rollback is refused: root:latest is root_seq 5, which does not name the datasets and gaps of r-20261029t091000z/);
    assert.equal(rootAt(reg, 'latest').digest, five.digest);
    assert.equal(reg.w.manifests.has('root:r-20261029t094500z'), false);
    // Rolled back to root 2 again (root 6), then a thc-ct segment of day 27 promoted (root 7):
    // the gaps of root 2, other datasets (the review's case).
    assert.equal((await run(main, reg, tmp, ['--to', TWO], '2026-10-29T09:50:00Z')).code, EXIT.ok);
    // Root 6 keeps root 5's entry for day 27, with the at of root 4, the rollback that withdrew it.
    assert.deepEqual(rootAt(reg, 'latest').root.withdrawn, four.root.withdrawn);
    assert.equal(four.root.withdrawn[0]?.at, '2026-10-29T09:30:00Z');
    const seg = await reg.seedPack('obs', 'thc-ct.20261027t000000z.20261027t001000z', { tier: 'seg', start: '2026-10-27T00:00:00Z', end: '2026-10-27T00:10:00Z' });
    assert.equal((await run(promote, reg, tmp, ['--add', seg.ref, '--sources', REG], '2026-10-29T10:00:00Z')).code, EXIT.ok);
    const seven = rootAt(reg, 'latest');
    assert.deepEqual([seven.root.root_seq, seven.root.gaps, tagsOf(seven.root)], [7, {}, ['names-d-20261026', 'thc-ct.20261027t000000z.20261027t001000z']]);
    const rerun = await run(main, reg, tmp, ['--to', TWO], '2026-10-29T10:10:00Z', '2');
    assert.equal(rerun.code, EXIT.fault, rerun.text);
    assert.match(rerun.text, /a re-run \(attempt 2\) of a rollback is refused: root:latest is root_seq 7, which does not name the datasets and gaps of r-20261029t091000z/);
    assert.equal(rootAt(reg, 'latest').digest, seven.digest);
    assert.equal(reg.w.manifests.has('root:r-20261029t101000z'), false);
  }));

test('rollback: the new root withdraws the packs it takes out, and a re-run of the promotion that added one is refused, exit 1, latest unmoved', () =>
  inRegistry(async (reg, tmp) => {
    await chain(reg, tmp);
    const day27 = rootAt(reg, 'latest').root.datasets.names[1];
    assert.equal(day27.tag, 'names-d-20261027');
    assert.equal((await run(main, reg, tmp, ['--to', TWO], '2026-10-29T09:30:00Z')).code, EXIT.ok);
    const four = rootAt(reg, 'latest');
    assert.deepEqual(four.root.withdrawn, [{ manifest: day27.manifest, at: '2026-10-29T09:30:00Z' }]);
    // The re-run (attempt 2) of root 3's promotion, which added day 27.
    const rerun = await run(promote, reg, tmp, ['--add', 'names:names-d-20261027', '--sources', REG], '2026-10-29T09:40:00Z', '2');
    assert.equal(rerun.code, EXIT.fault, rerun.text);
    assert.match(rerun.text, new RegExp(`the addition names:names-d-20261027 \\(${day27.manifest}\\) was withdrawn by the rollback of 2026-10-29T09:30:00Z: a re-run cannot put it back`));
    assert.equal(rootAt(reg, 'latest').digest, four.digest);
    assert.equal(reg.w.manifests.has('root:r-20261029t094000z'), false);
  }));

test('rollback: a pack that only a root between the target and the live root names is withdrawn too, so the re-run of its promotion is refused', () =>
  inRegistry(async (reg, tmp) => {
    reg.seedPsl();
    assert.equal((await run(promote, reg, tmp, ['--psl', PSL_TAG], '2026-10-29T09:00:00Z')).code, EXIT.ok);
    const a = await reg.seedPack('names', 'names-d-20261026', { tier: 'd', start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' });
    assert.equal((await run(promote, reg, tmp, ['--add', a.ref, '--sources', REG], '2026-10-29T09:10:00Z')).code, EXIT.ok);
    // Root 3 adds THC's day segment of day 27; root 4 replaces it by the day pack, which carries thc-ct.
    const seg = await reg.seedPack('obs', 'thc-ct.20261027t000000z.20261028t000000z', { tier: 'seg', start: '2026-10-27T00:00:00Z', end: '2026-10-28T00:00:00Z' });
    assert.equal((await run(promote, reg, tmp, ['--add', seg.ref, '--sources', REG], '2026-10-29T09:20:00Z')).code, EXIT.ok);
    const day = await reg.seedPack('names', 'names-d-20261027', { tier: 'd', start: '2026-10-27T00:00:00Z', end: '2026-10-28T00:00:00Z' });
    const replaced = await run(promote, reg, tmp, ['--replace', `${seg.ref}=${day.ref}`, '--sources', REG], '2026-10-29T09:25:00Z');
    assert.equal(replaced.code, EXIT.ok, replaced.text);
    assert.deepEqual(tagsOf(rootAt(reg, 'latest').root), ['names-d-20261026', 'names-d-20261027']);
    // The rollback to root 2 (root 5): the live root names the day pack, and root 3 alone the segment.
    const r = await run(main, reg, tmp, ['--to', TWO], '2026-10-29T09:30:00Z');
    assert.equal(r.code, EXIT.ok, r.text);
    const five = rootAt(reg, 'latest');
    assert.deepEqual(
      five.root.withdrawn,
      [seg.digest, day.digest].sort().map((manifest) => ({ manifest, at: '2026-10-29T09:30:00Z' })),
    );
    // The re-run (attempt 2) of root 3's promotion, which added the segment: exit 1, latest unmoved.
    const rerun = await run(promote, reg, tmp, ['--add', seg.ref, '--sources', REG], '2026-10-29T09:40:00Z', '2');
    assert.equal(rerun.code, EXIT.fault, rerun.text);
    assert.match(
      rerun.text,
      new RegExp(`the addition obs:thc-ct\\.20261027t000000z\\.20261028t000000z \\(${seg.digest}\\) was withdrawn by the rollback of 2026-10-29T09:30:00Z: a re-run cannot put it back`),
    );
    assert.equal(rootAt(reg, 'latest').digest, five.digest);
    assert.equal(reg.w.manifests.has('root:r-20261029t094000z'), false);
  }));

test('rollback: a malformed GITHUB_RUN_ATTEMPT is exit 2, and nothing is written', () =>
  inRegistry(async (reg, tmp) => {
    await chain(reg, tmp);
    const live = rootAt(reg, 'latest');
    const calls = reg.calls.length;
    for (const attempt of ['abc', '0', '1.5', '', '1e0', ' 2']) {
      const r = await run(main, reg, tmp, ['--to', TWO], '2026-10-29T09:30:00Z', attempt);
      assert.equal(r.code, EXIT.usage, `${JSON.stringify(attempt)}: ${r.text}`);
      assert.match(r.text, new RegExp(`GITHUB_RUN_ATTEMPT ${esc(JSON.stringify(attempt))} is not a whole number of at least 1`), attempt);
      assert.equal(rootAt(reg, 'latest').digest, live.digest, attempt);
    }
    assert.equal(reg.calls.length, calls, 'no oras call: not even the login');
    assert.equal(reg.w.manifests.has('root:r-20261029t093000z'), false);
  }));

test('rollback: a dated root that was pushed and never moved to latest is no target', () =>
  inRegistry(async (reg, tmp) => {
    await chain(reg, tmp);
    // Built on root 1 and pushed at 09:05, as a run refused after its dated push leaves it.
    const one = rootAt(reg, 'r-20261029t090000z');
    const never = buildRoot({ live: { root: one.root, digest: one.digest }, psl: PSL_LIVE, now: '2026-10-29T09:05:00Z', gaps: { 'thc-ct': ['2026-10-04'] } });
    const neverDigest = reg.seedRoot(never, { latest: false });
    const live = rootAt(reg, 'latest');
    const r = await run(main, reg, tmp, ['--to', 'r-20261029t090500z'], '2026-10-29T09:30:00Z');
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(
      r.text,
      new RegExp(
        `the target r-20261029t090500z \\(${neverDigest}, root_seq 2\\) was never live: the chain of previous from ghcr\\.io/pkgforge-dev/domains\\.pkgforge\\.dev/root:latest holds sha256:[0-9a-f]{64} at root_seq 2`,
      ),
    );
    assert.equal(rootAt(reg, 'latest').digest, live.digest);
  }));

test('rollback: bad arguments and a missing token are exit 2', async () => {
  for (const argv of [[], ['--to'], ['--to', 'latest'], ['--to', 'r-20261029T091000Z'], ['--to', 'r-20261029t091000z', 'x']]) {
    const lines = [];
    assert.equal(await main(argv, { env: { GITHUB_ACTOR: 'a', REGISTRY_TOKEN: 't' }, err: (l) => lines.push(l) }), EXIT.usage, argv.join(' '));
  }
  const lines = [];
  assert.equal(await main(['--to', 'r-20261029t091000z'], { env: {}, err: (l) => lines.push(l) }), EXIT.usage);
  assert.match(lines.join('\n'), /GITHUB_ACTOR is not set/);
});
