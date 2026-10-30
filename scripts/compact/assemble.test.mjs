// scripts/compact/assemble.mjs: the pack of a planned compaction from the
// parts its ranges wrote, held byte for byte to the merge of one process and
// passed by the verifier; a re-run skips; each fault is planted alone. Real
// packs of synthetic records (scripts/compact/fixture.mjs).
//
//   node scripts/test.mjs scripts/compact --name "assemble cli"
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CompactError, codecOf, mergeSpan, packManifest, planFile, writeRange } from '@domains/compact';
import { DirPartsSink, FileSink, fileDigest, filesSource, openCopy } from '@domains/compact/node';
import { GhcrError, tierTag } from '@domains/ghcr';
import { FEED_CODEC, IDX_TITLE, MemorySink, NAMES_CODEC, NEW_NAME_CODEC, PackError, PackReader, partsSource, writePack } from '@domains/pack';
import { nodeCompress, writerId } from '@domains/pack/node';
import { canonical } from '@domains/root';
import { RateLimitError } from '../ghcr/rate.mjs';
import { Fault } from '../root/lib.mjs';
import { main as verify } from '../verify-pack.mjs';
import { EPOCH_MS, keysOf, plannedWeek, PSL, rootOf } from './fixture.mjs';
import { EXIT, main } from './assemble.mjs';
import { main as planMain } from './plan.mjs';
import { main as rangeMain } from './range.mjs';

async function call(fn, argv, deps = {}) {
  const out = [];
  const err = [];
  // `write` is the verifier's stdout (scripts/verify-pack.mjs main).
  const code = await fn(argv, { out: (l) => out.push(l), write: (t) => out.push(t.trimEnd()), err: (l) => err.push(l), sleep: async () => undefined, env: {}, ...deps });
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

async function inTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'compact-assemble-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A planned week whose ranges are written into `ranges`, and a tags file.
async function rangedWeek(dir, dataset = 'names', options = {}) {
  const w = await plannedWeek(dir, dataset, 3, options);
  const ranges = join(dir, 'ranges');
  const r = await call(rangeMain, ['all', '--plan', w.planPath, '--inputs', w.inputsDir, '--out', ranges]);
  assert.equal(r.code, 0, r.text);
  const tags = join(dir, 'tags.json');
  writeFileSync(tags, '[]');
  return { ...w, ranges, tags, rangeText: r.text };
}

const assembleArgs = (w, out, more = []) => ['--plan', w.planPath, '--dir', w.ranges, '--out', out, '--tags', w.tags, '--run', '7', ...more];

// verify-pack.mjs on an assembled pack: its parts, its index, its time copy;
// the annotations `drop` names are taken out first.
async function verifyAssembled(out, require, drop = []) {
  const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
  const ann = { ...manifest.annotations };
  for (const k of drop) delete ann[k];
  // The synthetic sources are in no registry: the checks that read one are not asked for.
  for (const k of ['dev.pkgforge.domains.source', 'dev.pkgforge.domains.precision']) delete ann[k];
  const annPath = join(out, 'annotations.json');
  writeFileSync(annPath, JSON.stringify(ann));
  const blobs = JSON.parse(readFileSync(join(out, 'blobs.json'), 'utf8'));
  const files = blobs.filter((b) => b.file !== null).map((b) => b.file);
  return call(verify, [...files, '--annotations', annPath, '--require', require]);
}

test('assemble cli: the ranges assemble into the pack one process merges, and the verifier passes it', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir);
    const out = join(dir, 'asm');
    const r = await call(main, assembleArgs(w, out, ['--inputs', w.inputsDir]));
    assert.equal(r.code, EXIT.ok, r.text);
    assert.match(r.out.at(-1), /^assembled names:names-w-2026w43 sha256:[0-9a-f]{64} records \d+ parts \d+$/);
    assert.match(r.text, /^check count: (\d+) records, the inputs' \1 distinct keys of \d+ records$/m);
    // The merge of one process, with the plan's cuts, gives the same index and parts.
    const opened = [];
    for (const i of w.inputs) opened.push(await openCopy(i.dir, 'key', NAMES_CODEC));
    const sink = new MemorySink();
    const one = await mergeSpan(
      opened.map((o) => o.reader),
      NAMES_CODEC,
      sink,
      { compress: nodeCompress, recordsPerBlock: 4, pageEntries: 2, cuts: w.plan.key.cuts },
    );
    await Promise.all(opened.map((o) => o.close()));
    assert.deepEqual(new Uint8Array(readFileSync(join(out, 'idx'))), one.idx);
    const parts = readdirSync(w.ranges)
      .filter((n) => /^part\.\d{3}$/.test(n))
      .sort();
    assert.deepEqual(
      parts.map((n) => new Uint8Array(readFileSync(join(w.ranges, n)))),
      sink.parts(),
    );
    const manifest = JSON.parse(readFileSync(join(out, 'manifest.json'), 'utf8'));
    assert.equal(manifest.annotations['dev.pkgforge.domains.sha256'], one.sha256);
    assert.equal(manifest.annotations['dev.pkgforge.domains.run'], '7');
    assert.equal(manifest.annotations['dev.pkgforge.domains.psl'], PSL);
    const blobs = JSON.parse(readFileSync(join(out, 'blobs.json'), 'utf8'));
    assert.deepEqual(
      blobs.map((b) => b.title),
      ['config', ...parts, 'idx'],
    );
    const v = await verifyAssembled(out, 'dataset,length,count,sha256');
    assert.equal(v.code, 0, v.text);
    assert.match(v.text, /^VERDICT ok/m);
    // The verify step of the workflows requires count: a pack whose count annotation is gone is unverified, exit 1.
    const bare = await verifyAssembled(out, 'dataset,length,count,sha256', ['dev.pkgforge.domains.count']);
    assert.equal(bare.code, 1, bare.text);
    assert.match(bare.text, /^VERDICT unverified \(\d+ skipped; required and skipped: count\)$/m);
  }));

// A reader of the GHCR double whose manifests carry the sha256 annotation
// `shas` gives each tag; `asked` logs each read. No other read is answered.
function manifestReader(shas, asked = []) {
  return {
    getManifest: async (repo, tag) => {
      asked.push(`${repo}:${tag}`);
      const sha = shas[tag];
      if (sha instanceof Error) throw sha;
      return { repo, ref: tag, digest: `sha256:${'f'.repeat(64)}`, json: { annotations: sha === undefined ? {} : { 'dev.pkgforge.domains.sha256': sha } } };
    },
    listTags: async () => {
      throw new TypeError('the tags come from --tags');
    },
  };
}

test('assemble cli: a re-run finds the tag present and writes nothing; --rebuild takes the next tag, -r2', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir);
    writeFileSync(w.tags, JSON.stringify(['names-d-20261019', 'names-w-2026w43']));
    const out = join(dir, 'asm');
    const r = await call(main, assembleArgs(w, out), { reader: manifestReader({}) });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out, ['present names:names-w-2026w43 (names-w-2026w43): nothing is written']);
    assert.equal(existsSync(out), false);
    // The build holds other bytes: the rebuild takes -r2.
    const again = await call(main, assembleArgs(w, out, ['--rebuild']), { reader: manifestReader({ 'names-w-2026w43': 'e'.repeat(64) }) });
    assert.equal(again.code, EXIT.ok, again.text);
    assert.match(again.out.at(-1), /^assembled names:names-w-2026w43-r2 sha256:/);
  }));

test("assemble cli: a rebuild reads each build's sha256 through the reader; a build of the same bytes is present and nothing is written, a build GHCR does not give is a fault, exit 1 (D3)", () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir);
    // The sha256 the pack holds: the one a first build writes.
    const first = await call(main, assembleArgs(w, join(dir, 'first')));
    assert.equal(first.code, EXIT.ok, first.text);
    const sha = JSON.parse(readFileSync(join(dir, 'first', 'manifest.json'), 'utf8')).annotations['dev.pkgforge.domains.sha256'];
    assert.match(sha, /^[0-9a-f]{64}$/);
    writeFileSync(w.tags, JSON.stringify(['names-w-2026w43', 'names-w-2026w43-r2']));
    const other = 'e'.repeat(64);
    const repo = 'pkgforge-dev/domains.pkgforge.dev/names';
    // -r2 holds these bytes: the re-run of the rebuild that pushed it.
    const asked = [];
    const out = join(dir, 'asm');
    const r2 = await call(main, assembleArgs(w, out, ['--rebuild']), { reader: manifestReader({ 'names-w-2026w43': other, 'names-w-2026w43-r2': sha }, asked) });
    assert.equal(r2.code, EXIT.ok, r2.text);
    assert.equal(r2.out.at(-1), `present names:names-w-2026w43-r2 (names-w-2026w43, names-w-2026w43-r2): it holds sha256 ${sha}; nothing is written`);
    assert.deepEqual(asked.sort(), [`${repo}:names-w-2026w43`, `${repo}:names-w-2026w43-r2`]);
    assert.equal(existsSync(out), false, 'a present unit leaves --out unmade');
    // The first build holds them: present at the first build.
    const base = await call(main, assembleArgs(w, out, ['--rebuild']), { reader: manifestReader({ 'names-w-2026w43': sha, 'names-w-2026w43-r2': other }) });
    assert.equal(base.code, EXIT.ok, base.text);
    assert.match(base.out.at(-1), /^present names:names-w-2026w43 \(/);
    // No build holds them: the next tag.
    const r3 = await call(main, assembleArgs(w, out, ['--rebuild']), { reader: manifestReader({ 'names-w-2026w43': other, 'names-w-2026w43-r2': other }) });
    assert.equal(r3.code, EXIT.ok, r3.text);
    assert.match(r3.out.at(-1), /^assembled names:names-w-2026w43-r3 sha256:/);
    // A build the package lists and GHCR does not give: the build is lost, exit 1, not 4.
    const lost = await call(main, assembleArgs(w, join(dir, 'lost'), ['--rebuild']), {
      reader: manifestReader({ 'names-w-2026w43': other, 'names-w-2026w43-r2': new GhcrError('missing', 'MANIFEST_UNKNOWN', 404) }),
    });
    assert.equal(lost.code, EXIT.fault, lost.text);
    assert.match(
      lost.text,
      /assemble: FAIL fault the tag list of pkgforge-dev\/domains\.pkgforge\.dev\/names names the build names-w-2026w43-r2, whose manifest GHCR does not give with no credential \(MANIFEST_UNKNOWN\): the build is lost/,
    );
    // A build whose manifest carries no sha256 is no pack a compaction wrote: exit 1.
    const bare = await call(main, assembleArgs(w, join(dir, 'bare'), ['--rebuild']), { reader: manifestReader({ 'names-w-2026w43': other }) });
    assert.equal(bare.code, EXIT.fault, bare.text);
    assert.match(bare.text, /assemble: FAIL fault the build names:names-w-2026w43-r2 carries dev\.pkgforge\.domains\.sha256 null, not 64 lowercase hex digits/);
    // A sha256 in capitals is no annotation packManifest writes: exit 1, never compared unequal and built again as -r3.
    const upper = await call(main, assembleArgs(w, join(dir, 'upper'), ['--rebuild']), { reader: manifestReader({ 'names-w-2026w43': other, 'names-w-2026w43-r2': sha.toUpperCase() }) });
    assert.equal(upper.code, EXIT.fault, upper.text);
    assert.match(upper.text, /assemble: FAIL fault the build names:names-w-2026w43-r2 carries dev\.pkgforge\.domains\.sha256 "[0-9A-F]{64}", not 64 lowercase hex digits/);
    assert.equal(existsSync(join(dir, 'upper')), false, 'a refused build read leaves --out unmade');
    // Without --rebuild no manifest is read.
    const none = [];
    const plain = await call(main, assembleArgs(w, join(dir, 'plain')), { reader: manifestReader({}, none) });
    assert.match(plain.out.at(-1), /^present names:names-w-2026w43-r2 /);
    assert.deepEqual(none, []);
  }));

test('assemble cli: the tags read from GHCR: a build there is present, a list cut short is a fault, a package not there yet holds no build', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir);
    const args = (out) => ['--plan', w.planPath, '--dir', w.ranges, '--out', out, '--run', '7'];
    const asked = [];
    const lister = (answer) => ({
      listTags: async (repo) => {
        asked.push(repo);
        return answer();
      },
    });
    const present = await call(main, args(join(dir, 'a')), { reader: lister(() => ({ tags: ['names-w-2026w43'], pages: 1, truncated: false })) });
    assert.equal(present.code, EXIT.ok, present.text);
    assert.match(present.out[0], /^present names:names-w-2026w43/);
    assert.deepEqual(asked, ['pkgforge-dev/domains.pkgforge.dev/names']);
    const cut = await call(main, args(join(dir, 'b')), { reader: lister(() => ({ tags: [], pages: 10_000, truncated: true })) });
    assert.equal(cut.code, EXIT.fault, cut.text);
    assert.match(cut.text, /FAIL fault the tag list of pkgforge-dev\/domains\.pkgforge\.dev\/names was cut at 10000 pages/);
    const none = await call(main, args(join(dir, 'c')), {
      reader: lister(() => {
        throw new GhcrError('missing', 'NAME_UNKNOWN', 404);
      }),
    });
    assert.equal(none.code, EXIT.ok, none.text);
    assert.match(none.out.at(-1), /^assembled names:names-w-2026w43 /);
  }));

test('assemble cli: a part that drops one input key passes the structure and fails the count check, exit 1', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir);
    // The last range's part, rewritten from its own records less one.
    const name = 'range.key.002.json';
    const f = JSON.parse(readFileSync(join(w.ranges, name), 'utf8'));
    assert.notEqual(f.part, null);
    const partPath = join(w.ranges, f.file);
    const src = filesSource([partPath]);
    const records = [];
    const reader = await PackReader.open(new Uint8Array(readFileSync(join(w.ranges, f.idx.file))), src.source, NAMES_CODEC, { partSizes: src.sizes });
    for await (const rec of reader.scan()) records.push(rec);
    await src.close();
    const dropped = records.splice(Math.floor(records.length / 2), 1)[0];
    const mem = new MemorySink();
    const s = await writePack(records, { codec: NAMES_CODEC, compress: nodeCompress, sink: mem, recordsPerBlock: 4 });
    const memReader = await PackReader.open(s.idx, partsSource(mem.parts()), NAMES_CODEC);
    rmSync(partPath);
    rmSync(join(w.ranges, f.idx.file));
    const sink = new FileSink(partPath);
    const o = await writeRange([memReader], NAMES_CODEC, w.plan.key.cuts, { range: 2, of: 3, part: f.part, offset: 0, skip: 0, take: null, total: null }, sink, {
      compress: nodeCompress,
      recordsPerBlock: 4,
      pageEntries: 2,
    });
    await sink.close();
    writeFileSync(join(w.ranges, f.idx.file), o.summary.idx);
    const { createHash } = await import('node:crypto');
    const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
    const partBytes = readFileSync(partPath);
    writeFileSync(
      join(w.ranges, name),
      JSON.stringify({ ...f, records: o.records, digest: sha(partBytes), size: partBytes.length, idx: { ...f.idx, digest: sha(o.summary.idx), size: o.summary.idx.length } }),
    );
    // Without the inputs, every structural check passes.
    const blind = await call(main, assembleArgs(w, join(dir, 'blind')));
    assert.equal(blind.code, EXIT.ok, blind.text);
    // The second pass over the inputs finds the key the part lacks.
    const r = await call(main, assembleArgs(w, join(dir, 'asm'), ['--inputs', w.inputsDir]));
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(
      r.text,
      new RegExp(`assemble: FAIL count the output holds (\\d+) record\\(s\\) and its inputs \\d+ distinct key\\(s\\): the output lacks the key "${dropped.key.replaceAll('.', '\\.')}" of its inputs`),
    );
  }));

test('assemble cli: a range missing, parts out of order, a count that disagrees or a changed part is a fault, exit 1', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir);
    const plant = (label, fn) => {
      const d = join(dir, label);
      cpSync(w.ranges, d, { recursive: true });
      fn(d);
      return { ...w, ranges: d };
    };
    const edit = (d, name, change) => writeFileSync(join(d, name), JSON.stringify(change(JSON.parse(readFileSync(join(d, name), 'utf8')))));
    const cases = [
      [plant('missing', (d) => rmSync(join(d, 'range.key.001.json'))), /FAIL plan range 1 of 3 is missing/],
      [
        plant('order', (d) => {
          edit(d, 'range.key.001.json', (f) => ({ ...f, part: 2 }));
          edit(d, 'range.key.002.json', (f) => ({ ...f, part: 1 }));
        }),
        /FAIL plan range 1 wrote part 2, where part 1 belongs/,
      ],
      [plant('count', (d) => edit(d, 'range.key.001.json', (f) => ({ ...f, records: f.records + 1 }))), /FAIL range range 1: its index holds \d+ records and its output says \d+/],
      [
        plant('part', (d) => {
          const p = join(d, 'part.001');
          const b = readFileSync(p);
          b[b.length - 1] ^= 1;
          writeFileSync(p, b);
        }),
        /FAIL fault .*part\.001 is \d+ B hashing to sha256:[0-9a-f]{64}; its range file says/,
      ],
      [plant('writers', (d) => edit(d, 'range.key.001.json', (f) => ({ ...f, writer: 'zlib-x' }))), /FAIL fault the ranges of the key copy were written by .+ and .+: one zlib build writes one pack/],
      [plant('of', (d) => edit(d, 'range.key.001.json', (f) => ({ ...f, of: 4 }))), /FAIL fault range 1 of the key copy is of 4 ranges; the plan cuts 3/],
      [
        plant('idx', (d) => {
          const p = join(d, 'range.key.001.idx');
          const b = readFileSync(p);
          b[b.length - 1] ^= 1;
          writeFileSync(p, b);
        }),
        /FAIL fault .*range\.key\.001\.idx hashes to sha256:[0-9a-f]{64}; its range file says sha256:/,
      ],
      [
        // The names inputs share keys; ranges that say none does disagree with their own count.
        plant('disjoint', (d) => {
          for (const n of ['range.key.000.json', 'range.key.001.json', 'range.key.002.json']) edit(d, n, (f) => ({ ...f, disjoint: true }));
        }),
        /FAIL count the ranges hold \d+ records; the inputs hold \d+, and the ranges say no key is in two inputs/,
      ],
    ];
    for (const [planted, why] of cases) {
      const r = await call(main, assembleArgs(planted, join(planted.ranges, 'asm')));
      assert.equal(r.code, EXIT.fault, r.text);
      assert.match(r.text, why);
    }
  }));

test('assemble cli: a part file not there, or an output directory that holds the files, is exit 2', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir);
    const out = join(dir, 'asm');
    assert.equal((await call(main, assembleArgs(w, out))).code, EXIT.ok);
    const again = await call(main, assembleArgs(w, out));
    assert.equal(again.code, EXIT.usage, again.text);
    assert.match(again.text, /idx exists: assemble writes into a new directory/);
    rmSync(join(w.ranges, 'part.001'));
    const gone = await call(main, assembleArgs(w, join(dir, 'asm2')));
    assert.equal(gone.code, EXIT.usage, gone.text);
    assert.match(gone.text, /range 1 of the key copy: .*part\.001 does not exist/);
  }));

test('assemble cli: a time copy written by another build than the key copy is a fault, exit 1', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir, 'feed');
    for (const n of readdirSync(w.ranges).filter((x) => /^range\.time\.\d{3}\.json$/.test(x))) {
      const p = join(w.ranges, n);
      writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), writer: 'zlib-x' }));
    }
    const r = await call(main, assembleArgs(w, join(dir, 'asm')));
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /assemble: FAIL fault the time copy was written by zlib-x and the key copy by /);
  }));

test('assemble cli: a feed week merges its time copy by range when no key is in two inputs, and sorts it otherwise', () =>
  inTmp(async (dir) => {
    const merged = await rangedWeek(join(dir, 'm'), 'feed');
    assert.equal(merged.plan.time.mode, 'merge');
    const out = join(dir, 'm-asm');
    const r = await call(main, assembleArgs(merged, out, ['--inputs', merged.inputsDir]));
    assert.equal(r.code, EXIT.ok, r.text);
    assert.match(r.text, /^check time: merged, \d+ part\(s\), bound to the key copy$/m);
    assert.match(r.out.at(-1), /^assembled feed:feed-w-2026w43 sha256:[0-9a-f]{64} records \d+ parts \d+ time merged$/);
    const v = await verifyAssembled(out, 'dataset,length,count,sha256,time');
    assert.equal(v.code, 0, v.text);
    // A key of day 0 in day 3 too: the ranges write no time part, and assemble sorts.
    const shared = await rangedWeek(join(dir, 's'), 'feed', { sharedKey: true });
    assert.match(shared.rangeText, /^time sort: a key is in two inputs; assemble\.mjs sorts the time copy$/m);
    const sout = join(dir, 's-asm');
    const s = await call(main, assembleArgs(shared, sout));
    assert.equal(s.code, EXIT.ok, s.text);
    assert.match(s.text, /^check time: sorted, 1 part\(s\), bound to the key copy$/m);
    assert.ok(existsSync(join(sout, 'time.part.000')));
    const sv = await verifyAssembled(sout, 'dataset,length,count,sha256,time');
    assert.equal(sv.code, 0, sv.text);
  }));

test('assemble cli: time parts of another week, whole and of the same count, do not bind to the key copy, exit 1', () =>
  inTmp(async (dir) => {
    const a = await rangedWeek(join(dir, 'a'), 'feed');
    // The same rows a week earlier: the time copy holds as many rows, at other times.
    const b = await rangedWeek(join(dir, 'b'), 'feed', { monday: '2026-10-12T00:00:00Z' });
    for (const n of readdirSync(a.ranges).filter((x) => x.startsWith('range.time.') || x.startsWith('time.part.'))) rmSync(join(a.ranges, n));
    for (const n of readdirSync(b.ranges).filter((x) => x.startsWith('range.time.') || x.startsWith('time.part.'))) {
      const bytes = readFileSync(join(b.ranges, n));
      writeFileSync(join(a.ranges, n), n.endsWith('.json') ? JSON.stringify({ ...JSON.parse(bytes.toString('utf8')), plan: a.plan.id }) : bytes);
    }
    const r = await call(main, assembleArgs(a, join(dir, 'asm')));
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /assemble: FAIL time the time copy's rows run from first_seen \d+ to \d+, outside the span/);
  }));

test('assemble cli: no run id, one source with no precision, or inputs under two lists for a keyed dataset is refused', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir);
    const noRun = await call(main, ['--plan', w.planPath, '--dir', w.ranges, '--out', join(dir, 'x'), '--tags', w.tags]);
    assert.equal(noRun.code, EXIT.usage, noRun.text);
    assert.match(noRun.text, /is not a workflow run id/);
    // A run id off its grammar (WORKFLOW_RUN_ID): a leading zero, 21 digits, a letter, local.
    for (const run of ['0', '01', '1e3', `1${'0'.repeat(20)}`, 'local']) {
      const bad = await call(main, ['--plan', w.planPath, '--dir', w.ranges, '--out', join(dir, `r${run.length}`), '--tags', w.tags, '--run', run]);
      assert.equal(bad.code, EXIT.usage, run);
      assert.match(bad.text, /is not a workflow run id/, run);
    }
    // A plan of domains whose inputs were built under two lists.
    const tier = {
      verdict: 'ready',
      dataset: 'domains',
      tier: 'd',
      span: { start: '2026-10-26T00:00:00Z', end: '2026-10-27T00:00:00Z' },
      tag: 'domains-d-20261026',
      reason: 'synthetic',
      inputs: [],
      replaces: [],
      excluded: [],
      missing: [],
      gapDays: [],
      present: null,
      sources: ['thc-ct'],
      psl: [PSL, '0'.repeat(64)],
      records: 0,
    };
    const planPath = join(dir, 'two-lists.json');
    writeFileSync(planPath, JSON.stringify(planFile({ plan: tier, root: `sha256:${'1'.repeat(64)}`, key: { cuts: [], ranges: 1, bytes: [0], total: 0 }, time: null })));
    const two = await call(main, ['--plan', planPath, '--dir', w.ranges, '--out', join(dir, 'y'), '--tags', w.tags, '--run', '1', '--precision', 'day']);
    assert.equal(two.code, EXIT.fault, two.text);
    assert.match(two.text, /FAIL psl the domains inputs were built under/);
    const oneSource = await call(main, ['--plan', planPath, '--dir', w.ranges, '--out', join(dir, 'z'), '--tags', w.tags, '--run', '1']);
    assert.equal(oneSource.code, EXIT.usage, oneSource.text);
    assert.match(oneSource.text, /give --precision day or second/);
    assert.equal(codecOf('names'), NAMES_CODEC);
  }));

test('assemble cli: a feed plan of one list given --psl of another list is refused, FAIL psl, exit 1: its keys depend on the list', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir, 'feed');
    assert.deepEqual(w.plan.psl, [PSL]);
    const other = '0'.repeat(64);
    const r = await call(main, assembleArgs(w, join(dir, 'asm'), ['--psl', other]));
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /^assemble: FAIL psl the feed inputs were built under /m);
    assert.equal(existsSync(join(dir, 'asm')), false);
    // The inputs' own list passes.
    const same = await call(main, assembleArgs(w, join(dir, 'same'), ['--psl', PSL]));
    assert.equal(same.code, EXIT.ok, same.text);
  }));

// The plan file at `path` with `change` applied and its id made again, as
// plan.mjs would write it: count and range files then name the new id.
function reIdPlan(path, change) {
  const { id: _, ...body } = change(JSON.parse(readFileSync(path, 'utf8')));
  writeFileSync(path, `${JSON.stringify({ ...body, id: createHash('sha256').update(canonical(body)).digest('hex') })}\n`);
}

test('assemble cli: a names plan built under two lists needs --psl, exit 2 without it; with one of them it assembles under that list', () =>
  inTmp(async (dir) => {
    const w = await plannedWeek(dir, 'names', 3);
    const other = '0'.repeat(64);
    reIdPlan(w.planPath, (p) => ({ ...p, psl: [other, PSL] }));
    const ranges = join(dir, 'ranges');
    const x = await call(rangeMain, ['all', '--plan', w.planPath, '--inputs', w.inputsDir, '--out', ranges]);
    assert.equal(x.code, 0, x.text);
    const tags = join(dir, 'tags.json');
    writeFileSync(tags, '[]');
    const args = (out, more = []) => ['--plan', w.planPath, '--dir', ranges, '--out', out, '--tags', tags, '--run', '7', ...more];
    const none = await call(main, args(join(dir, 'none')));
    assert.equal(none.code, EXIT.usage, none.text);
    assert.match(none.text, /^assemble: the inputs were built under 2 lists: give --psl$/m);
    // The keys of names do not depend on the list: the pinned one is taken, here the second.
    const pinned = await call(main, args(join(dir, 'pinned'), ['--psl', PSL]));
    assert.equal(pinned.code, EXIT.ok, pinned.text);
    assert.equal(JSON.parse(readFileSync(join(dir, 'pinned', 'manifest.json'), 'utf8')).annotations['dev.pkgforge.domains.psl'], PSL);
  }));

test('assemble cli: a plan whose verdict is not ready is exit 2: there is nothing to assemble', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir);
    const tier = {
      verdict: 'wait',
      dataset: 'names',
      tier: 'w',
      span: { start: '2026-10-19T00:00:00Z', end: '2026-10-26T00:00:00Z' },
      tag: 'names-w-2026w43',
      reason: 'synthetic',
      inputs: [],
      replaces: [],
      excluded: [],
      missing: [{ start: '2026-10-22T00:00:00Z', end: '2026-10-23T00:00:00Z', why: 'no d pack covers it', found: [] }],
      gapDays: [],
      present: null,
      sources: ['oi-cs', 'thc-ct'],
      psl: [PSL],
      records: 0,
    };
    const planPath = join(dir, 'wait.json');
    writeFileSync(planPath, JSON.stringify(planFile({ plan: tier, root: `sha256:${'1'.repeat(64)}`, key: null, time: null })));
    const r = await call(main, ['--plan', planPath, '--dir', w.ranges, '--out', join(dir, 'asm'), '--tags', w.tags, '--run', '7']);
    assert.equal(r.code, EXIT.usage, r.text);
    assert.match(r.text, /^assemble: the plan's verdict is wait: there is nothing to assemble$/m);
  }));

// The 24 hour packs of a new-name day, 5 names each and no name in two hours.
// An hour pack carries no time copy (TIME_COPY_TIERS is d to y), so the day's
// time copy is sorted however disjoint its keys.
async function newNameDay(dir) {
  const inDir = join(dir, 'in');
  const inputs = [];
  for (let h = 0; h < 24; h += 1) {
    const start = `2026-10-26T${String(h).padStart(2, '0')}:00:00Z`;
    const end = new Date(Date.parse(start) + 3_600_000).toISOString().replace('.000Z', 'Z');
    const tag = tierTag('new-name', 'h', start);
    const at = join(inDir, tag);
    mkdirSync(at, { recursive: true });
    const t0 = (Date.parse(start) - EPOCH_MS) / 1000;
    const rows = keysOf(h, 5, 300, `.h${h}`).map((key, i) => ({ key, flags: 0, firstSeen: t0 + 600 * i, sources: [1], basis: 4, confidence: 0, feedFlags: 0 }));
    const sink = new DirPartsSink(at, 'key');
    const summary = await writePack(rows, { codec: NEW_NAME_CODEC, compress: nodeCompress, sink, recordsPerBlock: 4, pageEntries: 2 });
    await sink.close();
    writeFileSync(join(at, IDX_TITLE), summary.idx);
    const parts = [];
    for (const f of sink.files) parts.push(await fileDigest(f));
    const idx = { digest: `sha256:${createHash('sha256').update(summary.idx).digest('hex')}`, size: summary.idx.length };
    const manifest = packManifest({ dataset: 'new-name', tier: 'h', span: { start, end }, tag, sources: ['oi-cs', 'thc-ct'], psl: PSL, run: '1', summary, writer: writerId(), parts, idx, time: null });
    inputs.push({ tag, dir: at, manifest, summary, keys: rows.map((r) => r.key), time: null });
  }
  const root = await rootOf('new-name', inputs);
  const rootPath = join(dir, 'root.json');
  writeFileSync(rootPath, JSON.stringify(root));
  return { inputs, inDir, rootPath };
}

test('assemble cli: a new-name day of hour packs, no key in two of them, sorts its time copy, and the verifier passes it', () =>
  inTmp(async (dir) => {
    const d = await newNameDay(dir);
    const planPath = join(dir, 'plan.json');
    const p = await call(planMain, [
      '--dataset',
      'new-name',
      '--tier',
      'd',
      '--span',
      '2026-10-26T00:00:00Z',
      '--root',
      d.rootPath,
      '--inputs',
      d.inDir,
      '--ranges',
      '2',
      '--records-per-block',
      '4',
      '--page-entries',
      '2',
      '--out',
      planPath,
    ]);
    assert.equal(p.code, 0, p.text);
    assert.match(p.text, /^ranges time 1 sort$/m);
    const ranges = join(dir, 'ranges');
    const r = await call(rangeMain, ['all', '--plan', planPath, '--inputs', d.inDir, '--out', ranges]);
    assert.equal(r.code, 0, r.text);
    for (const n of readdirSync(ranges).filter((x) => /^range\.key\.\d{3}\.json$/.test(x))) assert.equal(JSON.parse(readFileSync(join(ranges, n), 'utf8')).disjoint, true, n);
    writeFileSync(join(dir, 'tags.json'), '[]');
    const out = join(dir, 'asm');
    const a = await call(main, ['--plan', planPath, '--dir', ranges, '--out', out, '--tags', join(dir, 'tags.json'), '--run', '7', '--inputs', d.inDir]);
    assert.equal(a.code, EXIT.ok, a.text);
    assert.match(a.text, /^check time: sorted, 1 part\(s\), bound to the key copy$/m);
    assert.match(a.out.at(-1), /^assembled feed:new-name-d-20261026 sha256:[0-9a-f]{64} records 120 parts \d+ time sorted$/);
    const v = await verifyAssembled(out, 'dataset,length,count,sha256,time');
    assert.equal(v.code, 0, v.text);
  }));

// A copy of the range files in `dir` named `label`, with `fn` planted in it.
function planted(w, dir, label, fn) {
  const d = join(dir, label);
  cpSync(w.ranges, d, { recursive: true });
  fn(d);
  return { ...w, ranges: d };
}
const editJson = (d, name, change) => writeFileSync(join(d, name), JSON.stringify(change(JSON.parse(readFileSync(join(d, name), 'utf8')))));

test('assemble cli: the merge count is held both ways: the inputs records with a range saying a key is shared, or more than the inputs with none saying so, is a fault, exit 1', () =>
  inTmp(async (dir) => {
    // A feed week: no key in two days, so every range says none is shared, and the count is the inputs'.
    const w = await rangedWeek(dir, 'feed');
    const ok = await call(main, assembleArgs(w, join(dir, 'ok')));
    assert.equal(ok.code, EXIT.ok, ok.text);
    assert.match(ok.text, new RegExp(`^check key: ${w.plan.records} records in`, 'm'));
    // One range says a key is shared, and the count is still the inputs' records.
    const shared = planted(w, dir, 'shared', (d) => editJson(d, 'range.key.001.json', (f) => ({ ...f, disjoint: false })));
    const s = await call(main, assembleArgs(shared, join(dir, 'shared-asm')));
    assert.equal(s.code, EXIT.fault, s.text);
    assert.match(s.text, new RegExp(`assemble: FAIL count the ranges hold ${w.plan.records} records; the inputs hold ${w.plan.records}, and the ranges say a key is in two inputs`));
    // The last range's part written again with a key no input holds, its files rewritten to match.
    const more = planted(w, dir, 'more', () => undefined);
    const name = 'range.key.002.json';
    const f = JSON.parse(readFileSync(join(more.ranges, name), 'utf8'));
    const partPath = join(more.ranges, f.file);
    const src = filesSource([partPath]);
    const records = [];
    const reader = await PackReader.open(new Uint8Array(readFileSync(join(more.ranges, f.idx.file))), src.source, FEED_CODEC, { partSizes: src.sizes });
    for await (const rec of reader.scan()) records.push(rec);
    await src.close();
    records.push({ ...records.at(-1), key: `${records.at(-1).key}x` });
    const mem = new MemorySink();
    const s2 = await writePack(records, { codec: FEED_CODEC, compress: nodeCompress, sink: mem, recordsPerBlock: 4 });
    const memReader = await PackReader.open(s2.idx, partsSource(mem.parts()), FEED_CODEC);
    rmSync(partPath);
    rmSync(join(more.ranges, f.idx.file));
    const sink = new FileSink(partPath);
    const o = await writeRange([memReader], FEED_CODEC, w.plan.key.cuts, { range: 2, of: 3, part: f.part, offset: 0, skip: 0, take: null, total: null }, sink, {
      compress: nodeCompress,
      recordsPerBlock: 4,
      pageEntries: 2,
    });
    await sink.close();
    writeFileSync(join(more.ranges, f.idx.file), o.summary.idx);
    const sha = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;
    const partBytes = readFileSync(partPath);
    writeFileSync(
      join(more.ranges, name),
      JSON.stringify({ ...f, records: o.records, last: o.last, digest: sha(partBytes), size: partBytes.length, idx: { ...f.idx, digest: sha(o.summary.idx), size: o.summary.idx.length } }),
    );
    const m = await call(main, assembleArgs(more, join(dir, 'more-asm')));
    assert.equal(m.code, EXIT.fault, m.text);
    assert.match(m.text, new RegExp(`assemble: FAIL count the ranges hold ${w.plan.records + 1} records; the inputs hold ${w.plan.records}, and the ranges say no key is in two inputs`));
  }));

test('assemble cli: a part that reads corrupt, though its digest is the one its range file names, is a fault, exit 1', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir);
    const bad = planted(w, dir, 'bad', (d) => {
      const p = join(d, 'part.001');
      const b = readFileSync(p);
      b[b.length - 8] ^= 0xff;
      writeFileSync(p, b);
      editJson(d, 'range.key.001.json', (f) => ({ ...f, digest: `sha256:${createHash('sha256').update(b).digest('hex')}` }));
    });
    const r = await call(main, assembleArgs(bad, join(dir, 'asm')));
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /^assemble: FAIL (crc|inflate) /m);
  }));

test('assemble cli: an output directory that is a file, or under a file, is exit 2 before anything is read', () =>
  inTmp(async (dir) => {
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    for (const [out, why] of [
      [file, /assemble: --out .*file: .*file is a file, not a directory/],
      [join(file, 'sub'), /assemble: --out .*sub: .*file is a file, not a directory/],
    ]) {
      const r = await call(main, ['--plan', join(dir, 'no-such-plan.json'), '--dir', dir, '--out', out, '--run', '7']);
      assert.equal(r.code, EXIT.usage, r.text);
      assert.match(r.text, why);
    }
  }));

test('assemble cli: each error class has its exit code: a defect 70, GHCR unreachable 2, a usage error 2, a fault 1', () =>
  inTmp(async (dir) => {
    const w = await rangedWeek(dir);
    const cases = [
      [new TypeError('a defect'), EXIT.internal, /^assemble: internal error: TypeError: a defect/m],
      [new GhcrError('unreachable', 'no route to ghcr.io'), EXIT.usage, /^assemble: no route to ghcr\.io$/m],
      [new RateLimitError('429 past the cap'), EXIT.usage, /^assemble: 429 past the cap$/m],
      [new CompactError('usage', 'a call out of bounds'), EXIT.usage, /^assemble: FAIL usage a call out of bounds$/m],
      [new CompactError('count', 'a count that disagrees'), EXIT.fault, /^assemble: FAIL count a count that disagrees$/m],
      [new PackError('crc', 'a block that does not read'), EXIT.fault, /^assemble: FAIL crc a block that does not read$/m],
      [new Fault('a list cut short'), EXIT.fault, /^assemble: FAIL fault a list cut short$/m],
    ];
    for (const [i, [e, code, line]] of cases.entries()) {
      const reader = {
        listTags: async () => {
          throw e;
        },
      };
      const r = await call(main, ['--plan', w.planPath, '--dir', w.ranges, '--out', join(dir, `o${i}`), '--run', '7'], { reader });
      assert.equal(r.code, code, `${e.name} ${e.message}\n${r.text}`);
      assert.match(r.text, line);
    }
  }));
