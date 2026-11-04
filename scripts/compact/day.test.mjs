// scripts/compact/day.mjs: the domains day pack, the exact feed of the day
// with its time copy and summary.json, and the ledger's rebuild, from a
// root.json and the packs on disk or a GHCR double; the verifier passes both
// packs; a re-run writes nothing, and so does a re-run of a rebuild whose
// bytes a build holds (D3 of DOM-023); the output paths and each exit code;
// each refusal is planted alone. The certificate facts (DOM-026): the
// segments' facts.json make a feed row suspect and become the domains day
// pack's own layer, which a later feed day reads, at the size of a day of
// oi-nrd and more (settled S1). Real packs of synthetic
// records (packages/compact/test/daily-helpers.ts), a root that buildRoot of
// packages/root validates.
//
//   node scripts/test.mjs scripts/compact --name "day cli"
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { encodeFacts, FACTS_MAX_BYTES, parseFacts } from '@domains/adapter';
import { buildDay, CompactError } from '@domains/compact';
import { filesSource } from '@domains/compact/node';
import { FeedError } from '@domains/feed';
import { GhcrError, LayoutError } from '@domains/ghcr';
import { BloomFilter, HashDelta, hashKey, LedgerError } from '@domains/ledger';
import { FEED_CODEC, FEED_PROVISIONAL, FEED_SUSPECT, FEED_SUSPECT_CERT, PackError, PackReader } from '@domains/pack';
import { buildRoot } from '@domains/root';
import { blobsOf, dayNo, domain, entryOf, factsExtra, PSL, REGISTRY, secs, segment, segmentFacts, tierPack, writeDir } from '../../packages/compact/test/daily-helpers.ts';
import { ROOT } from '../files.mjs';
import { RateLimitError } from '../ghcr/rate.mjs';
import { Fault } from '../root/lib.mjs';
import { main as verify } from '../verify-pack.mjs';
import { DAY_FORMAT, dayFactsLayer, EXIT, main } from './day.mjs';

async function call(fn, argv, deps = {}) {
  const out = [];
  const err = [];
  const code = await fn(argv, { out: (l) => out.push(l), write: (t) => out.push(t.trimEnd()), err: (l) => err.push(l), sleep: async () => undefined, env: {}, ...deps });
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

async function inTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'compact-day-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const T = (hhmmss) => secs(`2026-10-27T${hhmmss}Z`);
const feedRow = (key, hhmmss, feedFlags = FEED_PROVISIONAL) => ({ key, flags: 0, firstSeen: T(hhmmss), sources: [1], basis: 4, confidence: 0, feedFlags });

// The packs on disk under DIR/in, their root.json (buildRoot of packages/root,
// with `gaps`), the registry, and the tags of names and feed.
function rootFiles(dir, packs, { gaps } = {}) {
  const inputs = join(dir, 'in');
  for (const p of packs) writeDir(inputs, p);
  const root = buildRoot({ live: null, psl: PSL, now: '2026-10-28T01:40:00Z', add: packs.map(entryOf), ...(gaps === undefined ? {} : { gaps }) });
  const rootPath = join(dir, 'root.json');
  writeFileSync(rootPath, `${JSON.stringify(root)}\n`);
  const registry = join(dir, 'sources.json');
  writeFileSync(registry, JSON.stringify({ format: 'domains.sources.v1', sources: REGISTRY }));
  const tags = join(dir, 'tags.json');
  writeFileSync(tags, JSON.stringify({ names: ['domains-d-20261026'], feed: [] }));
  return { packs, inputs, root, rootPath, registry, tags };
}

// The live set of 2026-10-27 and the day before, on disk, with its root.json:
// a domains day pack of 2026-10-26; THC's and ISC's day segments of
// 2026-10-27; oi-nrd windows over the rest of the day, the last of them empty,
// and one after midnight; two hour packs of the feed. With `behind`, oi-nrd's
// packs end at 07:00, and its lane is behind its clock. `oiPsl` is the PSL
// hash the first oi-nrd window was built under. `oiFacts` gives the facts of
// the windows of 05:00 (a) and 06:00 (b), as the draft's rows or as the
// layer's bytes (SegmentOptions.facts). `quarantined` names the segments
// pushed quarantined (ruling 23), so the root file marks them: `isc` (ISC's
// day segment) and `b` (oi-nrd's window of 06:00).
async function dayRoot(dir, { behind = false, hour5Rows = null, oiPsl = PSL, oiFacts = {}, quarantined = [] } = {}) {
  const facts = (k) => ({ ...(oiFacts[k] === undefined ? {} : { facts: oiFacts[k] }), ...(quarantined.includes(k) ? { quarantine: true } : {}) });
  const packs = [
    await tierPack('domains', 'd', '2026-10-26T00:00:00Z', [domain('com.old-synthetic', 'thc-ct', dayNo('2026-10-26'))], { sources: ['thc-ct'] }),
    await segment('thc-ct', '2026-10-27T00:00:00Z', '2026-10-28T00:00:00Z', [
      domain('com.old-synthetic', 'thc-ct', 299),
      domain('com.thc-synthetic', 'thc-ct', 299),
      domain('np.com.nepal-synthetic', 'thc-ct', 299),
    ]),
    await segment('oi-nrd', '2026-10-27T05:00:00Z', '2026-10-27T06:00:00Z', [domain('com.fresh-synthetic', 'oi-nrd', T('05:10:00')), domain('net.cert-synthetic', 'oi-nrd', T('05:20:00'))], {
      psl: oiPsl,
      ...facts('a'),
    }),
    await segment('oi-nrd', '2026-10-27T06:00:00Z', '2026-10-27T07:00:00Z', [domain('np.com.nepal-synthetic', 'oi-nrd', T('06:30:00'))], facts('b')),
    ...(behind
      ? []
      : [
          await segment('oi-nrd', '2026-10-27T07:00:00Z', '2026-10-28T00:00:00Z', []),
          await segment('oi-nrd', '2026-10-28T00:00:00Z', '2026-10-28T00:10:00Z', [domain('org.after-midnight-synthetic', 'oi-nrd', secs('2026-10-28T00:05:00Z'))]),
        ]),
    await segment('isc-new', '2026-10-27T00:00:00Z', '2026-10-28T00:00:00Z', [domain('com.early-synthetic', 'isc-new', 290), domain('com.isc-synthetic', 'isc-new', 299)], {
      quarantine: quarantined.includes('isc'),
    }),
    await tierPack(
      'feed',
      'h',
      '2026-10-27T05:00:00Z',
      hour5Rows ?? [feedRow('com.fresh-synthetic', '05:10:00'), feedRow('net.cert-synthetic', '05:20:00', FEED_PROVISIONAL | FEED_SUSPECT | FEED_SUSPECT_CERT)],
      { sources: ['oi-nrd'] },
    ),
    await tierPack('feed', 'h', '2026-10-27T06:00:00Z', [feedRow('com.old-synthetic', '06:01:00')], { sources: ['oi-nrd'] }),
  ];
  return rootFiles(dir, packs);
}

const args = (r, out, ledger, more = []) => [
  '--day',
  '2026-10-27',
  '--root',
  r.rootPath,
  '--inputs',
  r.inputs,
  '--sources',
  r.registry,
  '--tags',
  r.tags,
  '--run',
  '7',
  '--out',
  out,
  ...ledger,
  ...more,
];
const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
// The argv of `args` less --tags FILE: the tags are then read from GHCR.
const noTags = (argv) => argv.filter((a, i, all) => a !== '--tags' && all[i - 1] !== '--tags');
// The argv of `args` less --inputs DIR: the packs are then read from GHCR.
const noInputs = (argv) => argv.filter((a, i, all) => a !== '--inputs' && all[i - 1] !== '--inputs');

const SHA256 = 'dev.pkgforge.domains.sha256';
const OTHER_SHA = 'e'.repeat(64);

// A GHCR double for the manifests of builds: `builds` maps a package (names,
// feed) to its tags, each to the manifest's JSON or to an error to throw.
// Each read is logged.
function buildsReader(builds) {
  const asked = [];
  return {
    asked,
    getManifest: async (repo, tag) => {
      asked.push(`manifest ${repo}:${tag}`);
      const pkg = repo.split('/').at(-1);
      const json = builds[pkg]?.[tag];
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

// A GHCR double that holds every manifest of `packs` in its package by its
// digest, and every blob by digest, less those `drop` names (a pack and its
// manifest's digest, or a blob's).
function packsReader(packs, drop = () => false) {
  const blobs = new Map();
  const manifests = new Map();
  for (const p of packs) {
    if (!drop(p, p.digest)) manifests.set(`${entryOf(p).pack.repo}@${p.digest}`, p);
    for (const [digest, bytes] of blobsOf(p)) if (!drop(p, digest)) blobs.set(digest, bytes);
  }
  return {
    getManifest: async (repo, ref) => {
      const p = manifests.get(`${repo}@${ref}`);
      if (p === undefined) throw new GhcrError('missing', 'MANIFEST_UNKNOWN', 404);
      return { repo, ref, digest: p.digest, bytes: new TextEncoder().encode(p.text), contentType: 'application/vnd.oci.image.manifest.v1+json', json: p.json, from: 'registry' };
    },
    readRange: async (_repo, digest, start, end) => {
      const b = blobs.get(digest);
      if (b === undefined) throw new GhcrError('missing', `GHCR holds no blob ${digest.slice(0, 19)}`, 404);
      return { bytes: new Uint8Array(b.subarray(start, end)), status: 206 };
    },
  };
}

async function rowsOf(dir) {
  const src = filesSource(partFiles(dir));
  const reader = await PackReader.open(new Uint8Array(readFileSync(join(dir, 'idx'))), src.source, FEED_CODEC, { partSizes: src.sizes });
  const rows = [];
  for await (const row of reader.scan()) rows.push([row.key, row.firstSeen - T('00:00:00'), row.feedFlags]);
  await src.close();
  return rows;
}

// The key parts of the pack in `dir`, part.000 on, in order.
const partFiles = (dir) =>
  readdirSync(dir)
    .filter((f) => /^part\.\d{3,}$/.test(f))
    .sort()
    .map((f) => join(dir, f));

// verify-pack.mjs on the pack in `dir`, every check of `require` asked.
async function verifyDir(dir, require) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const ann = { ...manifest.annotations };
  // The synthetic registry is not config/sources.json: the checks that read it are not asked for.
  for (const k of ['dev.pkgforge.domains.source', 'dev.pkgforge.domains.precision']) delete ann[k];
  const annPath = `${dir}.annotations.json`;
  writeFileSync(annPath, JSON.stringify(ann));
  const blobs = JSON.parse(readFileSync(join(dir, 'blobs.json'), 'utf8'));
  // summary.json and facts.json are no layers the verifier reads, as the
  // verify step of compact-daily.yml passes it the parts and indexes alone.
  const files = blobs.filter((b) => b.file !== null && b.title !== 'summary.json' && b.title !== 'facts.json').map((b) => b.file);
  return call(verify, [...files, '--annotations', annPath, '--require', require]);
}

// The pack that day.mjs wrote to `dir` under `tag`, as a pack in memory
// (daily-helpers.ts MemPack): its manifest, its layers, and its extra layers
// but summary.json, so a root can name it and a GHCR double serve it.
function writtenPack(dir, tag, dataset) {
  const text = readFileSync(join(dir, 'manifest.json'), 'utf8');
  const json = JSON.parse(text);
  const titles = json.layers.map((l) => l.annotations['org.opencontainers.image.title']);
  const bytes = (title) => new Uint8Array(readFileSync(join(dir, title)));
  return {
    tag,
    digest: sha(text),
    text,
    json,
    idx: bytes('idx'),
    parts: partFiles(dir).map((f) => new Uint8Array(readFileSync(f))),
    time: null,
    extra: titles.filter((t) => t === 'facts.json').map((title) => ({ title, bytes: bytes(title) })),
    dataset,
  };
}

test('day cli: the domains day pack, the exact feed with its time copy and summary.json, and the first ledger; the verifier passes both packs', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--first-ledger']));
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^verdict domains ready names:domains-d-20261027$/m);
    assert.match(x.text, /^check domains: 7 records, the inputs' 7 distinct keys of 8 records$/m);
    assert.match(x.text, /^wrote names:domains-d-20261027 sha256:[0-9a-f]{64} records 7 parts 1$/m);
    assert.match(x.text, /^exact day 7 new 5 early 1 blocks \d+$/m);
    assert.match(x.text, /^carry hour rows 3 matched 2 carried 1 retracted 1$/m);
    assert.match(x.text, /^wrote feed:feed-d-20261027 sha256:[0-9a-f]{64} records 5 parts 1 time 1$/m);
    // D28 of DOM-029: 7 keys fold the filter to partitions of 64 bits, 7 x 8 B of bits and the 36 B header.
    assert.match(x.text, /^wrote state:ledger-filter-20261027 \S+filter\.dlbf sha256:[0-9a-f]{64} keys 7 partition_bits 64 bytes 92 bits_per_key 64\.00$/m);
    assert.match(x.text, /^wrote state:ledger-delta \S+delta\.dlbd sha256:[0-9a-f]{64} hashes 0 to 0$/m);
    // The replacements the promotion takes: the day's domains inputs, and the two hour packs.
    const report = JSON.parse(readFileSync(join(out, 'day.json'), 'utf8'));
    assert.equal(report.format, DAY_FORMAT);
    const tagOf = new Map(r.root.datasets.domains.concat(r.root.datasets.feed).map((p) => [p.manifest, p.tag]));
    assert.deepEqual(report.domains.replaces.map((m) => tagOf.get(m).split('.')[0]).sort(), ['isc-new', 'oi-nrd', 'oi-nrd', 'oi-nrd', 'thc-ct']);
    assert.deepEqual(
      report.feed.replaces.map((m) => tagOf.get(m)),
      ['feed-h-2026102705', 'feed-h-2026102706'],
    );
    assert.deepEqual(readdirSync(join(out, 'domains')).sort(), ['blobs.json', 'idx', 'manifest.json', 'part.000']);
    assert.deepEqual(readdirSync(join(out, 'feed')).sort(), ['blobs.json', 'idx', 'manifest.json', 'part.000', 'summary.json', 'time.idx', 'time.part.000']);
    assert.deepEqual(await rowsOf(join(out, 'feed')), [
      ['com.fresh-synthetic', 5 * 3600 + 600, 0],
      ['com.isc-synthetic', 0, 0],
      ['com.thc-synthetic', 0, 0],
      ['net.cert-synthetic', 5 * 3600 + 1200, FEED_SUSPECT | FEED_SUSPECT_CERT],
      ['np.com.nepal-synthetic', 0, 0],
    ]);
    // summary.json is a layer of the manifest, by its digest.
    const feed = JSON.parse(readFileSync(join(out, 'feed', 'manifest.json'), 'utf8'));
    const summary = readFileSync(join(out, 'feed', 'summary.json'));
    const layer = feed.layers.at(-1);
    assert.deepEqual([layer.annotations['org.opencontainers.image.title'], layer.mediaType, layer.digest, layer.size], ['summary.json', 'application/json', sha(summary), summary.length]);
    assert.deepEqual(JSON.parse(summary.toString('utf8')).suffixes['com.np'], { new_registrable: 1, suspect: 0, by_source: { 'oi-nrd': 1, 'thc-ct': 1 } });
    assert.deepEqual(feed.annotations['dev.pkgforge.domains.source'], 'isc-new,oi-nrd,thc-ct');
    assert.equal(feed.annotations['dev.pkgforge.domains.tier'], 'd');
    const vd = await verifyDir(join(out, 'domains'), 'dataset,length,count,sha256');
    assert.equal(vd.code, 0, vd.text);
    const vf = await verifyDir(join(out, 'feed'), 'dataset,length,count,sha256,time');
    assert.equal(vf.code, 0, vf.text);
    assert.match(vf.text, /^VERDICT ok/m);
    // The filter holds the table through the day's end; the first delta is empty.
    const filter = BloomFilter.decode(new Uint8Array(readFileSync(join(out, 'ledger', 'filter.dlbf'))));
    assert.equal(filter.asOf, secs('2026-10-28T00:00:00Z'));
    assert.equal(filter.has(hashKey('com.fresh-synthetic')), true);
    assert.equal(HashDelta.decode(new Uint8Array(readFileSync(join(out, 'ledger', 'delta.dlbd')))).size, 0);
  }));

test('day cli: the live delta is rebased onto the new filter: the domains seen after the day stay, those of the day leave', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const old = BloomFilter.forKeys(4, { asOf: secs('2026-10-27T00:00:00Z') });
    old.add(hashKey('com.old-synthetic'));
    const delta = HashDelta.empty(old);
    for (const k of ['com.fresh-synthetic', 'net.cert-synthetic', 'org.after-midnight-synthetic']) delta.add(hashKey(k));
    writeFileSync(join(dir, 'filter.dlbf'), old.encode());
    writeFileSync(join(dir, 'delta.dlbd'), delta.encode());
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--filter', join(dir, 'filter.dlbf'), '--delta', join(dir, 'delta.dlbd')]));
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^wrote state:ledger-delta \S+ sha256:[0-9a-f]{64} hashes 3 to 1$/m);
    const next = HashDelta.decode(new Uint8Array(readFileSync(join(out, 'ledger', 'delta.dlbd'))));
    const filter = BloomFilter.decode(new Uint8Array(readFileSync(join(out, 'ledger', 'filter.dlbf'))));
    assert.deepEqual([next.filterAsOf, next.filterCrc], [filter.asOf, filter.crc]);
    assert.deepEqual([...next.hashes()], [hashKey('org.after-midnight-synthetic')]);
  }));

test('day cli: a re-run writes no pack: each tag present, the ledger present; --no-ledger names that it writes none', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const first = join(dir, 'first');
    assert.equal((await call(main, args(r, first, ['--first-ledger']))).code, EXIT.ok);
    writeFileSync(r.tags, JSON.stringify({ names: ['domains-d-20261026', 'domains-d-20261027'], feed: ['feed-d-20261027'] }));
    const out = join(dir, 'again');
    const x = await call(main, args(r, out, ['--filter', join(first, 'ledger', 'filter.dlbf'), '--delta', join(first, 'ledger', 'delta.dlbd')]));
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^present names:domains-d-20261027 \(domains-d-20261027\): the root does not name it yet/m);
    assert.match(x.text, /^present feed:feed-d-20261027 \(feed-d-20261027\): nothing is written$/m);
    assert.match(x.text, /^present state:ledger-filter-20261027: the live filter holds the table through 2026-10-28T00:00:00Z already/m);
    assert.equal(existsSync(join(out, 'domains', 'manifest.json')), false);
    assert.equal(existsSync(join(out, 'feed')), false);
    assert.equal(existsSync(join(out, 'ledger')), false);
    // --rebuild feed takes the next tag of the feed alone, when its build holds other bytes.
    const reader = buildsReader({ feed: { 'feed-d-20261027': { annotations: { [SHA256]: OTHER_SHA } } } });
    const rebuilt = await call(main, args(r, join(dir, 'rebuilt'), ['--no-ledger', '--rebuild', 'feed']), { reader });
    assert.equal(rebuilt.code, EXIT.ok, rebuilt.text);
    assert.match(rebuilt.text, /^wrote feed:feed-d-20261027-r2 /m);
    assert.match(rebuilt.text, /^present names:domains-d-20261027 /m);
    assert.match(rebuilt.text, /^ledger not asked \(--no-ledger\): no filter and no delta is written$/m);
    assert.deepEqual(reader.asked, ['manifest pkgforge-dev/domains.pkgforge.dev/feed:feed-d-20261027']);
  }));

test('day cli: a day of domains that is not whole is exit 3, and nothing is written', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir, { behind: true });
    const out = join(dir, 'out');
    // oi-nrd's lane has added no pack past 07:00: the hour packs it has yet
    // to add would overlap the day pack.
    const x = await call(main, args(r, out, ['--first-ledger']));
    assert.equal(x.code, EXIT.wait, x.text);
    assert.match(x.text, /^verdict domains wait names:domains-d-20261027$/m);
    assert.match(x.text, /^missing domains 2026-10-27T07:00:00Z 2026-10-28T00:00:00Z the source oi-nrd has no live pack past 2026-10-27T07:00:00Z$/m);
    assert.equal(existsSync(out), false);
  }));

test('day cli: a live filter newer than the day is exit 1 before the root is read; an hour row the day lacks, or an index not the root names, is exit 1', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const newer = BloomFilter.forKeys(4, { asOf: secs('2026-10-29T00:00:00Z') });
    writeFileSync(join(dir, 'filter.dlbf'), newer.encode());
    writeFileSync(join(dir, 'delta.dlbd'), HashDelta.empty(newer).encode());
    const ledger = ['--filter', join(dir, 'filter.dlbf'), '--delta', join(dir, 'delta.dlbd')];
    const noRoot = ['--day', '2026-10-27', '--root', join(dir, 'none.json'), '--run', '7', '--out', join(dir, 'a'), ...ledger];
    const x = await call(main, noRoot);
    assert.equal(x.code, EXIT.fault, x.text);
    assert.match(x.text, /day: FAIL plan the live filter holds the domains table through 2026-10-29T00:00:00Z, after the day ends at 2026-10-28T00:00:00Z/);
    // An hour pack of the feed holds a domain no record of the day holds.
    const orphan = await dayRoot(join(dir, 'orphan'), { hour5Rows: [feedRow('com.fresh-synthetic', '05:10:00'), feedRow('com.nowhere-synthetic', '05:30:00')] });
    const o = await call(main, args(orphan, join(dir, 'b'), ['--no-ledger']));
    assert.equal(o.code, EXIT.fault, o.text);
    assert.match(o.text, /day: FAIL usage buildFeedDay: the hour row "com\.nowhere-synthetic" has no record among the day's records/);
    // The index of an input that is not the one the root names.
    const seg = r.packs[2];
    assert.match(seg.tag, /^oi-nrd./);
    // Another segment's index and part: the part sizes agree, the digest does not.
    writeFileSync(join(r.inputs, seg.tag, 'idx'), r.packs[3].idx);
    writeFileSync(join(r.inputs, seg.tag, 'part.000'), r.packs[3].parts[0]);
    const i = await call(main, args(r, join(dir, 'c'), ['--no-ledger']));
    assert.equal(i.code, EXIT.fault, i.text);
    assert.match(i.text, /day: FAIL .*idx hashes to sha256:[0-9a-f]{64}; the root names obs:oi-nrd\.\S+'s as sha256:/);
  }));

test('day cli: the ledger is named once, and bad arguments are exit 2', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const o = join(dir, 'o');
    for (const [ledger, message] of [
      [[], /name the ledger once/],
      [['--first-ledger', '--no-ledger'], /name the ledger once/],
      [['--filter', join(dir, 'f')], /--filter and --delta are given together/],
      [['--first-ledger', '--rebuild', 'names'], /names "names", not domains or feed/],
      [['--first-ledger', '--ref', 'latest'], /--root and --ref are two roots/],
    ]) {
      const x = await call(main, args(r, o, ledger));
      assert.equal(x.code, EXIT.usage, `${ledger.join(' ')}\n${x.text}`);
      assert.match(x.text, message);
    }
    const bad = await call(main, ['--day', '2026-02-30', '--root', r.rootPath, '--run', '7', '--out', o, '--first-ledger']);
    assert.equal(bad.code, EXIT.usage, bad.text);
    // A run id off its grammar (WORKFLOW_RUN_ID): a leading zero, 21 digits, a letter, local.
    for (const run of ['0', '01', '1e3', `1${'0'.repeat(20)}`, 'local']) {
      const x = await call(main, ['--day', '2026-10-27', '--root', r.rootPath, '--run', run, '--out', o, '--first-ledger']);
      assert.equal(x.code, EXIT.usage, run);
      assert.match(x.text, /is not a workflow run id/, run);
    }
    writeFileSync(join(dir, 'o-file'), 'x');
    const full = await call(main, args(r, dir, ['--first-ledger']));
    assert.equal(full.code, EXIT.usage, full.text);
    assert.match(full.text, /holds files: day writes into a new directory/);
  }));

// day.mjs reads --root through rootOf of plan.mjs, whose UsageError is the one
// class every compaction CLI catches (scripts/root/lib.mjs).
test('day cli: a --root that does not read is exit 2; one that is not JSON, or not a root, is exit 1', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const withRoot = (path, out) => args({ ...r, rootPath: path }, join(dir, out), ['--first-ledger']);
    const none = await call(main, withRoot(join(dir, 'none.json'), 'a'));
    assert.equal(none.code, EXIT.usage, none.text);
    assert.match(none.text, /day: --root .*none\.json does not read/);
    writeFileSync(join(dir, 'not.json'), '{');
    const notJson = await call(main, withRoot(join(dir, 'not.json'), 'b'));
    assert.equal(notJson.code, EXIT.fault, notJson.text);
    assert.match(notJson.text, /day: FAIL fault --root .*not\.json is not JSON/);
    writeFileSync(join(dir, 'not-root.json'), '{"format":"domains.root.v1"}');
    const notRoot = await call(main, withRoot(join(dir, 'not-root.json'), 'c'));
    assert.equal(notRoot.code, EXIT.fault, notRoot.text);
    assert.match(notRoot.text, /day: FAIL fault --root .*not-root\.json: /);
  }));

test('day cli: the tags read from GHCR with no credential: a build of each pack there is present', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const asked = [];
    const reader = {
      listTags: async (repo) => {
        asked.push(repo);
        return { tags: repo.endsWith('/names') ? ['domains-d-20261027'] : ['feed-d-20261027'], pages: 1, truncated: false };
      },
    };
    const argv = noTags(args(r, join(dir, 'out'), ['--no-ledger']));
    const x = await call(main, argv, { reader });
    assert.equal(x.code, EXIT.ok, x.text);
    assert.deepEqual(asked, ['pkgforge-dev/domains.pkgforge.dev/names', 'pkgforge-dev/domains.pkgforge.dev/feed']);
    assert.match(x.text, /^present feed:feed-d-20261027 /m);
  }));

test('day cli: a tag list GHCR cut short is exit 1: a build of the day may be among the tags not read', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const reader = { listTags: async () => ({ tags: [], pages: 10_000, truncated: true }) };
    const out = join(dir, 'out');
    const x = await call(main, noTags(args(r, out, ['--no-ledger'])), { reader });
    assert.equal(x.code, EXIT.fault, x.text);
    assert.match(x.text, /day: FAIL fault the tag list of pkgforge-dev\/domains\.pkgforge\.dev\/names was cut at 10000 pages/);
    assert.equal(existsSync(join(out, 'domains', 'manifest.json')), false);
    assert.equal(existsSync(join(out, 'day.json')), false);
  }));

test('day cli: a day the root names as a gap, with no pack of it, is skip: exit 0, and nothing is written (ruling 24)', () =>
  inTmp(async (dir) => {
    const early = await tierPack('domains', 'd', '2026-10-26T00:00:00Z', [domain('com.old-synthetic', 'thc-ct', dayNo('2026-10-26'))], { sources: ['thc-ct'] });
    const r = rootFiles(dir, [early], { gaps: { 'thc-ct': ['2026-10-27'] } });
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--first-ledger']));
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^verdict domains skip names:domains-d-20261027$/m);
    assert.match(x.text, /^reason domains every day of the unit is a gap the root names: no pack is written \(ruling 24\)$/m);
    assert.equal(x.out.at(-1), 'skip 2026-10-27: nothing is written');
    assert.equal(existsSync(out), false);
  }));

test('day cli: domains inputs built under two PSL hashes are exit 1, FAIL psl, and nothing is written', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir, { oiPsl: 'f'.repeat(64) });
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--first-ledger']));
    assert.equal(x.code, EXIT.fault, x.text);
    assert.match(x.text, new RegExp(`day: FAIL psl the domains inputs were built under ${PSL} and ${'f'.repeat(64)}; their keys depend on the list`));
    assert.equal(existsSync(out), false);
  }));

test('day cli: a live delta of another filter is exit 1, FAIL pair, before the root is read', () =>
  inTmp(async (dir) => {
    const live = BloomFilter.forKeys(4, { asOf: secs('2026-10-27T00:00:00Z') });
    live.add(hashKey('com.old-synthetic'));
    const other = BloomFilter.forKeys(4, { asOf: secs('2026-10-27T00:00:00Z') });
    other.add(hashKey('com.other-synthetic'));
    writeFileSync(join(dir, 'filter.dlbf'), live.encode());
    writeFileSync(join(dir, 'delta.dlbd'), HashDelta.empty(other).encode());
    const out = join(dir, 'out');
    const x = await call(main, ['--day', '2026-10-27', '--root', join(dir, 'none.json'), '--run', '7', '--out', out, '--filter', join(dir, 'filter.dlbf'), '--delta', join(dir, 'delta.dlbd')]);
    assert.equal(x.code, EXIT.fault, x.text);
    assert.match(x.text, /day: FAIL pair the delta pairs with the filter of as_of/);
    assert.equal(existsSync(out), false);
  }));

test('day cli: a day whose feed pack the root names live writes no feed pack, though the tag list holds none', () =>
  inTmp(async (dir) => {
    const packs = [
      await tierPack('domains', 'd', '2026-10-26T00:00:00Z', [domain('com.old-synthetic', 'thc-ct', dayNo('2026-10-26'))], { sources: ['thc-ct'] }),
      await tierPack('domains', 'd', '2026-10-27T00:00:00Z', [domain('com.fresh-synthetic', 'oi-nrd', T('05:10:00')), domain('com.thc-synthetic', 'thc-ct', 299)], { sources: ['oi-nrd', 'thc-ct'] }),
      await tierPack('feed', 'd', '2026-10-27T00:00:00Z', [feedRow('com.fresh-synthetic', '05:10:00', 0)], { sources: ['oi-nrd'] }),
    ];
    const r = rootFiles(dir, packs);
    writeFileSync(r.tags, JSON.stringify({ names: [], feed: [] }));
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--no-ledger']));
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^verdict domains present names:domains-d-20261027$/m);
    assert.match(x.text, /^verdict feed present feed:feed-d-20261027$/m);
    assert.match(x.text, /^present feed:feed-d-20261027: the day's feed is live$/m);
    assert.equal(existsSync(join(out, 'feed')), false);
    const report = JSON.parse(readFileSync(join(out, 'day.json'), 'utf8'));
    assert.deepEqual(report.feed, { action: 'present', tag: 'feed-d-20261027', manifest: packs[2].digest, replaces: [] });
    assert.equal(report.exact, null);
  }));

test('day cli: a time copy that does not bind to its key copy is exit 1, FAIL time, before an index or a manifest is written', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    // The time copy of a feed day pack of 2026-10-20: one row, outside the day.
    const other = await tierPack('feed', 'd', '2026-10-20T00:00:00Z', [{ ...feedRow('com.fresh-synthetic', '05:10:00', 0), firstSeen: secs('2026-10-20T05:10:00Z') }], { sources: ['oi-nrd'] });
    const build = async (input) => {
      const built = await buildDay(input);
      return { ...built, time: { ...built.time, idx: other.time.idx } };
    };
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--no-ledger']), { build });
    assert.equal(x.code, EXIT.fault, x.text);
    assert.match(x.text, /day: FAIL time the time copy /);
    for (const f of ['idx', 'time.idx', 'summary.json', 'manifest.json', 'blobs.json']) assert.equal(existsSync(join(out, 'feed', f)), false, f);
    assert.equal(existsSync(join(out, 'day.json')), false);
  }));

// Ruling 23 through day.mjs: ISC's day segment is pushed quarantined, so the
// root file marks it (quarantine: true, DOM-029). The domains day pack still
// holds its records, since they are served, and names isc-new in its
// quarantined-inputs; the exact join reads the other inputs only, so
// com.isc-synthetic is no row, and the feed pack does not name isc-new
// (AGENTS.md absolute 11).
test('day cli: a quarantined input stays in domains-d and is left out of the exact join: it gives the feed no row, the feed does not name its source, and domains-d names it in quarantined-inputs', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir, { quarantined: ['isc'] });
    const isc = r.root.datasets.domains.find((p) => p.tag.startsWith('isc-new.'));
    assert.equal(isc.quarantine, true, 'the root file carries the mark');
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--no-ledger']));
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^quarantined-inputs names:domains-d-20261027 isc-new$/m);
    assert.match(x.text, new RegExp(`^input domains obs:${isc.tag.replaceAll('.', '\\.')} seg 2026-10-27T00:00:00Z 2026-10-28T00:00:00Z 2 quarantined$`, 'm'));
    assert.match(x.text, new RegExp(`^exact domains: 1 quarantined input\\(s\\) left out of the join \\(ruling 23\\): obs:${isc.tag.replaceAll('.', '\\.')}$`, 'm'));
    assert.match(x.text, /^wrote names:domains-d-20261027 sha256:[0-9a-f]{64} records 7 parts 1$/m);
    const domains = JSON.parse(readFileSync(join(out, 'domains', 'manifest.json'), 'utf8'));
    assert.equal(domains.annotations['dev.pkgforge.domains.source'], 'isc-new,oi-nrd,thc-ct');
    assert.equal(domains.annotations['dev.pkgforge.domains.quarantined-inputs'], 'isc-new');
    assert.match(x.text, /^exact day 5 new 4 early 0 blocks \d+$/m);
    assert.deepEqual(await rowsOf(join(out, 'feed')), [
      ['com.fresh-synthetic', 5 * 3600 + 600, 0],
      ['com.thc-synthetic', 0, 0],
      ['net.cert-synthetic', 5 * 3600 + 1200, FEED_SUSPECT | FEED_SUSPECT_CERT],
      ['np.com.nepal-synthetic', 0, 0],
    ]);
    const feed = JSON.parse(readFileSync(join(out, 'feed', 'manifest.json'), 'utf8'));
    assert.equal(feed.annotations['dev.pkgforge.domains.source'], 'oi-nrd,thc-ct');
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(out, 'feed', 'summary.json'), 'utf8')).suffixes.com.by_source), ['oi-nrd', 'thc-ct']);
  }));

// D3 of DOM-023: a re-run of a rebuild whose push succeeded finds the build
// that holds its bytes by dev.pkgforge.domains.sha256, and writes no second
// copy under the next tag.
test('day cli: a re-run of a rebuild whose bytes a build already holds writes no manifest of either pack: present; a build of other bytes gives -r2', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const first = join(dir, 'first');
    assert.equal((await call(main, args(r, first, ['--first-ledger']))).code, EXIT.ok);
    const domains = JSON.parse(readFileSync(join(first, 'domains', 'manifest.json'), 'utf8'));
    const feed = JSON.parse(readFileSync(join(first, 'feed', 'manifest.json'), 'utf8'));
    writeFileSync(r.tags, JSON.stringify({ names: ['domains-d-20261026', 'domains-d-20261027'], feed: ['feed-d-20261027'] }));
    const out = join(dir, 'again');
    const reader = buildsReader({ names: { 'domains-d-20261027': domains }, feed: { 'feed-d-20261027': feed } });
    const x = await call(main, args(r, out, ['--no-ledger', '--rebuild', 'domains,feed']), { reader });
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(
      x.text,
      new RegExp(`^present names:domains-d-20261027 \\(domains-d-20261027\\): it holds the bytes of this rebuild, sha256 ${domains.annotations[SHA256]}, and the root does not name it yet; `, 'm'),
    );
    assert.match(
      x.text,
      new RegExp(
        `^present feed:feed-d-20261027 \\(feed-d-20261027\\): it holds the bytes of this rebuild, sha256 ${feed.annotations[SHA256]}; no index, manifest or blobs\\.json of it is written$`,
        'm',
      ),
    );
    assert.doesNotMatch(x.text, /^wrote (names|feed):/m);
    for (const f of ['domains/manifest.json', 'domains/blobs.json', 'feed/idx', 'feed/time.idx', 'feed/summary.json', 'feed/manifest.json', 'feed/blobs.json'])
      assert.equal(existsSync(join(out, f)), false, f);
    const report = JSON.parse(readFileSync(join(out, 'day.json'), 'utf8'));
    assert.deepEqual([report.domains.action, report.domains.tag, report.feed.action, report.feed.tag], ['present', 'domains-d-20261027', 'present', 'feed-d-20261027']);
    // domains-d-20261026 is no build of the day: its manifest is not read.
    assert.deepEqual(reader.asked, ['manifest pkgforge-dev/domains.pkgforge.dev/names:domains-d-20261027', 'manifest pkgforge-dev/domains.pkgforge.dev/feed:feed-d-20261027']);
    // Builds of other bytes: each pack takes the next tag of the day.
    const other = { annotations: { [SHA256]: OTHER_SHA } };
    const y = await call(main, args(r, join(dir, 'other'), ['--no-ledger', '--rebuild', 'domains,feed']), {
      reader: buildsReader({ names: { 'domains-d-20261027': other }, feed: { 'feed-d-20261027': other } }),
    });
    assert.equal(y.code, EXIT.ok, y.text);
    assert.match(y.text, /^wrote names:domains-d-20261027-r2 sha256:[0-9a-f]{64} records 7 parts 1$/m);
    assert.match(y.text, /^wrote feed:feed-d-20261027-r2 sha256:[0-9a-f]{64} records 5 parts 1 time 1$/m);
  }));

test('day cli: a build the tag list names whose manifest GHCR does not give, or that carries no sha256, is exit 1 at a rebuild, never PRIVATE PACKAGE', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    writeFileSync(r.tags, JSON.stringify({ names: ['domains-d-20261027'], feed: ['feed-d-20261027'] }));
    for (const [i, [builds, why]] of [
      [
        { names: { 'domains-d-20261027': new GhcrError('missing', 'MANIFEST_UNKNOWN', 404) } },
        /^day: FAIL fault the tag list of pkgforge-dev\/domains\.pkgforge\.dev\/names names the build domains-d-20261027, whose manifest GHCR does not give with no credential \(MANIFEST_UNKNOWN\): the build is lost/m,
      ],
      [
        { names: { 'domains-d-20261027': { annotations: {} } }, feed: { 'feed-d-20261027': new GhcrError('refused', 'DENIED', 403) } },
        /^day: FAIL fault the build names:domains-d-20261027 carries dev\.pkgforge\.domains\.sha256 null, not 64 lowercase hex digits/m,
      ],
      [
        { names: { 'domains-d-20261027': { annotations: { [SHA256]: OTHER_SHA } } }, feed: { 'feed-d-20261027': new GhcrError('refused', 'DENIED', 403) } },
        /^day: FAIL fault the tag list of pkgforge-dev\/domains\.pkgforge\.dev\/feed names the build feed-d-20261027, whose manifest GHCR does not give with no credential \(DENIED\)/m,
      ],
    ].entries()) {
      const out = join(dir, `o${i}`);
      const x = await call(main, args(r, out, ['--no-ledger', '--rebuild', 'domains,feed']), { reader: buildsReader(builds) });
      assert.equal(x.code, EXIT.fault, x.text);
      assert.ok(!x.out.includes('PRIVATE PACKAGE'), x.text);
      assert.match(x.text, why);
      assert.equal(existsSync(join(out, 'feed', 'manifest.json')), false);
      assert.equal(existsSync(join(out, 'day.json')), false);
    }
  }));

test('day cli: the packs read from GHCR with no credential give the files the packs on disk give; a blob the root names that GHCR does not give is exit 1, never PRIVATE PACKAGE', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    assert.equal((await call(main, args(r, join(dir, 'local'), ['--first-ledger']))).code, EXIT.ok);
    const remote = await call(main, noInputs(args(r, join(dir, 'remote'), ['--first-ledger'])), { reader: packsReader(r.packs) });
    assert.equal(remote.code, EXIT.ok, remote.text);
    for (const f of ['domains/manifest.json', 'domains/idx', 'feed/manifest.json', 'feed/time.idx', 'feed/summary.json', 'ledger/filter.dlbf', 'ledger/delta.dlbd', 'day.json']) {
      assert.deepEqual(readFileSync(join(dir, 'remote', f)), readFileSync(join(dir, 'local', f)), f);
    }
    // One blob gone at a time: a day input's part, the base pack's index, an hour pack's part.
    const [base, , seg] = r.packs;
    const hour5 = r.packs.find((p) => p.tag === 'feed-h-2026102705');
    assert.deepEqual([base.tag, seg.tag.split('.')[0]], ['domains-d-20261026', 'oi-nrd']);
    const digestOf = (bytes) => sha(bytes);
    for (const [i, [pack, bytes, named]] of [
      [seg, seg.parts[0], `obs:${seg.tag.replaceAll('.', '\\.')}'s part\\.000`],
      [base, base.idx, "names:domains-d-20261026's idx"],
      [hour5, hour5.parts[0], "feed:feed-h-2026102705's part\\.000"],
    ].entries()) {
      const gone = digestOf(bytes);
      const reader = packsReader(r.packs, (p, d) => p === pack && d === gone);
      const x = await call(main, noInputs(args(r, join(dir, `gone${i}`), ['--first-ledger'])), { reader });
      assert.equal(x.code, EXIT.fault, x.text);
      assert.ok(!x.out.includes('PRIVATE PACKAGE'), x.text);
      assert.match(x.text, new RegExp(`^day: FAIL fault the root names ${named} as ${gone} \\(\\d+ B\\), which GHCR does not give with no credential \\(GHCR holds no blob `, 'm'));
      assert.equal(existsSync(join(dir, `gone${i}`, 'day.json')), false);
    }
  }));

test('day cli: an output directory that is a file, or under a file, is exit 2 before anything is read', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    // A read of the root is a defect here, exit 70: the outputs are checked first.
    const readRoot = async () => {
      throw new TypeError('a read before the outputs were checked');
    };
    for (const [out, why] of [
      [file, /^day: --out .*file: .*file is a file, not a directory$/m],
      [join(file, 'sub', 'deeper'), /^day: --out .*deeper: .*file is a file, not a directory$/m],
    ]) {
      const x = await call(main, args(r, out, ['--first-ledger']), { readRoot });
      assert.equal(x.code, EXIT.usage, x.text);
      assert.match(x.text, why);
    }
  }));

// Each output path the system refuses once the arguments are checked: the
// double changes the disk between the check and the write.
test('day cli: an output found unwritable only at the write is exit 2: --out made a file after the check, a pack directory under a file, the directory gone before the index, a written file that exists', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const realRoot = async () => ({ root: r.root, ref: `sha256:${'0'.repeat(64)}` });
    // --out is made a file once the root is read: freshDir meets ENOTDIR.
    const madeFile = join(dir, 'made-file');
    const a = await call(main, args(r, madeFile, ['--first-ledger']), {
      readRoot: async () => {
        writeFileSync(madeFile, 'x');
        return realRoot();
      },
    });
    assert.equal(a.code, EXIT.usage, a.text);
    assert.match(a.text, /^day: --out .*made-file cannot be written: ENOTDIR /m);
    // --out is made a file once the tags of names are read: the domains directory meets ENOTDIR.
    const swapped = join(dir, 'swapped');
    const b = await call(main, noTags(args(r, swapped, ['--first-ledger'])), {
      reader: {
        listTags: async () => {
          rmSync(swapped, { recursive: true, force: true });
          writeFileSync(swapped, 'x');
          return { tags: [], pages: 1, truncated: false };
        },
      },
    });
    assert.equal(b.code, EXIT.usage, b.text);
    assert.match(b.text, /^day: the output directory .*swapped[\\/]domains cannot be written: ENOTDIR /m);
    // The feed directory is removed once the feed is built: its index meets ENOENT.
    const gone = join(dir, 'gone');
    const c = await call(main, args(r, gone, ['--first-ledger']), {
      build: async (input) => {
        const built = await buildDay(input);
        await input.sink.close();
        await input.time.sink.close();
        rmSync(join(gone, 'feed'), { recursive: true, force: true });
        return built;
      },
    });
    assert.equal(c.code, EXIT.usage, c.text);
    assert.match(c.text, /^day: the output file .*gone[\\/]feed[\\/]idx cannot be written: ENOENT /m);
    // The feed's idx is written first by the double: its write meets EEXIST.
    const taken = join(dir, 'taken');
    const d = await call(main, args(r, taken, ['--first-ledger']), {
      build: async (input) => {
        const built = await buildDay(input);
        writeFileSync(join(taken, 'feed', 'idx'), 'x');
        return built;
      },
    });
    assert.equal(d.code, EXIT.usage, d.text);
    assert.match(d.text, /^day: .*taken[\\/]feed[\\/]idx exists: day writes into a new directory$/m);
    for (const f of ['feed/manifest.json', 'day.json']) assert.equal(existsSync(join(taken, f)), false, f);
  }));

test('day cli: each error class has its exit code: a defect 70, the root not public 4, GHCR unreachable 2, a usage error 2, a fault 1, a delta of another filter 1', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const cases = [
      [new TypeError('a defect'), EXIT.internal, /^day: internal error: TypeError: a defect/m],
      [new GhcrError('refused', 'DENIED', 403), EXIT.private, /^PRIVATE PACKAGE$/m],
      [new GhcrError('missing', 'MANIFEST_UNKNOWN', 404), EXIT.private, /^day: the root did not read with no credential: MANIFEST_UNKNOWN$/m],
      [new GhcrError('unreachable', 'no route to ghcr.io'), EXIT.usage, /^day: no route to ghcr\.io$/m],
      [new RateLimitError('429 past the cap'), EXIT.usage, /^day: 429 past the cap$/m],
      [new LayoutError('a tag that is not one'), EXIT.usage, /^day: a tag that is not one$/m],
      [new CompactError('usage', 'a call out of bounds'), EXIT.usage, /^day: FAIL usage a call out of bounds$/m],
      [new CompactError('straddle', 'a pack across the edge'), EXIT.fault, /^day: FAIL straddle a pack across the edge$/m],
      [new PackError('crc', 'an index that does not read'), EXIT.fault, /^day: FAIL crc an index that does not read$/m],
      [new LedgerError('pair', 'the delta pairs with another filter'), EXIT.fault, /^day: FAIL pair the delta pairs with another filter$/m],
      [new FeedError('window', 'a row outside the day'), EXIT.fault, /^day: FAIL window a row outside the day$/m],
      [new Fault('a root that does not validate'), EXIT.fault, /^day: FAIL fault a root that does not validate$/m],
    ];
    for (const [i, [e, code, line]] of cases.entries()) {
      const readRoot = async () => {
        throw e;
      };
      const x = await call(main, args(r, join(dir, `o${i}`), ['--first-ledger']), { readRoot });
      assert.equal(x.code, code, `${e.name} ${e.message}\n${x.text}`);
      assert.match(x.text, line);
    }
  }));

// ---- the certificate facts (DOM-026, docs/format.md section 19) -------------

const TITLE = 'org.opencontainers.image.title';
// The facts of oi-nrd's windows of 05:00 (a) and 06:00 (b): com.fresh-synthetic
// under a certificate of 30 days, net.cert-synthetic under one of 50 s (its
// hour row is suspect already), np.com.nepal-synthetic under one of 100 s.
const OI_FACTS = {
  a: [
    { key: 'com.fresh-synthetic', cert_age: 2_592_000 },
    { key: 'net.cert-synthetic', cert_age: 50 },
  ],
  b: [{ key: 'np.com.nepal-synthetic', cert_age: 100 }],
};

test("day cli: the segments' facts make a feed day row suspect with bit 4, and the domains day pack carries their merge as facts.json, a layer of its manifest and of blobs.json; GHCR gives the same files", () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir, { oiFacts: OI_FACTS });
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--first-ledger']));
    assert.equal(x.code, EXIT.ok, x.text);
    // Two of the five segment inputs carry facts.json, three keys in all.
    assert.match(x.text, /^facts 2 3$/m);
    assert.deepEqual(readdirSync(join(out, 'domains')).sort(), ['blobs.json', 'facts.json', 'idx', 'manifest.json', 'part.000']);
    const facts = readFileSync(join(out, 'domains', 'facts.json'));
    assert.equal(
      facts.toString('utf8'),
      '{"facts":[["com.fresh-synthetic",{"1":{"cert_age":2592000}}],["net.cert-synthetic",{"1":{"cert_age":50}}],["np.com.nepal-synthetic",{"1":{"cert_age":100}}]],"format":"domains.facts.v1"}\n',
    );
    const manifest = JSON.parse(readFileSync(join(out, 'domains', 'manifest.json'), 'utf8'));
    const layer = manifest.layers.at(-1);
    assert.deepEqual([layer.annotations[TITLE], layer.mediaType, layer.digest, layer.size], ['facts.json', 'application/json', sha(facts), facts.length]);
    // blobs.json names every layer of the manifest, facts.json with its file, for the push.
    const blobs = JSON.parse(readFileSync(join(out, 'domains', 'blobs.json'), 'utf8'));
    assert.deepEqual(
      blobs.slice(1).map((b) => [b.title, b.digest, b.size]),
      manifest.layers.map((l) => [l.annotations[TITLE], l.digest, l.size]),
    );
    assert.equal(blobs.at(-1).file, join(out, 'domains', 'facts.json'));
    // com.fresh-synthetic's only age is 30 days: suspect by its certificate,
    // where the test above with no facts has it 0.
    assert.deepEqual(await rowsOf(join(out, 'feed')), [
      ['com.fresh-synthetic', 5 * 3600 + 600, FEED_SUSPECT | FEED_SUSPECT_CERT],
      ['com.isc-synthetic', 0, 0],
      ['com.thc-synthetic', 0, 0],
      ['net.cert-synthetic', 5 * 3600 + 1200, FEED_SUSPECT | FEED_SUSPECT_CERT],
      ['np.com.nepal-synthetic', 0, 0],
    ]);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'day.json'), 'utf8')).facts, { from: 'segments', layers: 2, keys: 3 });
    const vd = await verifyDir(join(out, 'domains'), 'dataset,length,count,sha256');
    assert.equal(vd.code, 0, vd.text);
    // From GHCR: each segment's manifest by the digest the root names, then its facts.json.
    const remote = await call(main, noInputs(args(r, join(dir, 'remote'), ['--first-ledger'])), { reader: packsReader(r.packs) });
    assert.equal(remote.code, EXIT.ok, remote.text);
    for (const f of ['domains/manifest.json', 'domains/facts.json', 'feed/manifest.json', 'feed/part.000', 'feed/summary.json', 'day.json']) {
      assert.deepEqual(readFileSync(join(dir, 'remote', f)), readFileSync(join(out, f)), f);
    }
  }));

test("day cli: a feed day built from a present domains day pack reads the pack's facts.json, from disk or from GHCR; a present pack with none gives no facts", () =>
  inTmp(async (dir) => {
    const records = [domain('com.fresh-synthetic', 'oi-nrd', T('05:10:00')), domain('com.thc-synthetic', 'thc-ct', 299), domain('net.cert-synthetic', 'oi-nrd', T('05:20:00'))];
    const facts = segmentFacts('oi-nrd', [
      { key: 'com.fresh-synthetic', cert_age: 2_592_000 },
      { key: 'net.cert-synthetic', cert_age: 30 },
    ]);
    const base = await tierPack('domains', 'd', '2026-10-26T00:00:00Z', [domain('com.old-synthetic', 'thc-ct', dayNo('2026-10-26'))], { sources: ['thc-ct'] });
    const live = await tierPack('domains', 'd', '2026-10-27T00:00:00Z', records, { sources: ['oi-nrd', 'thc-ct'], extra: [factsExtra(facts)] });
    const r = rootFiles(dir, [base, live]);
    writeFileSync(r.tags, JSON.stringify({ names: [], feed: [] }));
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--no-ledger']));
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^verdict domains present names:domains-d-20261027$/m);
    assert.match(x.text, /^facts names:domains-d-20261027 2$/m);
    const rows = [
      ['com.fresh-synthetic', 5 * 3600 + 600, FEED_SUSPECT | FEED_SUSPECT_CERT],
      ['com.thc-synthetic', 0, 0],
      ['net.cert-synthetic', 5 * 3600 + 1200, 0],
    ];
    assert.deepEqual(await rowsOf(join(out, 'feed')), rows);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'day.json'), 'utf8')).facts, { from: 'names:domains-d-20261027', layers: 1, keys: 2 });
    // From GHCR: the pack's manifest from names by the digest the root names, then the layer.
    const remote = await call(main, noInputs(args(r, join(dir, 'remote'), ['--no-ledger'])), { reader: packsReader(r.packs) });
    assert.equal(remote.code, EXIT.ok, remote.text);
    for (const f of ['feed/manifest.json', 'feed/part.000', 'feed/time.idx', 'day.json']) assert.deepEqual(readFileSync(join(dir, 'remote', f)), readFileSync(join(out, f)), f);
    // The same day pack with no facts.json: no facts, and no row suspect.
    const bare = rootFiles(join(dir, 'bare'), [base, await tierPack('domains', 'd', '2026-10-27T00:00:00Z', records, { sources: ['oi-nrd', 'thc-ct'] })]);
    writeFileSync(bare.tags, JSON.stringify({ names: [], feed: [] }));
    const y = await call(main, args(bare, join(dir, 'bare-out'), ['--no-ledger']));
    assert.equal(y.code, EXIT.ok, y.text);
    assert.match(y.text, /^facts names:domains-d-20261027 0$/m);
    assert.deepEqual(
      await rowsOf(join(dir, 'bare-out', 'feed')),
      rows.map(([k, t]) => [k, t, 0]),
    );
    // A feed day the root names live reads no facts.
    const both = rootFiles(join(dir, 'both'), [base, live, await tierPack('feed', 'd', '2026-10-27T00:00:00Z', [feedRow('com.fresh-synthetic', '05:10:00', 0)], { sources: ['oi-nrd'] })]);
    const z = await call(main, args(both, join(dir, 'both-out'), ['--no-ledger']));
    assert.equal(z.code, EXIT.ok, z.text);
    assert.doesNotMatch(z.text, /^facts /m);
  }));

test('day cli: a facts.json or a manifest that --inputs lacks is exit 2; a facts.json not its manifest names, one that does not read, one of another bit or one naming a key the day lacks is exit 1; a manifest or a facts blob GHCR does not give is exit 1, never PRIVATE PACKAGE', () =>
  inTmp(async (dir) => {
    const nothingWritten = (out, x) => {
      for (const f of ['domains/manifest.json', 'domains/facts.json', 'feed', 'day.json']) assert.equal(existsSync(join(out, f)), false, `${f}\n${x.text}`);
    };
    const r = await dayRoot(join(dir, 'r'), { oiFacts: OI_FACTS });
    const seg = r.packs[2];
    const thc = r.packs[1];
    assert.deepEqual([seg.tag.split('.')[0], thc.tag.split('.')[0], seg.extra.length], ['oi-nrd', 'thc-ct', 1]);
    const at = (p, f) => join(r.inputs, p.tag, f);
    const esc = (s) => s.replaceAll('.', '\\.');
    // facts.json gone from --inputs, then another layer's bytes in its place.
    unlinkSync(at(seg, 'facts.json'));
    const gone = await call(main, args(r, join(dir, 'gone'), ['--no-ledger']));
    assert.equal(gone.code, EXIT.usage, gone.text);
    assert.match(gone.text, new RegExp(`^day: \\S+facts\\.json does not exist, and the manifest of ${esc(seg.tag)} names the layer facts\\.json$`, 'm'));
    nothingWritten(join(dir, 'gone'), gone);
    writeFileSync(at(seg, 'facts.json'), segmentFacts('oi-nrd', [{ key: 'com.fresh-synthetic', cert_age: 1 }]));
    const other = await call(main, args(r, join(dir, 'other'), ['--no-ledger']));
    assert.equal(other.code, EXIT.fault, other.text);
    assert.match(
      other.text,
      new RegExp(
        `^day: FAIL fault \\S+facts\\.json is \\d+ B hashing to sha256:[0-9a-f]{64}; the manifest of ${esc(seg.tag)} names its facts\\.json as \\d+ B, ${seg.json.layers.at(-1).digest}$`,
        'm',
      ),
    );
    nothingWritten(join(dir, 'other'), other);
    // THC's segment carries no facts.json, and its manifest is still read: the layer is found through it.
    writeFileSync(at(seg, 'facts.json'), seg.extra[0].bytes);
    unlinkSync(at(thc, 'manifest.json'));
    const noManifest = await call(main, args(r, join(dir, 'no-manifest'), ['--no-ledger']));
    assert.equal(noManifest.code, EXIT.usage, noManifest.text);
    assert.match(noManifest.text, new RegExp(`^day: --inputs: \\S+manifest\\.json does not exist: the facts\\.json of obs:${esc(thc.tag)} is found through its manifest$`, 'm'));
    writeFileSync(at(thc, 'manifest.json'), `${thc.text} `);
    const notNamed = await call(main, args(r, join(dir, 'not-named'), ['--no-ledger']));
    assert.equal(notNamed.code, EXIT.fault, notNamed.text);
    assert.match(notNamed.text, new RegExp(`^day: FAIL fault \\S+manifest\\.json hashes to sha256:[0-9a-f]{64}; the root names the manifest of obs:${esc(thc.tag)} as ${thc.digest}$`, 'm'));
    // Each layer below is the one its manifest names, and is refused for what it says.
    const planted = [
      ['bit', segmentFacts('oi-nrd-confirmed', [{ key: 'com.fresh-synthetic', cert_age: 5 }]), /its facts\.json gives "com\.fresh-synthetic" the source bit 3; the pack is of the source bit\(s\) 1$/m],
      ['format', new TextEncoder().encode('{"facts":[],"format":"domains.facts.v0"}\n'), /its facts\.json does not read: format: the format is "domains\.facts\.v0", not domains\.facts\.v1$/m],
      [
        'key',
        segmentFacts('oi-nrd', [{ key: 'com.nowhere-synthetic', cert_age: 5 }]),
        /^day: FAIL fault the facts of the day's segments name a key the domains day pack does not hold: the fact of "com\.nowhere-synthetic" /m,
      ],
    ];
    for (const [name, bytes, why] of planted) {
      const p = await dayRoot(join(dir, name), { oiFacts: { a: bytes } });
      const x = await call(main, args(p, join(dir, `${name}-out`), ['--no-ledger']));
      assert.equal(x.code, EXIT.fault, `${name}\n${x.text}`);
      assert.match(x.text, why, name);
      nothingWritten(join(dir, `${name}-out`), x);
    }
    // From GHCR: the facts blob, then the manifest, gone.
    const fresh = await dayRoot(join(dir, 'fresh'), { oiFacts: OI_FACTS });
    const s = fresh.packs[2];
    const factsDigest = sha(s.extra[0].bytes);
    for (const [name, digest, why] of [
      [
        'blob',
        factsDigest,
        `^day: FAIL fault the manifest of obs:${esc(s.tag)} names its facts\\.json as ${factsDigest} \\(\\d+ B\\), which GHCR does not give with no credential \\(GHCR holds no blob `,
      ],
      ['manifest', s.digest, `^day: FAIL fault the root names the manifest of obs:${esc(s.tag)} as ${s.digest}, which GHCR does not give with no credential \\(MANIFEST_UNKNOWN\\)`],
    ]) {
      const reader = packsReader(fresh.packs, (p, d) => p === s && d === digest);
      const x = await call(main, noInputs(args(fresh, join(dir, `ghcr-${name}`), ['--no-ledger'])), { reader });
      assert.equal(x.code, EXIT.fault, `${name}\n${x.text}`);
      assert.ok(!x.out.includes('PRIVATE PACKAGE'), x.text);
      assert.match(x.text, new RegExp(why, 'm'), name);
      nothingWritten(join(dir, `ghcr-${name}`), x);
    }
    // A manifest answered under another digest than the one asked.
    const lying = packsReader(fresh.packs);
    const get = lying.getManifest;
    lying.getManifest = async (repo, ref) => ({ ...(await get(repo, ref)), digest: `sha256:${'0'.repeat(64)}` });
    const l = await call(main, noInputs(args(fresh, join(dir, 'ghcr-lying'), ['--no-ledger'])), { reader: lying });
    assert.equal(l.code, EXIT.fault, l.text);
    assert.match(l.text, /^day: FAIL fault GHCR answered the manifest sha256:[0-9a-f]{64} of obs:\S+ with the digest sha256:0{64}$/m);
    nothingWritten(join(dir, 'ghcr-lying'), l);
  }));

// Ruling 23 with facts, through the root double of the quarantine test above:
// a quarantined window's facts go into the domains day pack's layer, as its
// records go into the pack, and never to the feed, whose join leaves its
// records out. Given to the feed, the window's fact of bit 1 would name a bit
// that np.com.nepal-synthetic's record, THC's alone, does not hold.
test("day cli: a quarantined segment's facts go into the domains day pack's facts.json and not to the feed", () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir, { oiFacts: { a: OI_FACTS.a, b: [{ key: 'np.com.nepal-synthetic', cert_age: 2_592_000 }] }, quarantined: ['b'] });
    const windowB = r.root.datasets.domains.find((p) => p.tag === r.packs[3].tag);
    assert.match(windowB.tag, /^oi-nrd\.20261027t060000z\./);
    assert.equal(windowB.quarantine, true, 'the root file carries the mark');
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--no-ledger']));
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^facts 2 3$/m);
    assert.match(x.text, /^exact domains: 1 quarantined input\(s\) left out of the join \(ruling 23\): obs:oi-nrd\.20261027t060000z\./m);
    assert.deepEqual([...parseFacts(new Uint8Array(readFileSync(join(out, 'domains', 'facts.json')))).keys()], ['com.fresh-synthetic', 'net.cert-synthetic', 'np.com.nepal-synthetic']);
    assert.deepEqual(await rowsOf(join(out, 'feed')), [
      ['com.fresh-synthetic', 5 * 3600 + 600, FEED_SUSPECT | FEED_SUSPECT_CERT],
      ['com.isc-synthetic', 0, 0],
      ['com.thc-synthetic', 0, 0],
      ['net.cert-synthetic', 5 * 3600 + 1200, FEED_SUSPECT | FEED_SUSPECT_CERT],
      ['np.com.nepal-synthetic', 0, 0],
    ]);
  }));

// day.mjs in a child process, as compact-daily.yml runs it, its exit read from
// that process. Inside test(), awaited code runs many times slower, and a
// compaction awaits once a record or more. MEASURED 2026-10-31 on Node
// 26.7.0: an async generator of 2,000,000 values took 8.9 s inside test()
// against 0.43 s outside it (10:32Z), and the two runs of the test below
// 120 s inside test() against 25 s under --test outside it (10:29Z, 10:27Z).
const DAY_SCRIPT = fileURLToPath(new URL('./day.mjs', import.meta.url));
function dayChild(argv) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, [DAY_SCRIPT, ...argv], { cwd: ROOT, encoding: 'utf8', env, maxBuffer: 16 << 20 });
  if (r.error) throw r.error;
  return { code: r.status, text: `${r.stdout}\n${r.stderr}` };
}

// Settled S1 of DOM-026: a day of oi-nrd is about 14.2 MB of facts [E], under
// the 64 MiB cap. Two windows of 205,000 keys, 10,000 of them in both, give a
// day of 400,000 keys. The first run writes the domains day pack, its layer
// the merge of the two; the day's feed is present, so it builds none (MEASURED
// 2026-10-31T10:18Z: a first run that built the feed of all 400,001 rows took
// 35 s, 14 s of it the feed's). The second reads that pack, live, and its
// layer back for the feed.
test('day cli: 400,000 keys of facts (settled S1): their merge is the domains day pack facts.json under the cap, and a feed day built from that pack once live reads it back', () =>
  inTmp(async (dir) => {
    const key = (k) => `com.s${String(k).padStart(6, '0')}-synthetic`;
    const range = (from, to) => Array.from({ length: to - from }, (_, i) => from + i);
    // An age over 7 days in window a for the even keys, in window b for the
    // multiples of 3: a key in both is suspect when it is a multiple of 6.
    const ageA = (k) => (k % 2 === 0 ? 2_592_000 : 120);
    const ageB = (k) => (k % 3 === 0 ? 864_000 : 60);
    const windowOf = (keys, from, age) => ({
      records: keys.map((k) => domain(key(k), 'oi-nrd', T(from) + (k % 3600))),
      facts: keys.map((k) => ({ key: key(k), cert_age: age(k) })),
    });
    const wa = windowOf(range(0, 205_000), '05:00:00', ageA);
    const wb = windowOf(range(195_000, 400_000), '06:00:00', ageB);
    const base = await tierPack('domains', 'd', '2026-10-26T00:00:00Z', [domain('com.old-synthetic', 'thc-ct', dayNo('2026-10-26'))], { sources: ['thc-ct'] });
    const r = rootFiles(dir, [
      base,
      await segment('thc-ct', '2026-10-27T00:00:00Z', '2026-10-28T00:00:00Z', [domain('com.thc-synthetic', 'thc-ct', 299)]),
      await segment('oi-nrd', '2026-10-27T05:00:00Z', '2026-10-27T06:00:00Z', wa.records, { facts: wa.facts, recordsPerBlock: 4096 }),
      await segment('oi-nrd', '2026-10-27T06:00:00Z', '2026-10-27T07:00:00Z', wb.records, { facts: wb.facts, recordsPerBlock: 4096 }),
      await segment('oi-nrd', '2026-10-27T07:00:00Z', '2026-10-28T00:00:00Z', []),
      await segment('oi-nrd', '2026-10-28T00:00:00Z', '2026-10-28T00:10:00Z', [domain('org.after-midnight-synthetic', 'oi-nrd', secs('2026-10-28T00:05:00Z'))]),
    ]);
    writeFileSync(r.tags, JSON.stringify({ names: [], feed: ['feed-d-20261027'] }));
    const expected = new Map(range(0, 400_000).map((k) => [key(k), new Map([[1, { cert_age: Math.min(...(k < 205_000 ? [ageA(k)] : []), ...(k >= 195_000 ? [ageB(k)] : [])) }]])]));
    const first = join(dir, 'first');
    const x = dayChild(args(r, first, ['--no-ledger']));
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^facts 2 400000$/m);
    assert.match(x.text, /^present feed:feed-d-20261027 \(feed-d-20261027\): nothing is written$/m);
    const layer = new Uint8Array(readFileSync(join(first, 'domains', 'facts.json')));
    assert.equal(sha(layer), sha(encodeFacts(expected)), 'the layer is the minimum age per key over the two windows');
    assert.equal(parseFacts(layer).size, 400_000);
    // Past a day of oi-nrd as estimated, and under the cap.
    assert.ok(layer.length > 14_200_000 && layer.length < FACTS_MAX_BYTES, `${layer.length} B`);
    const suspect = [...expected.values()].filter((bits) => bits.get(1).cert_age > 7 * 86_400).length;
    assert.equal(suspect, 97_500 + 65_000 + 1_667);
    // The day pack promoted: the root names it live, in place of the segments.
    const again = rootFiles(join(dir, 'again'), [base, writtenPack(join(first, 'domains'), 'domains-d-20261027', 'domains')]);
    writeFileSync(again.tags, JSON.stringify({ names: ['domains-d-20261027'], feed: [] }));
    const second = join(dir, 'second');
    const y = dayChild(args(again, second, ['--no-ledger']));
    assert.equal(y.code, EXIT.ok, y.text);
    assert.match(y.text, /^verdict domains present names:domains-d-20261027$/m);
    assert.match(y.text, /^facts names:domains-d-20261027 400000$/m);
    // Every key is new and under com; a row is suspect by its certificate as the layer says.
    const summary = JSON.parse(readFileSync(join(second, 'feed', 'summary.json'), 'utf8'));
    assert.deepEqual(summary.suffixes.com, { new_registrable: 400_001, suspect, by_source: { 'oi-nrd': 400_000, 'thc-ct': 1 } });
  }));

// The review of DOM-026: the day's merge past the cap is a fault of the day,
// exit 1, never a defect; reaching it through main needs about 1.34 million
// keys (50.1 B a key), so the layer step is held alone.
test('day cli: the domains day facts.json is null for no fact, the merge encoded otherwise, and a merge past FACTS_MAX_BYTES is a Fault', () => {
  assert.equal(dayFactsLayer(new Map(), 'domains-d-20261027'), null);
  const one = new Map([['com.a-synthetic', new Map([[1, { cert_age: 5 }]])]]);
  assert.deepEqual(dayFactsLayer(one, 'domains-d-20261027'), encodeFacts(one));
  // 1,030 keys of 65,535 bytes, the longest pack key: 67.5 MB of layer.
  const big = new Map(Array.from({ length: 1030 }, (_, i) => [`${String(i).padStart(4, '0')}${'k'.repeat(65_531)}`, new Map([[1, { cert_age: i }]])]));
  assert.throws(
    () => dayFactsLayer(big, 'domains-d-20261027'),
    (e) => e instanceof Fault && e.message.startsWith('the facts.json of names:domains-d-20261027: size: the layer is ') && e.message.endsWith(` bytes, over ${FACTS_MAX_BYTES}`),
  );
});

// ---- DOM-029: a feed plan of skip (F7), the absorb of a late segment (D17),
// the annotation quarantined-inputs (L8) and the ledger's cap (D28).

const QUARANTINED_INPUTS = 'dev.pkgforge.domains.quarantined-inputs';

// The feed's corpus starts at 2026-10-28 (its first pack, a day pack), after
// the day of 2026-10-27 that domains builds: no feed pack of 2026-10-27 is
// written, as a backfilled day before feed's corpus_since gets none (D16).
test('day cli: a feed plan of skip writes no feed pack and prints skip feed DAY: REASON; the domains day pack and the ledger are written', () =>
  inTmp(async (dir) => {
    const packs = [
      await tierPack('domains', 'd', '2026-10-26T00:00:00Z', [domain('com.old-synthetic', 'thc-ct', dayNo('2026-10-26'))], { sources: ['thc-ct'] }),
      await segment('thc-ct', '2026-10-27T00:00:00Z', '2026-10-28T00:00:00Z', [domain('com.old-synthetic', 'thc-ct', 299), domain('com.thc-synthetic', 'thc-ct', 299)]),
      await tierPack('feed', 'd', '2026-10-28T00:00:00Z', [{ ...feedRow('com.later-synthetic', '05:10:00', 0), firstSeen: secs('2026-10-28T05:10:00Z') }], { sources: ['oi-nrd'] }),
    ];
    const r = rootFiles(dir, packs);
    assert.equal(r.root.corpus_since.feed, '2026-10-28T00:00:00Z');
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--first-ledger']));
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^verdict feed skip feed:feed-d-20261027$/m);
    assert.match(
      x.text,
      /^skip feed 2026-10-27: the unit ends at 2026-10-28T00:00:00Z, at or before the corpus of feed starts at 2026-10-28T00:00:00Z \(corpus_since\): no source covers it, and no pack is written$/m,
    );
    assert.doesNotMatch(x.text, /^(wrote|exact|carry|summary) feed/m);
    assert.match(x.text, /^wrote names:domains-d-20261027 sha256:[0-9a-f]{64} records 2 parts 1$/m);
    assert.match(x.text, /^wrote state:ledger-filter-20261027 /m);
    assert.equal(existsSync(join(out, 'feed')), false);
    const report = JSON.parse(readFileSync(join(out, 'day.json'), 'utf8'));
    assert.deepEqual(report.feed, { action: 'skip', tag: 'feed-d-20261027', manifest: null, replaces: [] });
    assert.deepEqual([report.exact, report.carry, report.summary], [null, null, null]);
  }));

// The live set of 2026-10-27 after its day packs were built without THC, and
// THC's late day segment beside them (D17 of DOM-029): domains-d-20261026,
// the base; the live domains-d-20261027 of oi-nrd's records; THC's day
// segment of 2026-10-27; and the live feed-d-20261027, whose row of
// net.cert-synthetic is suspect. `facts` gives the day pack a facts.json of
// oi-nrd, `annotations` its own annotations, `quarantine` pushes THC's
// segment quarantined. The tags hold both day packs, so a rebuild reads
// their manifests (buildsReader) and takes -r2.
async function absorbRoot(dir, { facts = null, annotations, quarantine = false } = {}) {
  const day = await tierPack('domains', 'd', '2026-10-27T00:00:00Z', [domain('com.fresh-synthetic', 'oi-nrd', T('05:10:00')), domain('net.cert-synthetic', 'oi-nrd', T('05:20:00'))], {
    sources: ['oi-nrd'],
    ...(facts === null ? {} : { extra: [factsExtra(facts)] }),
    ...(annotations === undefined ? {} : { annotations }),
  });
  const feed = await tierPack('feed', 'd', '2026-10-27T00:00:00Z', [feedRow('com.fresh-synthetic', '05:10:00', 0), feedRow('net.cert-synthetic', '05:20:00', FEED_SUSPECT | FEED_SUSPECT_CERT)], {
    sources: ['oi-nrd'],
  });
  const packs = [
    await tierPack('domains', 'd', '2026-10-26T00:00:00Z', [domain('com.old-synthetic', 'thc-ct', dayNo('2026-10-26'))], { sources: ['thc-ct'] }),
    day,
    await segment(
      'thc-ct',
      '2026-10-27T00:00:00Z',
      '2026-10-28T00:00:00Z',
      [domain('com.fresh-synthetic', 'thc-ct', 299), domain('com.old-synthetic', 'thc-ct', 299), domain('com.thc-synthetic', 'thc-ct', 299)],
      {
        quarantine,
      },
    ),
    feed,
  ];
  const r = rootFiles(dir, packs);
  writeFileSync(r.tags, JSON.stringify({ names: ['domains-d-20261026', 'domains-d-20261027'], feed: ['feed-d-20261027'] }));
  const reader = buildsReader({ names: { 'domains-d-20261027': day.json }, feed: { 'feed-d-20261027': feed.json } });
  return { ...r, day, feed, seg: packs[2], reader };
}

test('day cli: an absorb takes the late THC segment and the live feed day as carry: -r2 of each replaces them; without --rebuild both stay present', () =>
  inTmp(async (dir) => {
    const r = await absorbRoot(dir);
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--no-ledger', '--rebuild', 'domains,feed']), { reader: r.reader });
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^verdict domains ready names:domains-d-20261027$/m);
    assert.ok(x.out.includes(`reason domains absorb: names:domains-d-20261027 takes in 1 segment(s) that came after it: obs:${r.seg.tag}`), x.text);
    assert.match(x.text, /^input domains names:domains-d-20261027 d 2026-10-27T00:00:00Z 2026-10-28T00:00:00Z 2$/m);
    assert.match(x.text, /^verdict feed ready feed:feed-d-20261027$/m);
    assert.match(
      x.text,
      /^reason feed absorb: the day of domains takes in 1 segment\(s\) that are not quarantined \(obs:thc-ct\..*\), so feed:feed-d-20261027 is built again from its exact join, its rows carried$/m,
    );
    assert.match(x.text, /^check domains: 4 records, the inputs' 4 distinct keys of 5 records$/m);
    assert.match(x.text, /^wrote names:domains-d-20261027-r2 sha256:[0-9a-f]{64} records 4 parts 1$/m);
    assert.ok(x.out.includes(`replace names:domains-d-20261027-r2 ${r.day.digest} ${r.seg.digest}`), x.text);
    assert.doesNotMatch(x.text, /^quarantined-inputs /m);
    // The live feed day is the carry, as hour packs are: its suspect row keeps its bits.
    assert.match(x.text, /^exact day 4 new 3 early 0 blocks \d+$/m);
    assert.match(x.text, /^carry hour rows 2 matched 2 carried 1 retracted 0$/m);
    assert.match(x.text, /^wrote feed:feed-d-20261027-r2 sha256:[0-9a-f]{64} records 3 parts 1 time 1$/m);
    assert.ok(x.out.includes(`replace feed:feed-d-20261027-r2 ${r.feed.digest}`), x.text);
    assert.deepEqual(await rowsOf(join(out, 'feed')), [
      ['com.fresh-synthetic', 0, 0],
      ['com.thc-synthetic', 0, 0],
      ['net.cert-synthetic', 5 * 3600 + 1200, FEED_SUSPECT | FEED_SUSPECT_CERT],
    ]);
    const domains = JSON.parse(readFileSync(join(out, 'domains', 'manifest.json'), 'utf8'));
    assert.equal(domains.annotations['dev.pkgforge.domains.source'], 'oi-nrd,thc-ct');
    assert.equal(Object.hasOwn(domains.annotations, QUARANTINED_INPUTS), false);
    const feed = JSON.parse(readFileSync(join(out, 'feed', 'manifest.json'), 'utf8'));
    assert.equal(feed.annotations['dev.pkgforge.domains.source'], 'oi-nrd,thc-ct');
    const report = JSON.parse(readFileSync(join(out, 'day.json'), 'utf8'));
    assert.deepEqual(
      [report.domains.tag, report.domains.replaces, report.feed.tag, report.feed.replaces],
      ['domains-d-20261027-r2', [r.day.digest, r.seg.digest], 'feed-d-20261027-r2', [r.feed.digest]],
    );
    assert.deepEqual(report.facts, { from: 'inputs', layers: 0, keys: 0 });
    const vd = await verifyDir(join(out, 'domains'), 'dataset,length,count,sha256');
    assert.equal(vd.code, 0, vd.text);
    const vf = await verifyDir(join(out, 'feed'), 'dataset,length,count,sha256,time');
    assert.equal(vf.code, 0, vf.text);
    // --rebuild domains alone: the feed day's tag is in the package, and no -r2 of it is asked.
    const d = await call(main, args(r, join(dir, 'domains-only'), ['--no-ledger', '--rebuild', 'domains']), { reader: r.reader });
    assert.equal(d.code, EXIT.ok, d.text);
    assert.match(d.text, /^wrote names:domains-d-20261027-r2 /m);
    assert.match(d.text, /^present feed:feed-d-20261027 \(feed-d-20261027\): nothing is written$/m);
    // No --rebuild: no absorb, both day packs are live, and nothing is written.
    const plain = await call(main, args(r, join(dir, 'plain'), ['--no-ledger']), { reader: r.reader });
    assert.equal(plain.code, EXIT.ok, plain.text);
    assert.match(plain.text, /^verdict domains present names:domains-d-20261027$/m);
    assert.match(plain.text, /^present feed:feed-d-20261027: the day's feed is live$/m);
    assert.doesNotMatch(plain.text, /^wrote /m);
  }));

test("day cli: the facts of a live day pack reach its absorb: the -r2 pack carries them in its facts.json, and the rebuilt feed's row is suspect", () =>
  inTmp(async (dir) => {
    const r = await absorbRoot(dir, { facts: segmentFacts('oi-nrd', [{ key: 'com.fresh-synthetic', cert_age: 2_592_000 }]) });
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--no-ledger', '--rebuild', 'domains,feed']), { reader: r.reader });
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^facts 1 1$/m);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'day.json'), 'utf8')).facts, { from: 'inputs', layers: 1, keys: 1 });
    const manifest = JSON.parse(readFileSync(join(out, 'domains', 'manifest.json'), 'utf8'));
    assert.ok(manifest.layers.some((l) => l.annotations['org.opencontainers.image.title'] === 'facts.json'));
    const facts = parseFacts(new Uint8Array(readFileSync(join(out, 'domains', 'facts.json'))));
    assert.deepEqual([...facts.keys()], ['com.fresh-synthetic']);
    assert.deepEqual(await rowsOf(join(out, 'feed')), [
      ['com.fresh-synthetic', 0, FEED_SUSPECT | FEED_SUSPECT_CERT],
      ['com.thc-synthetic', 0, 0],
      ['net.cert-synthetic', 5 * 3600 + 1200, FEED_SUSPECT | FEED_SUSPECT_CERT],
    ]);
  }));

test('day cli: a day pack built with a quarantined input carries quarantined-inputs, a rebuild carries it forward, and its absorb keeps the feed; a quarantined late segment leaves the feed day present', () =>
  inTmp(async (dir) => {
    // The day pack of 2026-10-27 names isc-new in quarantined-inputs: its records hold ISC's, which the join cannot tell apart.
    const r = await absorbRoot(join(dir, 'held'), { annotations: { [QUARANTINED_INPUTS]: 'isc-new' } });
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--no-ledger', '--rebuild', 'domains,feed']), { reader: r.reader });
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, /^wrote names:domains-d-20261027-r2 sha256:[0-9a-f]{64} records 4 parts 1$/m);
    assert.match(x.text, /^quarantined-inputs names:domains-d-20261027-r2 isc-new$/m);
    assert.equal(JSON.parse(readFileSync(join(out, 'domains', 'manifest.json'), 'utf8')).annotations[QUARANTINED_INPUTS], 'isc-new');
    assert.ok(
      x.out.includes(
        `keep feed:feed-d-20261027: the day's records are names:domains-d-20261027, which carries ${QUARANTINED_INPUTS} isc-new, and an exact join over it would take those records as new (ruling 23); no feed pack is written, and the live feed day stays`,
      ),
      x.text,
    );
    assert.doesNotMatch(x.text, /^(wrote|exact|carry) feed/m);
    assert.equal(existsSync(join(out, 'feed')), false);
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'day.json'), 'utf8')).feed, { action: 'keep', tag: 'feed-d-20261027', manifest: r.feed.digest, replaces: [] });
    // A quarantined late segment: the -r2 pack names thc-ct, and the feed day stays present (planTier: nothing for it to absorb).
    const q = await absorbRoot(join(dir, 'q'), { quarantine: true });
    const y = await call(main, args(q, join(dir, 'q-out'), ['--no-ledger', '--rebuild', 'domains']), { reader: q.reader });
    assert.equal(y.code, EXIT.ok, y.text);
    assert.match(y.text, /^input domains obs:thc-ct\.\S+ seg 2026-10-27T00:00:00Z 2026-10-28T00:00:00Z 3 quarantined$/m);
    assert.match(y.text, /^quarantined-inputs names:domains-d-20261027-r2 thc-ct$/m);
    assert.match(y.text, /^verdict feed present feed:feed-d-20261027$/m);
    assert.match(y.text, /^present feed:feed-d-20261027: the day's feed is live$/m);
    const manifest = JSON.parse(readFileSync(join(dir, 'q-out', 'domains', 'manifest.json'), 'utf8'));
    assert.deepEqual([manifest.annotations['dev.pkgforge.domains.source'], manifest.annotations[QUARANTINED_INPUTS]], ['oi-nrd,thc-ct', 'thc-ct']);
    // A day pack whose quarantined-inputs is not source ids sorted and distinct is a fault of the pack, exit 1.
    const bad = await absorbRoot(join(dir, 'bad'), { annotations: { [QUARANTINED_INPUTS]: 'isc-new' } });
    const path = join(bad.inputs, 'domains-d-20261027', 'manifest.json');
    const text = readFileSync(path, 'utf8').replace('"isc-new"', '"thc-ct isc-new"');
    writeFileSync(path, text);
    const root = { ...bad.root, datasets: { ...bad.root.datasets, domains: bad.root.datasets.domains.map((p) => (p.tag === 'domains-d-20261027' ? { ...p, manifest: sha(text) } : p)) } };
    writeFileSync(bad.rootPath, `${JSON.stringify(root)}\n`);
    const z = await call(main, args(bad, join(dir, 'bad-out'), ['--no-ledger', '--rebuild', 'domains,feed']), { reader: bad.reader });
    assert.equal(z.code, EXIT.fault, z.text);
    assert.match(z.text, /day: FAIL fault names:domains-d-20261027 carries dev\.pkgforge\.domains\.quarantined-inputs="thc-ct isc-new", not source ids sorted and distinct, one space apart/);
  }));

test('day cli: a filter over the cap a reader of state takes is refused, exit 1, after its fold; no filter, delta or day.json is written', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const out = join(dir, 'out');
    // 7 keys fold to 7 partitions of 64 bits, 92 B with the header, the smallest a fold reaches.
    const x = await call(main, args(r, out, ['--first-ledger']), { ledgerMaxBytes: 91 });
    assert.equal(x.code, EXIT.fault, x.text);
    assert.match(
      x.text,
      /day: FAIL fault the filter of ledger-filter-20261027 is 92 B \(7 keys, 7 partitions of 64 bits\), over the 91 B a reader of state takes \(LEDGER_MAX_BYTES\), and it does not fold further: no filter and no delta is written/,
    );
    assert.equal(existsSync(join(out, 'ledger')), false);
    assert.equal(existsSync(join(out, 'day.json')), false);
    // At the cap itself the filter is written.
    const at = await call(main, args(r, join(dir, 'at'), ['--first-ledger']), { ledgerMaxBytes: 92 });
    assert.equal(at.code, EXIT.ok, at.text);
    assert.match(at.text, /^wrote state:ledger-filter-20261027 \S+ sha256:[0-9a-f]{64} keys 7 partition_bits 64 bytes 92 bits_per_key 64\.00$/m);
    assert.equal(JSON.parse(readFileSync(join(dir, 'at', 'day.json'), 'utf8')).ledger.bytes, 92);
  }));
