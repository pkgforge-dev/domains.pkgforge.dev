// scripts/compact/hour.mjs: the hour pack of the feed from segments on disk
// or in GHCR, its manifest, its blobs and the next delta; the verifier passes
// the pack; a re-run finds the tag and writes nothing, and so does a re-run
// of a rebuild whose bytes a build holds (D3 of DOM-023); the output paths
// and each exit code; each refusal is planted alone. The certificate facts
// (DOM-026): a segment's facts.json makes an old certificate's row suspect,
// and a fresh event of the domain in another segment clears it. Real packs of
// synthetic records (packages/compact/test/daily-helpers.ts).
//
//   node scripts/test.mjs scripts/compact --name "hour cli"
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { encodeFacts, FACTS_MAX_BYTES } from '@domains/adapter';
import { CompactError } from '@domains/compact';
import { filesSource } from '@domains/compact/node';
import { FeedError } from '@domains/feed';
import { GhcrError, LayoutError, repoOf } from '@domains/ghcr';
import { BloomFilter, HashDelta, hashKey, LedgerError } from '@domains/ledger';
import { FEED_CODEC, FEED_PROVISIONAL, FEED_SUSPECT, FEED_SUSPECT_CERT, PackError, PackReader } from '@domains/pack';
import { blobsOf, domain, name, PSL, REGISTRY, secs, segment, segmentFacts, writeDir } from '../../packages/compact/test/daily-helpers.ts';
import { RateLimitError } from '../ghcr/rate.mjs';
import { Fault } from '../root/lib.mjs';
import { main as verify } from '../verify-pack.mjs';
import { bitsOf, DELTA_FILE, EXIT, factsBytes, factsLayerOf, factsTableOf, main, mapAtMost } from './hour.mjs';

async function call(fn, argv, deps = {}) {
  const out = [];
  const err = [];
  const code = await fn(argv, { out: (l) => out.push(l), write: (t) => out.push(t.trimEnd()), err: (l) => err.push(l), sleep: async () => undefined, env: {}, ...deps });
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

async function inTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'compact-hour-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const at = (mmss) => `2026-10-27T05:${mmss}Z`;
const END = '2026-10-27T06:00:00Z';

// The segments of 2026-10-27 05:00 to 06:00 on disk, the registry, an empty
// tag list, and a filter as of the day's start that holds com.alpha-synthetic.
// `bPsl` is the PSL hash the second oi-nrd window was built under. `facts`
// gives the facts of the windows a and b, as the draft's rows or as the
// layer's bytes (SegmentOptions.facts).
async function hourDir(dir, { skip = [], bPsl, facts = {} } = {}) {
  const t = (mmss) => secs(at(mmss));
  const factsOf = (k) => (facts[k] === undefined ? {} : { facts: facts[k] });
  const segs = {
    a: await segment('oi-nrd', at('00:00'), at('30:00'), [domain('com.alpha-synthetic', 'oi-nrd', t('01:10')), domain('com.beta-synthetic', 'oi-nrd', t('12:00'))], factsOf('a')),
    b: await segment('oi-nrd', at('30:00'), END, [domain('com.beta-synthetic', 'oi-nrd', t('31:00')), domain('net.gamma-synthetic', 'oi-nrd', t('59:59'))], { psl: bPsl, ...factsOf('b') }),
    names: await segment('ct-le', at('00:00'), END, [name('com.alpha-synthetic.www', 'ct-le', t('02:00'))], { dataset: 'names' }),
    day: await segment('isc-new', at('00:00'), END, [domain('com.isc-synthetic', 'isc-new', 299)]),
  };
  const segments = join(dir, 'segments');
  for (const [k, s] of Object.entries(segs)) if (!skip.includes(k)) writeDir(segments, s);
  const registry = join(dir, 'sources.json');
  writeFileSync(registry, JSON.stringify({ format: 'domains.sources.v1', sources: REGISTRY }));
  const tags = join(dir, 'tags.json');
  writeFileSync(tags, '[]');
  const f = BloomFilter.forKeys(10, { asOf: secs('2026-10-27T00:00:00Z') });
  f.add(hashKey('com.alpha-synthetic'));
  const filter = join(dir, 'filter.dlbf');
  writeFileSync(filter, f.encode());
  const delta = join(dir, 'delta.dlbd');
  writeFileSync(delta, HashDelta.empty(f).encode());
  return { segs, segments, registry, tags, filter, delta, f };
}

const args = (h, out, more = []) => ['--hour', '2026102705', '--filter', h.filter, '--delta', h.delta, '--sources', h.registry, '--tags', h.tags, '--run', '7', '--out', out, ...more];

// verify-pack.mjs on the pack written to `out`, every check of `require` asked.
async function verifyOut(out, require) {
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  const ann = { ...manifest.annotations };
  // The synthetic registry is not config/sources.json: the checks that read it are not asked for.
  for (const k of ['dev.pkgforge.domains.source', 'dev.pkgforge.domains.precision']) delete ann[k];
  const annPath = join(out, '..', `${out.split(/[\\/]/).at(-1)}.annotations.json`);
  writeFileSync(annPath, JSON.stringify(ann));
  const blobs = JSON.parse(readFileSync(join(out, 'blobs.json'), 'utf8'));
  return call(verify, [...blobs.filter((b) => b.file !== null).map((b) => b.file), '--annotations', annPath, '--require', require]);
}

test('hour cli: writes the pack with its time copy, the manifest, the blobs and the next delta; the verifier passes the pack', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir);
    const out = join(dir, 'out');
    const r = await call(main, args(h, out, ['--segments', h.segments]));
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out[0], 'verdict ready feed:feed-h-2026102705 2026-10-27T05:00:00Z 2026-10-27T06:00:00Z');
    assert.equal(r.out.filter((l) => l.startsWith('input obs:oi-nrd.')).length, 2);
    assert.match(r.text, /^skip obs:ct-le\.\S+ a names segment/m);
    assert.match(r.text, /^skip obs:isc-new\.\S+ the source isc-new is of day precision/m);
    // No segment carries facts.json.
    assert.match(r.text, /^facts 0 0$/m);
    assert.match(r.out.at(-1), /^hour feed:feed-h-2026102705 sha256:[0-9a-f]{64} rows 2 domains 3 delta 0 to 2$/);
    assert.match(r.text, /^wrote \S+delta\.dlbd: state:ledger-delta, 2 hash\(es\), \d+ B, pushed after feed:feed-h-2026102705$/m);
    assert.deepEqual(readdirSync(out).sort(), ['blobs.json', DELTA_FILE, 'idx', 'manifest.json', 'part.000', 'time.idx', 'time.part.000']);
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    const a = manifest.annotations;
    assert.deepEqual(
      [
        a['dev.pkgforge.domains.tier'],
        a['dev.pkgforge.domains.span.start'],
        a['dev.pkgforge.domains.source'],
        a['dev.pkgforge.domains.precision'],
        a['dev.pkgforge.domains.run'],
        a['dev.pkgforge.domains.count'],
      ],
      ['h', '2026-10-27T05:00:00Z', 'oi-nrd', 'second', '7', '2'],
    );
    assert.deepEqual(
      JSON.parse(readFileSync(join(out, 'blobs.json'), 'utf8')).map((b) => b.title),
      ['config', 'part.000', 'idx', 'time.part.000', 'time.idx'],
    );
    // The rows: provisional, the domains the filter did not hold.
    const src = filesSource([join(out, 'part.000')]);
    const reader = await PackReader.open(new Uint8Array(readFileSync(join(out, 'idx'))), src.source, FEED_CODEC, { partSizes: src.sizes });
    const rows = [];
    for await (const row of reader.scan()) rows.push([row.key, row.feedFlags]);
    await src.close();
    assert.deepEqual(rows, [
      ['com.beta-synthetic', FEED_PROVISIONAL],
      ['net.gamma-synthetic', FEED_PROVISIONAL],
    ]);
    // The next delta pairs with the filter and holds the two.
    const delta = HashDelta.decode(new Uint8Array(readFileSync(join(out, DELTA_FILE))));
    assert.deepEqual([delta.filterAsOf, delta.filterCrc, delta.size], [h.f.asOf, h.f.crc, 2]);
    assert.equal(delta.has(hashKey('net.gamma-synthetic')), true);
    const v = await verifyOut(out, 'dataset,length,count,sha256,time');
    assert.equal(v.code, 0, v.text);
    assert.match(v.text, /^VERDICT ok/m);
  }));

const SHA256 = 'dev.pkgforge.domains.sha256';
const OTHER_SHA = 'e'.repeat(64);

// A GHCR double for the manifests of the feed package's builds: `builds` maps
// a tag to the manifest's JSON, or to an error to throw. Each read is logged.
function buildsReader(builds) {
  const asked = [];
  return {
    asked,
    getManifest: async (repo, tag) => {
      asked.push(`manifest ${repo}:${tag}`);
      const json = repo === repoOf('feed') ? builds[tag] : undefined;
      if (json instanceof Error) throw json;
      if (json === undefined) throw new GhcrError('missing', 'MANIFEST_UNKNOWN', 404);
      return {
        repo,
        ref: tag,
        digest: `sha256:${'0'.repeat(64)}`,
        bytes: new TextEncoder().encode(JSON.stringify(json)),
        contentType: 'application/vnd.oci.image.manifest.v1+json',
        json,
        from: 'registry',
      };
    },
  };
}

test('hour cli: a re-run finds the tag present and writes nothing, the delta neither; --rebuild takes -r2; an output that exists is exit 2', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir);
    writeFileSync(h.tags, JSON.stringify(['feed-h-2026102704', 'feed-h-2026102705']));
    const out = join(dir, 'out');
    const r = await call(main, args(h, out, ['--segments', h.segments]));
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out.at(-1), 'present feed:feed-h-2026102705 (feed-h-2026102705): nothing is written, the delta neither');
    assert.equal(existsSync(out), false);
    // The build of the hour holds other bytes: the rebuild takes the next tag.
    const reader = buildsReader({ 'feed-h-2026102705': { annotations: { [SHA256]: OTHER_SHA } } });
    const again = await call(main, args(h, out, ['--segments', h.segments, '--rebuild']), { reader });
    assert.equal(again.code, EXIT.ok, again.text);
    assert.match(again.out.at(-1), /^hour feed:feed-h-2026102705-r2 sha256:/);
    assert.deepEqual(reader.asked, ['manifest pkgforge-dev/domains.pkgforge.dev/feed:feed-h-2026102705']);
    const twice = await call(main, args(h, out, ['--segments', h.segments, '--rebuild']), { reader });
    assert.equal(twice.code, EXIT.usage, twice.text);
    assert.match(twice.text, /holds files: hour writes into a new directory/);
  }));

// D3 of DOM-023: a re-run of a rebuild whose push succeeded finds the build
// that holds its bytes by dev.pkgforge.domains.sha256, and pushes no second
// copy under the next tag.
test('hour cli: a re-run of a rebuild whose bytes a build already holds writes nothing, the delta neither: present', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir);
    const first = join(dir, 'first');
    assert.equal((await call(main, args(h, first, ['--segments', h.segments]))).code, EXIT.ok);
    const built = JSON.parse(readFileSync(join(first, 'manifest.json'), 'utf8'));
    const sha = built.annotations[SHA256];
    assert.match(sha, /^[0-9a-f]{64}$/);
    writeFileSync(h.tags, JSON.stringify(['feed-h-2026102705']));
    const out = join(dir, 'again');
    const reader = buildsReader({ 'feed-h-2026102705': built });
    const r = await call(main, args(h, out, ['--segments', h.segments, '--rebuild']), { reader });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out.at(-1), `present feed:feed-h-2026102705 (feed-h-2026102705): that build holds the bytes of this rebuild, sha256 ${sha}; no index, manifest, blobs.json or delta is written`);
    for (const f of ['idx', 'time.idx', 'manifest.json', 'blobs.json', DELTA_FILE]) assert.equal(existsSync(join(out, f)), false, f);
    assert.deepEqual(reader.asked, ['manifest pkgforge-dev/domains.pkgforge.dev/feed:feed-h-2026102705']);
    // An earlier rebuild, -r2, pushed these bytes; the first build holds others.
    writeFileSync(h.tags, JSON.stringify(['feed-h-2026102705', 'feed-h-2026102705-r2']));
    const r2 = await call(main, args(h, join(dir, 'r2'), ['--segments', h.segments, '--rebuild']), {
      reader: buildsReader({ 'feed-h-2026102705': { annotations: { [SHA256]: OTHER_SHA } }, 'feed-h-2026102705-r2': built }),
    });
    assert.equal(r2.code, EXIT.ok, r2.text);
    assert.match(r2.out.at(-1), /^present feed:feed-h-2026102705-r2 \(feed-h-2026102705, feed-h-2026102705-r2\): that build holds the bytes of this rebuild/);
  }));

test('hour cli: a build the tag list names whose manifest GHCR does not give, or that carries no sha256, is exit 1 at a rebuild, and nothing is written', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir);
    writeFileSync(h.tags, JSON.stringify(['feed-h-2026102705']));
    for (const [i, [build, why]] of [
      [
        new GhcrError('missing', 'MANIFEST_UNKNOWN', 404),
        /^hour: FAIL fault the tag list of pkgforge-dev\/domains\.pkgforge\.dev\/feed names the build feed-h-2026102705, whose manifest GHCR does not give with no credential \(MANIFEST_UNKNOWN\): the build is lost/m,
      ],
      [new GhcrError('refused', 'DENIED', 403), /^hour: FAIL fault the tag list of .* names the build feed-h-2026102705, whose manifest GHCR does not give with no credential \(DENIED\)/m],
      [{ annotations: {} }, /^hour: FAIL fault the build feed:feed-h-2026102705 carries dev\.pkgforge\.domains\.sha256 null, not 64 lowercase hex digits/m],
    ].entries()) {
      const out = join(dir, `o${i}`);
      const r = await call(main, args(h, out, ['--segments', h.segments, '--rebuild']), { reader: buildsReader({ 'feed-h-2026102705': build }) });
      assert.equal(r.code, EXIT.fault, r.text);
      assert.ok(!r.out.includes('PRIVATE PACKAGE'), r.text);
      assert.match(r.text, why);
      for (const f of ['idx', 'manifest.json', 'blobs.json', DELTA_FILE]) assert.equal(existsSync(join(out, f)), false, f);
    }
  }));

test('hour cli: a source whose segments leave a hole is exit 3, and nothing is written', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir, { skip: ['b'] });
    const out = join(dir, 'out');
    const r = await call(main, args(h, out, ['--segments', h.segments]));
    assert.equal(r.code, EXIT.wait, r.text);
    assert.match(r.text, /^missing oi-nrd 2026-10-27T05:30:00Z 2026-10-27T06:00:00Z$/m);
    assert.equal(existsSync(out), false);
    // No segment of a second source: skip, exit 0, nothing written.
    const none = await hourDir(join(dir, 'none'), { skip: ['a', 'b'] });
    const s = await call(main, args(none, out, ['--segments', none.segments]));
    assert.equal(s.code, EXIT.ok, s.text);
    assert.match(s.text, /^verdict skip /m);
    assert.equal(existsSync(out), false);
  }));

test('hour cli: a filter newer than the hour, or a delta of another filter, is exit 1 before any segment is read', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir);
    const nowhere = join(dir, 'no-segments');
    const newer = BloomFilter.forKeys(10, { asOf: secs('2026-10-28T00:00:00Z') });
    writeFileSync(h.filter, newer.encode());
    writeFileSync(h.delta, HashDelta.empty(newer).encode());
    const r = await call(main, args(h, join(dir, 'out'), ['--segments', nowhere]));
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /hour: FAIL plan the filter holds the domains table through 2026-10-28T00:00:00Z, after the hour starts/);
    const other = BloomFilter.forKeys(10, { asOf: secs('2026-10-27T00:00:00Z') });
    other.add(hashKey('com.other-synthetic'));
    writeFileSync(h.filter, h.f.encode());
    writeFileSync(h.delta, HashDelta.empty(other).encode());
    const p = await call(main, args(h, join(dir, 'out'), ['--segments', nowhere]));
    assert.equal(p.code, EXIT.fault, p.text);
    assert.match(p.text, /hour: FAIL pair the delta pairs with the filter of as_of/);
  }));

test('hour cli: a segment that crosses the hour or an idx that is not its manifest is exit 1; bad arguments are exit 2', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir);
    const across = await segment('oi-nrd', '2026-10-27T04:55:00Z', at('05:00'), [domain('com.x-synthetic', 'oi-nrd', secs(at('01:00')))]);
    writeDir(h.segments, across);
    const r = await call(main, args(h, join(dir, 'out'), ['--segments', h.segments]));
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /hour: FAIL straddle the segment oi-nrd\.\S+ \(2026-10-27T04:55:00Z to 2026-10-27T05:05:00Z\) crosses an edge of the hour/);
    rmSync(join(h.segments, across.tag), { recursive: true });
    writeFileSync(join(h.segments, h.segs.a.tag, 'idx'), h.segs.b.idx);
    const idx = await call(main, args(h, join(dir, 'out'), ['--segments', h.segments]));
    assert.equal(idx.code, EXIT.fault, idx.text);
    assert.match(idx.text, /hour: FAIL plan the idx given for oi-nrd\.\S+ is \d+ B hashing to sha256:[0-9a-f]{64}; its manifest names/);
    for (const argv of [
      ['--hour', '2026102705', '--filter', h.filter, '--out', join(dir, 'o'), '--segments', h.segments, '--run', '7'],
      args(h, join(dir, 'o')),
      args(h, join(dir, 'o'), ['--segments', h.segments, '--obs-tags', 'oi-nrd.x']),
      ['--hour', '2026102725', '--filter', h.filter, '--delta', h.delta, '--out', join(dir, 'o'), '--segments', h.segments, '--run', '7'],
      ['--hour', '2026102705', '--filter', h.filter, '--delta', h.delta, '--out', join(dir, 'o'), '--segments', h.segments],
      args(h, join(dir, 'o'), ['--segments', h.segments, '--rebuild=yes']),
    ]) {
      const u = await call(main, argv);
      assert.equal(u.code, EXIT.usage, `${argv.join(' ')}\n${u.text}`);
    }
    // A run id off its grammar (WORKFLOW_RUN_ID): a leading zero, 21 digits, a letter, local.
    for (const run of ['0', '01', '1e3', `1${'0'.repeat(20)}`, 'local']) {
      const u = await call(main, ['--hour', '2026102705', '--filter', h.filter, '--delta', h.delta, '--out', join(dir, 'o'), '--segments', h.segments, '--run', run]);
      assert.equal(u.code, EXIT.usage, run);
      assert.match(u.text, /is not a workflow run id/, run);
    }
  }));

test('hour cli: segments built under two PSL hashes are exit 1, FAIL psl, and nothing is written', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir, { bPsl: 'f'.repeat(64) });
    const out = join(dir, 'out');
    const r = await call(main, args(h, out, ['--segments', h.segments]));
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, new RegExp(`hour: FAIL psl the segments were built under ${PSL} and ${'f'.repeat(64)}; a feed key is a registrable domain under one list`));
    assert.equal(existsSync(out), false);
  }));

test('hour cli: a tag list GHCR cut short is exit 1, and nothing is written, the delta neither', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir);
    const out = join(dir, 'out');
    const argv = args(h, out, ['--segments', h.segments]).filter((a, i, all) => a !== '--tags' && all[i - 1] !== '--tags');
    const reader = { listTags: async () => ({ tags: [], pages: 10_000, truncated: true }) };
    const r = await call(main, argv, { reader });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /hour: FAIL fault the tag list of pkgforge-dev\/domains\.pkgforge\.dev\/feed was cut at 10000 pages: a build of the hour may be among the tags not read/);
    assert.equal(existsSync(out), false);
  }));

// A GHCR double for the obs and feed packages: manifests by tag, blobs by
// digest, read by range, as packages/ghcr's reader answers them.
function ghcrDouble(segs, { feedTags = [], refuse = false } = {}) {
  const manifests = new Map();
  const blobs = new Map();
  for (const s of segs) {
    manifests.set(s.tag, s);
    for (const [d, b] of blobsOf(s)) blobs.set(d, b);
  }
  const asked = [];
  return {
    asked,
    getManifest: async (repo, tag) => {
      asked.push(`manifest ${repo}:${tag}`);
      if (refuse) throw new GhcrError('refused', 'DENIED', 403);
      const s = manifests.get(tag);
      if (s === undefined || repo !== repoOf('obs')) throw new GhcrError('missing', 'MANIFEST_UNKNOWN', 404);
      return { repo, ref: tag, digest: s.digest, bytes: new TextEncoder().encode(s.text), contentType: 'application/vnd.oci.image.manifest.v1+json', json: s.json, from: 'registry' };
    },
    readRange: async (repo, digest, start, end) => {
      asked.push(`blob ${repo} ${digest.slice(7, 19)}`);
      const b = blobs.get(digest);
      if (b === undefined) throw new GhcrError('missing', 'BLOB_UNKNOWN', 404);
      return { bytes: b.subarray(start, end), status: 206 };
    },
    listTags: async (repo) => {
      asked.push(`tags ${repo}`);
      return { tags: feedTags, pages: 1, truncated: false };
    },
  };
}

test('hour cli: segments and tags read from GHCR with no credential give the bytes the files give; a refused read is exit 4', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir);
    const local = join(dir, 'local');
    assert.equal((await call(main, args(h, local, ['--segments', h.segments]))).code, EXIT.ok);
    const segs = Object.values(h.segs);
    const reader = ghcrDouble(segs);
    const remote = join(dir, 'remote');
    const argv = ['--hour', '2026102705', '--filter', h.filter, '--delta', h.delta, '--sources', h.registry, '--run', '7', '--out', remote, '--obs-tags', segs.map((s) => s.tag).join(',')];
    const r = await call(main, argv, { reader });
    assert.equal(r.code, EXIT.ok, r.text);
    for (const f of ['manifest.json', 'idx', 'part.000', 'time.idx', 'time.part.000', DELTA_FILE]) assert.deepEqual(readFileSync(join(remote, f)), readFileSync(join(local, f)), f);
    assert.ok(reader.asked.includes('tags pkgforge-dev/domains.pkgforge.dev/feed'));
    assert.ok(reader.asked.some((l) => l.startsWith('blob pkgforge-dev/domains.pkgforge.dev/obs ')));
    // The tag of the hour listed in GHCR: present.
    const present = await call(main, [...argv.slice(0, -4), '--out', join(dir, 'p'), '--obs-tags', segs.map((s) => s.tag).join(',')], {
      reader: ghcrDouble(segs, { feedTags: ['feed-h-2026102705'] }),
    });
    assert.equal(present.code, EXIT.ok, present.text);
    assert.match(present.out.at(-1), /^present feed:feed-h-2026102705/);
    const refused = await call(main, [...argv.slice(0, -4), '--out', join(dir, 'q'), '--obs-tags', segs[0].tag], { reader: ghcrDouble(segs, { refuse: true }) });
    assert.equal(refused.code, EXIT.private, refused.text);
    assert.equal(refused.out.at(-1), 'PRIVATE PACKAGE');
  }));

test('hour cli: an output directory that is a file, or under a file, is exit 2 before anything is read', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir);
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    // A read of GHCR is a defect here, exit 70: the outputs are checked first.
    const reader = {
      getManifest: async () => {
        throw new TypeError('a read before the outputs were checked');
      },
    };
    for (const [out, why] of [
      [file, /^hour: --out .*file: .*file is a file, not a directory$/m],
      [join(file, 'sub', 'deeper'), /^hour: --out .*deeper: .*file is a file, not a directory$/m],
    ]) {
      const r = await call(main, args(h, out, ['--obs-tags', h.segs.a.tag]), { reader });
      assert.equal(r.code, EXIT.usage, r.text);
      assert.match(r.text, why);
    }
  }));

// Each output path the system refuses once the arguments are checked: the
// double changes the disk between the check and the write.
test('hour cli: an output found unwritable only at the write is exit 2: --out made a file after the check, the directory gone before the index, a written file that exists', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir);
    const noTags = (argv) => argv.filter((a, i, all) => a !== '--tags' && all[i - 1] !== '--tags');
    // --out is made a file once the tags are read: freshDir meets ENOTDIR.
    const madeFile = join(dir, 'made-file');
    const listTags = async () => {
      writeFileSync(madeFile, 'x');
      return { tags: [], pages: 1, truncated: false };
    };
    const f = await call(main, noTags(args(h, madeFile, ['--segments', h.segments])), { reader: { listTags } });
    assert.equal(f.code, EXIT.usage, f.text);
    assert.match(f.text, /^hour: --out .*made-file cannot be written: ENOTDIR /m);
    // The build of the hour listed holds other bytes, so the rebuild writes; the
    // double removes --out while its manifest is read: the index meets ENOENT.
    writeFileSync(h.tags, JSON.stringify(['feed-h-2026102705']));
    const gone = join(dir, 'gone');
    const removing = buildsReader({ 'feed-h-2026102705': { annotations: { [SHA256]: OTHER_SHA } } });
    const read = removing.getManifest;
    removing.getManifest = async (...a) => {
      rmSync(gone, { recursive: true, force: true });
      return read(...a);
    };
    const g = await call(main, args(h, gone, ['--segments', h.segments, '--rebuild']), { reader: removing });
    assert.equal(g.code, EXIT.usage, g.text);
    assert.match(g.text, /^hour: the output file .*gone[\\/]idx cannot be written: ENOENT /m);
    // The double writes idx first: the write of idx meets EEXIST.
    const taken = join(dir, 'taken');
    const writing = buildsReader({ 'feed-h-2026102705': { annotations: { [SHA256]: OTHER_SHA } } });
    const get = writing.getManifest;
    writing.getManifest = async (...a) => {
      writeFileSync(join(taken, 'idx'), 'x');
      return get(...a);
    };
    const t = await call(main, args(h, taken, ['--segments', h.segments, '--rebuild']), { reader: writing });
    assert.equal(t.code, EXIT.usage, t.text);
    assert.match(t.text, /^hour: .*taken[\\/]idx exists: hour writes into a new directory$/m);
    for (const x of ['manifest.json', 'blobs.json', DELTA_FILE]) assert.equal(existsSync(join(taken, x)), false, x);
  }));

test('hour cli: each error class has its exit code: a defect 70, a segment not public 4, GHCR unreachable 2, a usage error 2, a fault 1', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir);
    const cases = [
      [new TypeError('a defect'), EXIT.internal, /^hour: internal error: TypeError: a defect/m],
      [new GhcrError('refused', 'DENIED', 403), EXIT.private, /^PRIVATE PACKAGE$/m],
      [new GhcrError('missing', 'MANIFEST_UNKNOWN', 404), EXIT.private, /^hour: a segment did not read with no credential: MANIFEST_UNKNOWN$/m],
      [new GhcrError('unreachable', 'no route to ghcr.io'), EXIT.usage, /^hour: no route to ghcr\.io$/m],
      [new RateLimitError('429 past the cap'), EXIT.usage, /^hour: 429 past the cap$/m],
      [new LayoutError('a tag that is not one'), EXIT.usage, /^hour: a tag that is not one$/m],
      [new CompactError('usage', 'a call out of bounds'), EXIT.usage, /^hour: FAIL usage a call out of bounds$/m],
      [new CompactError('straddle', 'a segment across the edge'), EXIT.fault, /^hour: FAIL straddle a segment across the edge$/m],
      [new PackError('crc', 'an index that does not read'), EXIT.fault, /^hour: FAIL crc an index that does not read$/m],
      [new LedgerError('pair', 'a delta of another filter'), EXIT.fault, /^hour: FAIL pair a delta of another filter$/m],
      [new FeedError('window', 'a row outside the hour'), EXIT.fault, /^hour: FAIL window a row outside the hour$/m],
      [new Fault('a tag list cut short'), EXIT.fault, /^hour: FAIL fault a tag list cut short$/m],
    ];
    for (const [i, [e, code, line]] of cases.entries()) {
      const reader = {
        getManifest: async () => {
          throw e;
        },
      };
      const r = await call(main, args(h, join(dir, `o${i}`), ['--obs-tags', h.segs.a.tag]), { reader });
      assert.equal(r.code, code, `${e.name} ${e.message}\n${r.text}`);
      assert.match(r.text, line);
    }
  }));

// ---- the certificate facts (DOM-026, docs/format.md section 19) -------------

const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
const esc = (s) => s.replaceAll('.', '\\.');

// The rows of the hour pack written to `out`: each key and its feed flags.
async function rowsOut(out) {
  const src = filesSource([join(out, 'part.000')]);
  const reader = await PackReader.open(new Uint8Array(readFileSync(join(out, 'idx'))), src.source, FEED_CODEC, { partSizes: src.sizes });
  const rows = [];
  for await (const row of reader.scan()) rows.push([row.key, row.feedFlags]);
  await src.close();
  return rows;
}

// Window a saw com.beta-synthetic under a certificate of 30 days, window b
// under one of 2 minutes; window b saw net.gamma-synthetic under one of 10 days.
const OLD = { key: 'com.beta-synthetic', cert_age: 2_592_000 };
const FACTS = {
  a: [OLD],
  b: [
    { key: 'com.beta-synthetic', cert_age: 120 },
    { key: 'net.gamma-synthetic', cert_age: 864_000 },
  ],
};
const SUSPECT = FEED_PROVISIONAL | FEED_SUSPECT | FEED_SUSPECT_CERT;

test("hour cli: a segment's facts.json makes the row of an old-certificate domain suspect with bit 4, and a fresh event in another segment of the hour clears it; GHCR gives the same pack", () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir, { facts: FACTS });
    const out = join(dir, 'out');
    const r = await call(main, args(h, out, ['--segments', h.segments]));
    assert.equal(r.code, EXIT.ok, r.text);
    // Both windows carry facts.json; their merge names two keys.
    assert.match(r.text, /^facts 2 2$/m);
    assert.deepEqual(await rowsOut(out), [
      ['com.beta-synthetic', FEED_PROVISIONAL],
      ['net.gamma-synthetic', SUSPECT],
    ]);
    // The hour pack carries no facts.json of its own: the day pack takes the segments'.
    assert.deepEqual(
      JSON.parse(readFileSync(join(out, 'blobs.json'), 'utf8')).map((b) => b.title),
      ['config', 'part.000', 'idx', 'time.part.000', 'time.idx'],
    );
    const v = await verifyOut(out, 'dataset,length,count,sha256,time');
    assert.equal(v.code, 0, v.text);
    // Window a's facts alone: com.beta-synthetic's only age is 30 days.
    const onlyA = await hourDir(join(dir, 'a'), { facts: { a: [OLD] } });
    const a = await call(main, args(onlyA, join(dir, 'a-out'), ['--segments', onlyA.segments]));
    assert.equal(a.code, EXIT.ok, a.text);
    assert.match(a.text, /^facts 1 1$/m);
    assert.deepEqual(await rowsOut(join(dir, 'a-out')), [
      ['com.beta-synthetic', SUSPECT],
      ['net.gamma-synthetic', FEED_PROVISIONAL],
    ]);
    // From GHCR: the layer read by the digest its segment's manifest names.
    const segs = Object.values(h.segs);
    const reader = ghcrDouble(segs);
    const remote = join(dir, 'remote');
    const argv = [
      '--hour',
      '2026102705',
      '--filter',
      h.filter,
      '--delta',
      h.delta,
      '--sources',
      h.registry,
      '--tags',
      h.tags,
      '--run',
      '7',
      '--out',
      remote,
      '--obs-tags',
      segs.map((s) => s.tag).join(','),
    ];
    const g = await call(main, argv, { reader });
    assert.equal(g.code, EXIT.ok, g.text);
    for (const f of ['manifest.json', 'idx', 'part.000', 'time.idx', 'time.part.000', DELTA_FILE]) assert.deepEqual(readFileSync(join(remote, f)), readFileSync(join(out, f)), f);
    for (const s of [h.segs.a, h.segs.b]) assert.ok(reader.asked.includes(`blob ${repoOf('obs')} ${sha(s.extra[0].bytes).slice(7, 19)}`), s.tag);
  }));

test('hour cli: a manifest that names facts.json without the file is exit 2; a facts.json not its manifest names, one that does not read, or one of another bit is exit 1; a facts blob GHCR does not give is exit 4; nothing is written', () =>
  inTmp(async (dir) => {
    const h = await hourDir(dir, { facts: FACTS });
    const path = join(h.segments, h.segs.a.tag, 'facts.json');
    unlinkSync(path);
    const gone = await call(main, args(h, join(dir, 'gone'), ['--segments', h.segments]));
    assert.equal(gone.code, EXIT.usage, gone.text);
    assert.match(gone.text, new RegExp(`^hour: \\S+facts\\.json does not exist, and the manifest of ${esc(h.segs.a.tag)} names the layer facts\\.json$`, 'm'));
    assert.equal(existsSync(join(dir, 'gone')), false);
    writeFileSync(path, segmentFacts('oi-nrd', [{ key: 'com.beta-synthetic', cert_age: 1 }]));
    const other = await call(main, args(h, join(dir, 'other'), ['--segments', h.segments]));
    assert.equal(other.code, EXIT.fault, other.text);
    assert.match(
      other.text,
      new RegExp(`^hour: FAIL fault \\S+facts\\.json is \\d+ B hashing to sha256:[0-9a-f]{64}; the manifest of ${esc(h.segs.a.tag)} names its facts\\.json as \\d+ B, sha256:`, 'm'),
    );
    assert.equal(existsSync(join(dir, 'other')), false);
    // Each layer below is the one its manifest names, and is refused for what it says.
    for (const [name, bytes, why] of [
      ['bit', segmentFacts('oi-nrd-confirmed', [OLD]), /^hour: FAIL fault obs:oi-nrd\.\S+: its facts\.json gives "com\.beta-synthetic" the source bit 3; the pack is of the source bit\(s\) 1$/m],
      [
        'order',
        new TextEncoder().encode('{"facts":[["com.b",{"1":{}}],["com.a",{"1":{}}]],"format":"domains.facts.v1"}\n'),
        /^hour: FAIL fault obs:oi-nrd\.\S+: its facts\.json does not read: order: /m,
      ],
    ]) {
      const p = await hourDir(join(dir, name), { facts: { a: bytes } });
      const x = await call(main, args(p, join(dir, `${name}-out`), ['--segments', p.segments]));
      assert.equal(x.code, EXIT.fault, `${name}\n${x.text}`);
      assert.match(x.text, why, name);
      assert.equal(existsSync(join(dir, `${name}-out`)), false, name);
    }
    // From GHCR, the facts blob of window a is not given: a segment that does not read.
    const segs = Object.values((await hourDir(join(dir, 'g'), { facts: FACTS })).segs);
    const reader = ghcrDouble(segs);
    const blob = reader.readRange;
    const lost = sha(segs[0].extra[0].bytes);
    reader.readRange = async (repo, digest, start, end) => {
      if (digest === lost) throw new GhcrError('missing', 'BLOB_UNKNOWN', 404);
      return blob(repo, digest, start, end);
    };
    const g = await call(
      main,
      [
        '--hour',
        '2026102705',
        '--filter',
        h.filter,
        '--delta',
        h.delta,
        '--sources',
        h.registry,
        '--tags',
        h.tags,
        '--run',
        '7',
        '--out',
        join(dir, 'g-out'),
        '--obs-tags',
        segs.map((s) => s.tag).join(','),
      ],
      { reader },
    );
    assert.equal(g.code, EXIT.private, g.text);
    assert.equal(g.out.at(-1), 'PRIVATE PACKAGE');
    assert.equal(existsSync(join(dir, 'g-out')), false);
  }));

// factsLayerOf, which hour.mjs and day.mjs both read a manifest's facts.json through.
test('hour cli: a manifest that names two layers facts.json, or one of another media type, is a fault; one that names none has no facts', () => {
  const layer = (title, mediaType = 'application/json') => ({ mediaType, digest: `sha256:${'a'.repeat(64)}`, size: 9, annotations: { 'org.opencontainers.image.title': title } });
  assert.equal(factsLayerOf({ layers: [layer('part.000', 'application/octet-stream'), layer('idx', 'application/octet-stream')] }, 'obs:x'), null);
  assert.deepEqual(factsLayerOf({ layers: [layer('idx', 'application/octet-stream'), layer('facts.json')] }, 'obs:x'), layer('facts.json'));
  assert.throws(
    () => factsLayerOf({ layers: [layer('facts.json'), layer('facts.json')] }, 'obs:x'),
    (e) => e instanceof Fault && e.message === 'obs:x names 2 layers facts.json; a pack carries one',
  );
  assert.throws(
    () => factsLayerOf({ layers: [layer('facts.json', 'application/octet-stream')] }, 'obs:x'),
    (e) => e instanceof Fault && e.message === 'obs:x: its layer facts.json is "application/octet-stream", not application/json',
  );
});

// ---------------------------------------------------------------- the review of DOM-026
// The facts readers that hour.mjs and day.mjs share, each guard at its edge
// (the guard mutation found the first bit of the first key alone held, half
// of the blob's integrity, and mapAtMost's stop unheld).
const layerOf = (rows) => encodeFacts(new Map(rows.map(([key, bits]) => [key, new Map(bits.map((b) => [b, { cert_age: 5 }]))])));

test('hour cli: a facts.json bit outside the pack sources is a fault in any key and at any place in a key; a source with no row or no bit is a fault', () => {
  const bits = new Set([1]);
  assert.equal(
    factsTableOf(
      layerOf([
        ['com.a', [1]],
        ['com.b', [1]],
      ]),
      bits,
      'obs:x',
    ).size,
    2,
  );
  for (const rows of [
    [['com.a', [1, 3]]],
    [
      ['com.a', [1]],
      ['com.b', [3]],
    ],
    [
      ['com.a', [1]],
      ['com.b', [1, 3]],
    ],
  ])
    assert.throws(
      () => factsTableOf(layerOf(rows), bits, 'obs:x'),
      (e) => e instanceof Fault && /its facts\.json gives "com\.[ab]" the source bit 3; the pack is of the source bit\(s\) 1$/.test(e.message),
      JSON.stringify(rows),
    );
  assert.deepEqual(
    [
      ...bitsOf(
        [
          { id: 'oi-nrd', bit: 1 },
          { id: 'thc-ct', bit: 0 },
        ],
        ['oi-nrd', 'thc-ct'],
        'obs:x',
      ),
    ].sort(),
    [0, 1],
  );
  for (const registry of [[{ id: 'oi-nrd', bit: null }], [{ id: 'thc-ct', bit: 0 }]])
    assert.throws(
      () => bitsOf(registry, ['oi-nrd'], 'obs:x'),
      (e) => e instanceof Fault && e.message === 'obs:x: the source oi-nrd has no row with a bit in the registry',
      JSON.stringify(registry),
    );
});

test('hour cli: a facts.json of --inputs is held to both the size and the digest its manifest names; a GHCR descriptor past FACTS_MAX_BYTES is a fault before any read', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'hour-facts-'));
  try {
    const bytes = layerOf([['com.a', [1]]]);
    mkdirSync(join(dir, 'seg'));
    writeFileSync(join(dir, 'seg', 'facts.json'), bytes);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    assert.deepEqual(await factsBytes({ size: bytes.length, digest }, 'seg', { dir }), new Uint8Array(bytes));
    // The same size with other bytes, and the right digest with another size.
    const flipped = Uint8Array.from(bytes);
    flipped[3] ^= 1;
    writeFileSync(join(dir, 'seg', 'facts.json'), flipped);
    await assert.rejects(
      factsBytes({ size: bytes.length, digest }, 'seg', { dir }),
      (e) => e instanceof Fault && /hashing to sha256:[0-9a-f]{64}; the manifest of seg names its facts\.json as/.test(e.message),
    );
    writeFileSync(join(dir, 'seg', 'facts.json'), bytes);
    await assert.rejects(factsBytes({ size: bytes.length + 1, digest }, 'seg', { dir }), (e) => e instanceof Fault && new RegExp(`is ${bytes.length} B hashing to ${digest}`).test(e.message));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const reader = { readRange: () => assert.fail('nothing is read past the cap') };
  await assert.rejects(
    factsBytes({ size: FACTS_MAX_BYTES + 1, digest: `sha256:${'a'.repeat(64)}` }, 'seg', { repo: 'obs', reader, deps: {} }),
    (e) => e instanceof Fault && new RegExp(`is ${FACTS_MAX_BYTES + 1} B; a layer here is 1 B to ${FACTS_MAX_BYTES} B$`).test(e.message),
  );
});

test('hour cli: mapAtMost answers in order, at most `limit` at once, and starts no item after a failure', async () => {
  let running = 0;
  let most = 0;
  const out = await mapAtMost([5, 1, 3, 2], 2, async (x, i) => {
    running += 1;
    most = Math.max(most, running);
    await new Promise((ok) => setTimeout(ok, x));
    running -= 1;
    return x * 10 + i;
  });
  assert.deepEqual(out, [50, 11, 32, 23]);
  assert.equal(most, 2);
  const started = [];
  await assert.rejects(
    mapAtMost(['fail', 'slow', 'c', 'd', 'e'], 2, async (x) => {
      started.push(x);
      if (x === 'fail') throw new Error('planted');
      await new Promise((ok) => setTimeout(ok, 20));
      return x;
    }),
    /planted/,
  );
  // The rejection comes at once; the worker on 'slow' ends 20 ms later and must start nothing then.
  await new Promise((ok) => setTimeout(ok, 100));
  assert.deepEqual(started, ['fail', 'slow']);
});
