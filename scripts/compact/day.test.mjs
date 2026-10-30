// scripts/compact/day.mjs: the domains day pack, the exact feed of the day
// with its time copy and summary.json, and the ledger's rebuild, from a
// root.json and the packs on disk or a GHCR double; the verifier passes both
// packs; a re-run writes nothing, and so does a re-run of a rebuild whose
// bytes a build holds (D3 of DOM-023); the output paths and each exit code;
// each refusal is planted alone. Real packs of synthetic
// records (packages/compact/test/daily-helpers.ts), a root that buildRoot of
// packages/root validates.
//
//   node scripts/test.mjs scripts/compact --name "day cli"
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildDay, CompactError } from '@domains/compact';
import { filesSource } from '@domains/compact/node';
import { FeedError } from '@domains/feed';
import { GhcrError, LayoutError } from '@domains/ghcr';
import { BloomFilter, HashDelta, hashKey, LedgerError } from '@domains/ledger';
import { FEED_CODEC, FEED_PROVISIONAL, FEED_SUSPECT, FEED_SUSPECT_CERT, PackError, PackReader } from '@domains/pack';
import { buildRoot } from '@domains/root';
import { blobsOf, dayNo, domain, entryOf, PSL, REGISTRY, secs, segment, tierPack, writeDir } from '../../packages/compact/test/daily-helpers.ts';
import { RateLimitError } from '../ghcr/rate.mjs';
import { Fault } from '../root/lib.mjs';
import { main as verify } from '../verify-pack.mjs';
import { DAY_FORMAT, EXIT, main } from './day.mjs';

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
// hash the first oi-nrd window was built under.
async function dayRoot(dir, { behind = false, hour5Rows = null, oiPsl = PSL } = {}) {
  const packs = [
    await tierPack('domains', 'd', '2026-10-26T00:00:00Z', [domain('com.old-synthetic', 'thc-ct', dayNo('2026-10-26'))], { sources: ['thc-ct'] }),
    await segment('thc-ct', '2026-10-27T00:00:00Z', '2026-10-28T00:00:00Z', [
      domain('com.old-synthetic', 'thc-ct', 299),
      domain('com.thc-synthetic', 'thc-ct', 299),
      domain('np.com.nepal-synthetic', 'thc-ct', 299),
    ]),
    await segment('oi-nrd', '2026-10-27T05:00:00Z', '2026-10-27T06:00:00Z', [domain('com.fresh-synthetic', 'oi-nrd', T('05:10:00')), domain('net.cert-synthetic', 'oi-nrd', T('05:20:00'))], {
      psl: oiPsl,
    }),
    await segment('oi-nrd', '2026-10-27T06:00:00Z', '2026-10-27T07:00:00Z', [domain('np.com.nepal-synthetic', 'oi-nrd', T('06:30:00'))]),
    ...(behind
      ? []
      : [
          await segment('oi-nrd', '2026-10-27T07:00:00Z', '2026-10-28T00:00:00Z', []),
          await segment('oi-nrd', '2026-10-28T00:00:00Z', '2026-10-28T00:10:00Z', [domain('org.after-midnight-synthetic', 'oi-nrd', secs('2026-10-28T00:05:00Z'))]),
        ]),
    await segment('isc-new', '2026-10-27T00:00:00Z', '2026-10-28T00:00:00Z', [domain('com.early-synthetic', 'isc-new', 290), domain('com.isc-synthetic', 'isc-new', 299)]),
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

// A GHCR double that holds every blob of `packs` by digest, less those `drop` names.
function packsReader(packs, drop = () => false) {
  const blobs = new Map();
  for (const p of packs) for (const [digest, bytes] of blobsOf(p)) if (!drop(p, digest)) blobs.set(digest, bytes);
  return {
    readRange: async (_repo, digest, start, end) => {
      const b = blobs.get(digest);
      if (b === undefined) throw new GhcrError('missing', `GHCR holds no blob ${digest.slice(0, 19)}`, 404);
      return { bytes: new Uint8Array(b.subarray(start, end)), status: 206 };
    },
  };
}

async function rowsOf(dir) {
  const src = filesSource([join(dir, 'part.000')]);
  const reader = await PackReader.open(new Uint8Array(readFileSync(join(dir, 'idx'))), src.source, FEED_CODEC, { partSizes: src.sizes });
  const rows = [];
  for await (const row of reader.scan()) rows.push([row.key, row.firstSeen - T('00:00:00'), row.feedFlags]);
  await src.close();
  return rows;
}

// verify-pack.mjs on the pack in `dir`, every check of `require` asked.
async function verifyDir(dir, require) {
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const ann = { ...manifest.annotations };
  // The synthetic registry is not config/sources.json: the checks that read it are not asked for.
  for (const k of ['dev.pkgforge.domains.source', 'dev.pkgforge.domains.precision']) delete ann[k];
  const annPath = `${dir}.annotations.json`;
  writeFileSync(annPath, JSON.stringify(ann));
  const blobs = JSON.parse(readFileSync(join(dir, 'blobs.json'), 'utf8'));
  // summary.json is no layer the verifier reads.
  const files = blobs.filter((b) => b.file !== null && b.title !== 'summary.json').map((b) => b.file);
  return call(verify, [...files, '--annotations', annPath, '--require', require]);
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
    assert.match(x.text, /^wrote state:ledger-filter-20261027 \S+filter\.dlbf sha256:[0-9a-f]{64} keys 7 bytes \d+$/m);
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

// ⚠ No root file reaches ruling 23's wiring in day.mjs today: the root's
// schema holds no field `quarantine`, and validateRoot refuses an entry that
// carries one. DOM-029 adds the field. This test then fails, and the next one
// reads the root file in place of its double.
test('day cli: a root entry marked quarantined is refused by the root schema until DOM-029 adds the field, exit 1', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const isc = r.root.datasets.domains.find((p) => p.tag.startsWith('isc-new.'));
    isc.quarantine = 1;
    writeFileSync(r.rootPath, `${JSON.stringify(r.root)}\n`);
    const x = await call(main, args(r, join(dir, 'out'), ['--no-ledger']));
    assert.equal(x.code, EXIT.fault, x.text);
    assert.match(x.text, /day: FAIL fault --root .*root\.json: .*holds the unknown field\(s\) quarantine/);
  }));

// Ruling 23 through day.mjs: the root double marks ISC's day segment
// quarantined. The domains day pack still holds its records, since they are
// served; the exact join reads the other inputs only, so com.isc-synthetic is
// no row, and the feed pack does not name isc-new (AGENTS.md absolute 11).
test('day cli: a day input the root marks quarantined stays in the domains pack, gives the feed no row, and the feed does not name its source', () =>
  inTmp(async (dir) => {
    const r = await dayRoot(dir);
    const isc = r.root.datasets.domains.find((p) => p.tag.startsWith('isc-new.'));
    isc.quarantine = 1;
    const readRoot = async () => ({ root: r.root, ref: 'sha256:'.padEnd(71, '0') });
    const out = join(dir, 'out');
    const x = await call(main, args(r, out, ['--no-ledger']), { readRoot });
    assert.equal(x.code, EXIT.ok, x.text);
    assert.match(x.text, new RegExp(`^input domains obs:${isc.tag.replaceAll('.', '\\.')} seg 2026-10-27T00:00:00Z 2026-10-28T00:00:00Z 2 quarantined$`, 'm'));
    assert.match(x.text, new RegExp(`^exact domains: 1 quarantined input\\(s\\) left out of the join \\(ruling 23\\): obs:${isc.tag.replaceAll('.', '\\.')}$`, 'm'));
    assert.match(x.text, /^wrote names:domains-d-20261027 sha256:[0-9a-f]{64} records 7 parts 1$/m);
    const domains = JSON.parse(readFileSync(join(out, 'domains', 'manifest.json'), 'utf8'));
    assert.equal(domains.annotations['dev.pkgforge.domains.source'], 'isc-new,oi-nrd,thc-ct');
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
