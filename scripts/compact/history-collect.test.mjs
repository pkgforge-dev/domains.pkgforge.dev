import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { FACTS_TITLE } from '@domains/adapter';
import { dayOf, QUARANTINED_INPUTS_ANNOTATION, SUMMARY_TITLE } from '@domains/compact';
import { MANIFEST_LIMIT_BYTES, tierTag } from '@domains/ghcr';
import { IDX_TITLE, TIME_IDX_TITLE, VERIFY_ANNOTATIONS } from '@domains/pack';
import { TIER_ANNOTATION } from '@domains/root';
import { BIT, blobsOf, dayNo, domain, entryOf, factsExtra, PSL, REGISTRY, secs, segment, segmentFacts, tierPack } from '../../packages/compact/test/daily-helpers.ts';
import { HISTORY_CHUNK_BYTES } from './history-collect.mjs';
import { HISTORY_PLAN_FORMAT } from './history-plan.mjs';
import { main } from './history.mjs';

const TITLE = 'org.opencontainers.image.title';
const RAW = 'raw.txt.gz';
const SETTINGS = { sources: ['oi-nrd'], psl: PSL };
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const id = (value) => hash(JSON.stringify(value));
const iso = (day) => `2026-11-${String(day).padStart(2, '0')}`;
const json = (path) => JSON.parse(readFileSync(path));

function manifest(p, change = {}) {
  const next = { ...p.json, ...change };
  // Preserve a representation that would change if the collector re-encoded it.
  const text = `${JSON.stringify(next, null, 1)}\r\n`;
  return { ...p, json: next, digest: hash(text), text };
}

const describe = (title, bytes) => ({ mediaType: 'application/octet-stream', digest: hash(bytes), size: bytes.length, annotations: { [TITLE]: title } });

async function fixture(t, { large = false, week = false } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'history-collect-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const day = dayOf(iso(2));
  const span = { start: day.start, end: week ? dayOf(iso(8)).end : day.end };
  const facts = large ? Buffer.alloc(HISTORY_CHUNK_BYTES + 17, 42) : segmentFacts('thc-ct', []);
  const seg = await segment('thc-ct', day.start, day.end, [domain('com.added', 'thc-ct', dayNo(day.date))], { facts });
  const late = manifest(seg, { layers: [...seg.json.layers, describe(RAW, Buffer.from('unused raw bytes'))] });
  const prior = await tierPack('domains', 'd', dayOf(iso(1)).start, [], { ...SETTINGS, extra: [factsExtra(segmentFacts('oi-nrd', []))] });
  const added = [prior, late];
  const replay = [];
  const targets = [];
  for (let date = 2; date <= (week ? 8 : 2); date += 1) {
    const { start } = dayOf(iso(date));
    const firstSeen = secs(start) + 1;
    const old = date === 2;
    const domains = await tierPack('domains', 'd', start, old ? [domain('com.existing', 'oi-nrd', firstSeen)] : [], SETTINGS);
    const feed = await tierPack('feed', 'd', start, old ? [{ key: 'com.existing', flags: 0, firstSeen, sources: [BIT['oi-nrd']], basis: 0, confidence: 0, feedFlags: 0 }] : [], {
      ...SETTINGS,
      extra: [{ title: SUMMARY_TITLE, mediaType: 'application/json', bytes: Buffer.from('{}\n') }],
    });
    added.push(domains, feed);
    replay.push({ date: iso(date), domains: (old ? [domains, late] : [domains]).map((p) => entryOf(p).pack), carry: entryOf(feed).pack });
    if (!old) continue;
    for (const p of [domains, feed]) {
      const target = week
        ? manifest(
            { ...p, tag: tierTag(p.dataset, 'w', span.start) },
            {
              annotations: { ...p.json.annotations, [TIER_ANNOTATION]: 'w', [VERIFY_ANNOTATIONS.spanEnd]: span.end },
            },
          )
        : p;
      if (week) added.push(target);
      targets.push({ ...entryOf(target), days: Array.from({ length: week ? 7 : 1 }, (_, i) => iso(i + 2)) });
    }
  }
  const plan = {
    format: HISTORY_PLAN_FORMAT,
    root: { digest: hash('pinned root'), seq: 1, psl: PSL },
    span,
    tags: added.map((p) => p.tag),
    evidence: {},
    earlier: [entryOf(prior).pack],
    replay,
    targets,
    downstream: [],
  };
  const planPath = join(home, 'plan.json');
  const archive = join(home, 'archive');
  const manifestReads = [];
  const ranges = [];
  const manifests = new Map();
  const blobs = new Map();
  for (const p of added) {
    const { repo } = entryOf(p).pack;
    manifests.set(`${repo}/${p.digest}`, Buffer.from(p.text));
    for (const [digest, bytes] of blobsOf(p)) blobs.set(`${repo}/${digest}`, bytes);
  }
  const reader = {
    async getManifest(repo, digest, options) {
      const key = `${repo}/${digest}`;
      assert.equal(options.maxBytes, MANIFEST_LIMIT_BYTES);
      assert.ok(manifests.has(key), key);
      manifestReads.push(key);
      return { bytes: manifests.get(key) };
    },
    async readRange(repo, digest, from, to) {
      const key = `${repo}/${digest}`;
      const bytes = blobs.get(key);
      assert.ok(bytes !== undefined && to > from && to <= bytes.length, key);
      assert.ok(to - from <= HISTORY_CHUNK_BYTES, key);
      ranges.push({ key, from, to });
      return { bytes: bytes.subarray(from, to) };
    },
  };
  function save(contents = plan, digest = id(contents)) {
    writeFileSync(planPath, JSON.stringify({ id: digest, plan: contents }));
  }
  save();
  return { home, archive, planPath, plan, save, reader, manifests, blobs, manifestReads, ranges, added, prior, late };
}

async function call(f, argv) {
  const stdout = [];
  const stderr = [];
  const code = await main(argv, { reader: f.reader, out: (line) => stdout.push(line), err: (line) => stderr.push(line) });
  return { code, stdout, error: stderr.join('\n') };
}

const collect = (f, ...flags) => call(f, ['collect', '--plan', f.planPath, '--out', f.archive, ...flags]);

test('collect preflight counts immutable weekly inputs, then bounded reads install only replay files and target manifests', async (t) => {
  const f = await fixture(t, { week: true, large: true });
  const preflight = await collect(f, '--preflight');
  assert.equal(preflight.code, 0, preflight.error);
  const counts = JSON.parse(preflight.stdout[0]);
  assert.equal(counts.mode, 'preflight');
  assert.equal(counts.manifestReads, f.added.length);
  assert.equal(
    counts.manifestBytesRead,
    f.added.reduce((sum, pack) => sum + Buffer.byteLength(pack.text), 0),
  );
  assert.equal(counts.installed, 0);
  assert.equal(f.manifestReads.length, f.added.length);
  assert.equal(f.ranges.length, 0);
  assert.equal(existsSync(f.archive), false);

  f.manifestReads.length = 0;
  const collected = await collect(f);
  assert.equal(collected.code, 0, collected.error);
  const report = JSON.parse(collected.stdout[0]);
  assert.deepEqual(report, { ...counts, mode: 'collect', installed: counts.files });
  assert.equal(f.manifestReads.length, report.manifestReads);
  assert.equal(f.ranges.length, report.missingRanges);
  assert.equal(
    f.ranges.reduce((sum, range) => sum + range.to - range.from, 0),
    report.missingBlobBytes,
  );
  const facts = f.late.json.layers.find((layer) => layer.annotations[TITLE] === FACTS_TITLE);
  assert.deepEqual(
    f.ranges.filter((range) => range.key.endsWith(facts.digest)).map(({ from, to }) => [from, to]),
    [
      [0, HISTORY_CHUNK_BYTES],
      [HISTORY_CHUNK_BYTES, HISTORY_CHUNK_BYTES + 17],
    ],
  );
  for (const { tag, text } of f.added) assert.deepEqual(readFileSync(join(f.archive, tag, 'manifest.json')), Buffer.from(text));
  for (const { pack } of f.plan.targets) assert.deepEqual(readdirSync(join(f.archive, pack.tag)), ['manifest.json']);
  assert.equal(existsSync(join(f.archive, f.late.tag, RAW)), false);
  assert.equal(existsSync(join(f.archive, f.prior.tag, FACTS_TITLE)), false);
  const carry = join(f.archive, f.plan.replay[0].carry.tag);
  assert.equal(existsSync(join(carry, TIME_IDX_TITLE)), false);
  assert.equal(existsSync(join(carry, SUMMARY_TITLE)), false);

  f.manifestReads.length = 0;
  f.ranges.length = 0;
  const retry = await collect(f);
  assert.equal(retry.code, 0, retry.error);
  assert.deepEqual(JSON.parse(retry.stdout[0]), { ...report, manifestReads: 0, manifestBytesRead: 0, missingRanges: 0, missingBlobBytes: 0, installed: 0, reused: counts.files });
  assert.deepEqual([f.manifestReads, f.ranges], [[], []]);
});

test('a failed blob install leaves no unverified file and a retry furnishes the offline build', async (t) => {
  const f = await fixture(t);
  const { repo, idx } = entryOf(f.late).pack;
  const key = `${repo}/${idx.digest}`;
  const correct = f.blobs.get(key);
  const bad = Buffer.from(correct);
  bad[0] ^= 1;
  f.blobs.set(key, bad);
  const failed = await collect(f);
  assert.equal(failed.code, 1, failed.error);
  assert.match(failed.error, /expected \d+ B at sha256:.*read \d+ B at sha256:/);
  assert.deepEqual(readdirSync(join(f.archive, f.late.tag)), ['manifest.json']);
  f.blobs.set(key, correct);
  f.manifestReads.length = 0;
  const retry = await collect(f);
  assert.equal(retry.code, 0, retry.error);
  const report = JSON.parse(retry.stdout[0]);
  assert.equal(report.reused, 4);
  assert.equal(report.reused + report.installed, report.files);
  assert.equal(
    f.manifestReads.some((item) => item.endsWith(f.late.digest)),
    false,
  );

  f.manifestReads.length = 0;
  f.ranges.length = 0;
  const output = join(f.home, 'build');
  const registry = join(f.home, 'sources.json');
  writeFileSync(registry, JSON.stringify({ sources: REGISTRY }));
  const built = await call(f, ['build', '--plan', f.planPath, '--inputs', f.archive, '--out', output, '--sources', registry, '--run', '1']);
  assert.equal(built.code, 0, built.error);
  const result = json(join(output, 'history-build.json'));
  assert.equal(result.publicationReady, false);
  assert.match(readFileSync(join(output, 'changes.ndjson'), 'utf8'), /"kind":"added","key":"com.added"/);
  assert.deepEqual([f.manifestReads, f.ranges], [[], []]);
});

test('collect refuses a changed or unsupported plan and path collisions before registry reads', async (t) => {
  const f = await fixture(t);
  f.save({ ...f.plan, tags: [] }, id(f.plan));
  const changed = await collect(f);
  assert.equal(changed.code, 1, changed.error);
  assert.match(changed.error, /history plan digest/);
  f.save({ ...f.plan, format: 'later' });
  const unsupported = await collect(f);
  assert.equal(unsupported.code, 1, unsupported.error);
  assert.match(unsupported.error, /complete historical compaction plan/);
  f.save({ ...f.plan, earlier: [...f.plan.earlier, { ...f.plan.earlier[0], manifest: hash('conflicting ref') }] });
  const collision = await collect(f);
  assert.equal(collision.code, 1, collision.error);
  assert.match(collision.error, /conflicting immutable archive references/);
  f.save();
  const duplicate = await collect(f, '--preflight', '--preflight');
  assert.equal(duplicate.code, 2, duplicate.error);
  assert.match(duplicate.error, /--preflight is given twice/);
  assert.deepEqual([f.manifestReads, f.ranges], [[], []]);
  assert.equal(existsSync(f.archive), false);
  const occupied = join(f.archive, f.late.tag);
  mkdirSync(f.archive);
  writeFileSync(occupied, 'keep this file');
  const occupiedResult = await collect(f);
  assert.equal(occupiedResult.code, 1, occupiedResult.error);
  assert.match(occupiedResult.error, /archive path must be a real directory/);
  assert.equal(readFileSync(occupied, 'utf8'), 'keep this file');
  assert.deepEqual([f.manifestReads, f.ranges], [[], []]);

  const outside = join(f.home, 'outside');
  mkdirSync(outside);
  const linked = join(f.home, 'linked');
  symlinkSync(outside, linked, 'junction');
  const linkResult = await collect({ ...f, archive: linked });
  assert.equal(linkResult.code, 1, linkResult.error);
  assert.match(linkResult.error, /archive path must be a real directory/);
  assert.deepEqual(readdirSync(outside), []);
  assert.deepEqual([f.manifestReads, f.ranges], [[], []]);
});

test('collect refuses altered remote manifests, conflicting planned descriptors and corrupt local files without overwrite', async (t) => {
  const f = await fixture(t);
  const { repo, manifest: ref } = entryOf(f.late).pack;
  const key = `${repo}/${ref}`;
  const correct = f.manifests.get(key);
  f.manifests.set(key, Buffer.concat([correct, Buffer.from(' ')]));
  const changed = await collect(f);
  assert.equal(changed.code, 1, changed.error);
  assert.match(changed.error, /manifest bytes do not match planned immutable digest/);
  f.manifests.set(key, correct);
  const late = f.plan.replay[0].domains[1];
  late.idx.digest = hash('changed descriptor');
  f.save();
  const conflict = await collect(f);
  assert.equal(conflict.code, 1, conflict.error);
  assert.match(conflict.error, /idx.*expected \d+ B/);
  assert.equal(existsSync(f.archive), false);
  assert.deepEqual(f.ranges, []);

  late.idx.digest = entryOf(f.late).pack.idx.digest;
  f.save();
  const good = await collect(f);
  assert.equal(good.code, 0, good.error);
  const local = join(f.archive, f.late.tag, IDX_TITLE);
  const corrupted = Buffer.from(readFileSync(local));
  corrupted[0] ^= 1;
  writeFileSync(local, corrupted);
  f.ranges.length = 0;
  const refused = await collect(f, '--preflight');
  assert.equal(refused.code, 1, refused.error);
  assert.match(refused.error, /idx.*expected \d+ B/);
  assert.deepEqual(readFileSync(local), corrupted);
  assert.deepEqual(f.ranges, []);
});

test('collect refuses same-title archive layers and days with unrecoverable quarantined input before pulling blobs', async (t) => {
  const f = await fixture(t);
  const { repo } = entryOf(f.late).pack;
  const duplicate = manifest(f.late, { layers: [...f.late.json.layers, f.late.json.layers.at(-1)] });
  f.plan.replay[0].domains[1].manifest = duplicate.digest;
  f.manifests.set(`${repo}/${duplicate.digest}`, Buffer.from(duplicate.text));
  f.save();
  const collision = await collect(f);
  assert.equal(collision.code, 1, collision.error);
  assert.match(collision.error, /colliding manifest layer title/);
  f.plan.replay[0].domains[1].manifest = f.late.digest;

  const canonical = f.plan.replay[0].domains[0];
  const base = f.added.find((p) => p.tag === canonical.tag);
  const mixed = manifest(base, { annotations: { ...base.json.annotations, [QUARANTINED_INPUTS_ANNOTATION]: 'old quarantined segment' } });
  canonical.manifest = mixed.digest;
  f.plan.targets.find(({ dataset }) => dataset === 'domains').pack.manifest = mixed.digest;
  f.manifests.set(`${canonical.repo}/${mixed.digest}`, Buffer.from(mixed.text));
  f.save();
  const held = await collect(f);
  assert.equal(held.code, 1, held.error);
  assert.match(held.error, /recover separate canonical quarantine inputs/);
  assert.deepEqual(f.ranges, []);
  assert.equal(existsSync(f.archive), false);
});
