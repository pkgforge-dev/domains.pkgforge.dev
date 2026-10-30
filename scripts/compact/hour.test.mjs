// scripts/compact/hour.mjs: the hour pack of the feed from segments on disk
// or in GHCR, its manifest, its blobs and the next delta; the verifier passes
// the pack; a re-run finds the tag and writes nothing, and so does a re-run
// of a rebuild whose bytes a build holds (D3 of DOM-023); the output paths
// and each exit code; each refusal is planted alone. Real packs of synthetic
// records (packages/compact/test/daily-helpers.ts).
//
//   node scripts/test.mjs scripts/compact --name "hour cli"
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CompactError } from '@domains/compact';
import { filesSource } from '@domains/compact/node';
import { FeedError } from '@domains/feed';
import { GhcrError, LayoutError, repoOf } from '@domains/ghcr';
import { BloomFilter, HashDelta, hashKey, LedgerError } from '@domains/ledger';
import { FEED_CODEC, FEED_PROVISIONAL, PackError, PackReader } from '@domains/pack';
import { blobsOf, domain, name, PSL, REGISTRY, secs, segment, writeDir } from '../../packages/compact/test/daily-helpers.ts';
import { RateLimitError } from '../ghcr/rate.mjs';
import { Fault } from '../root/lib.mjs';
import { main as verify } from '../verify-pack.mjs';
import { DELTA_FILE, EXIT, main } from './hour.mjs';

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
// `bPsl` is the PSL hash the second oi-nrd window was built under.
async function hourDir(dir, { skip = [], bPsl } = {}) {
  const t = (mmss) => secs(at(mmss));
  const segs = {
    a: await segment('oi-nrd', at('00:00'), at('30:00'), [domain('com.alpha-synthetic', 'oi-nrd', t('01:10')), domain('com.beta-synthetic', 'oi-nrd', t('12:00'))]),
    b: await segment('oi-nrd', at('30:00'), END, [domain('com.beta-synthetic', 'oi-nrd', t('31:00')), domain('net.gamma-synthetic', 'oi-nrd', t('59:59'))], { psl: bPsl }),
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
