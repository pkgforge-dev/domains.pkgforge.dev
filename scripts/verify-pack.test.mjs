// scripts/verify-pack.mjs as a process, on the synthetic fixtures of
// packages/pack/test/verify (make-fixtures.ts) and on packs written to a
// temporary directory. Each exit code is read from the process itself. No test
// reaches the network; every name is synthetic.
//
//   node scripts/test.mjs scripts --name "verify-pack"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writeFeedPack } from '@domains/feed';
import { nodeCompress, writePackFiles } from '../packages/pack/node/index.ts';
import { MemorySink, NAMES_CODEC } from '../packages/pack/src/index.ts';
import { CHECKS, quoteKey } from '../packages/pack/src/verify.ts';
import { CLEAN_COUNT, CLEAN_SEED, syntheticNames, syntheticRegistry } from '../packages/pack/test/verify/synthetic.ts';
import { ROOT } from './files.mjs';
import { artifactType, GhcrError } from '@domains/ghcr';
import { registry } from './root/fixture.mjs';
import { lines, openPack, packFiles, parseFlags, readAt, readRanged, UsageError, main as verifyMain } from './verify-pack.mjs';

const SCRIPT = fileURLToPath(new URL('./verify-pack.mjs', import.meta.url));
const FIX = 'packages/pack/test/verify';
const CLEAN = [`${FIX}/clean.part.000`, `${FIX}/clean.idx`];
const REGISTRY = `${FIX}/registry.json`;

function run(args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr, lines: stdout.split('\n').filter((l) => l !== '') }));
  });
}

const statusOf = (r) => Object.fromEntries(r.lines.filter((l) => !l.startsWith('VERDICT')).map((l) => [l.split(' ')[1], l.split(' ')[0]]));

function withTemp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-pack-'));
  return Promise.resolve(fn(dir)).finally(() => rmSync(dir, { recursive: true, force: true }));
}

// Seven accepted days before 2026-10-26, `count` records each.
const history = (count) => Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${String(19 + i).padStart(2, '0')}`, count, quarantined: false }));

// The default flags: no annotation, no --expect-*, no --source, no --history.
// Every check that compares the pack with something it was not given skips, and
// the verdict line counts them.
const DEFAULT_SKIPS = ['dataset', 'length', 'count', 'sha256', 'time', 'psl', 'sources', 'precision', 'volume'];

test('verify-pack: the clean fixture with the default flags exits 0, skips every check with nothing to compare, and the verdict counts them', async () => {
  const r = await run(CLEAN);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stderr, '');
  assert.equal(r.lines.length, CHECKS.length + 1);
  const s = statusOf(r);
  assert.deepEqual(Object.keys(s), [...CHECKS]);
  for (const check of CHECKS) assert.equal(s[check], DEFAULT_SKIPS.includes(check) ? 'SKIP' : 'PASS', check);
  assert.equal(r.lines.at(-1), `VERDICT ok (${DEFAULT_SKIPS.length} skipped)`);
  assert.match(r.lines[0], /^PASS idx 1 part\(s\), 10 block\(s\) in 3 page\(s\), 600 record\(s\)$/);
  // Nothing to compare against: skipped, not passed.
  assert.match(r.stdout, /^SKIP dataset no dataset annotation to compare; the index is dataset 1 \(names\), which this verifier checks$/m);
  assert.match(r.stdout, /^SKIP length no bytes annotation to compare; the parts hold 6619 B as the index says, 7291 B with the index$/m);
  assert.match(r.stdout, /^SKIP count no count annotation to compare; the blocks hold 600 records, as the index header says$/m);
  assert.match(r.stdout, /^SKIP sha256 no sha256 annotation; the raw blocks hash to [0-9a-f]{64}$/m);
  assert.match(r.stdout, /^SKIP psl /m);
  const json = await run(['--json', ...CLEAN]);
  assert.equal(json.code, 0, json.stderr);
  assert.deepEqual(JSON.parse(json.stdout).unverified, DEFAULT_SKIPS);
});

test('verify-pack: --require exits 1 with VERDICT unverified when a check it names skipped, and 0 when each was compared', async () => {
  const r = await run(['--require', 'count,sha256', ...CLEAN]);
  assert.equal(r.code, 1, r.stdout + r.stderr);
  assert.equal(
    r.lines.some((l) => l.startsWith('FAIL')),
    false,
  );
  assert.equal(r.lines.at(-1), `VERDICT unverified (${DEFAULT_SKIPS.length} skipped; required and skipped: count, sha256)`);
  const ok = await run(['--require', 'dataset,length,count,sha256,psl,sources,precision', '--annotations', `${FIX}/clean.annotations.json`, '--sources', REGISTRY, ...CLEAN]);
  assert.equal(ok.code, 0, ok.stdout + ok.stderr);
  assert.equal(ok.lines.at(-1), 'VERDICT ok (2 skipped)');
  // Every check but time and volume, with the default flags: the seven that skipped are named.
  const every = await run(['--require', CHECKS.filter((c) => c !== 'volume' && c !== 'time').join(','), ...CLEAN]);
  assert.equal(every.code, 1, every.stdout + every.stderr);
  assert.equal(every.lines.at(-1), 'VERDICT unverified (9 skipped; required and skipped: dataset, length, count, sha256, psl, sources, precision)');
});

test('verify-pack: the clean fixture with its annotations and the synthetic registry passes every check but the time copy and the volume', async () => {
  const r = await run(['--annotations', `${FIX}/clean.annotations.json`, '--sources', REGISTRY, ...CLEAN]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const s = statusOf(r);
  for (const check of CHECKS) assert.equal(s[check], check === 'volume' || check === 'time' ? 'SKIP' : 'PASS', check);
  assert.match(r.stdout, /^SKIP time no time copy given$/m);
  assert.equal(r.lines.at(-1), 'VERDICT ok (2 skipped)');
  assert.match(r.stdout, /^PASS precision the registry's precision; every time inside the span 2026-10-26T00:00:00Z to 2026-10-27T00:00:00Z$/m);
});

test('verify-pack: truncated.part.000 with the clean index exits 1 and prints FAIL length', async () => {
  const r = await run([`${FIX}/truncated.part.000`, `${FIX}/clean.idx`]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /^FAIL length part\.000 holds 3309 B, the index says 6619 B$/m);
  assert.deepEqual(
    r.lines.filter((l) => l.startsWith('FAIL')).map((l) => l.split(' ')[1]),
    ['length'],
  );
  // idx passed and dataset had no annotation; the 16 checks after length did not run.
  assert.equal(r.lines.at(-1), 'VERDICT fail (17 skipped)');
});

test('verify-pack: --expect-count 1 on the pack of two records exits 1 with FAIL count', async () => {
  const r = await run(['--expect-count', '1', `${FIX}/pair.part.000`, `${FIX}/pair.idx`]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /^FAIL count the pack holds 2 records, the count annotation says 1$/m);
  const ok = await run(['--expect-count', '2', `${FIX}/pair.part.000`, `${FIX}/pair.idx`]);
  assert.equal(ok.code, 0, ok.stdout);
});

test('verify-pack: a count at 39% of the history median exits 1 with a quarantine, and at 60% exits 0', () =>
  withTemp(async (dir) => {
    // A segment of the one day source: the 600 synthetic names with bit 0 alone.
    const segment = syntheticNames(CLEAN_COUNT, CLEAN_SEED).map((r) => ({ ...r, sources: r.sources.filter((s) => s.bit === 0) }));
    await writePackFiles(segment, join(dir, 'pack'), { codec: NAMES_CODEC });
    const low = join(dir, 'low.json');
    const usual = join(dir, 'usual.json');
    writeFileSync(low, JSON.stringify(history(1539)));
    writeFileSync(usual, JSON.stringify(history(1000)));
    const base = ['--source', 'thc-ct', '--sources', REGISTRY, '--span', '2026-10-26T00:00:00Z,2026-10-27T00:00:00Z', join(dir, 'pack')];
    const q = await run(['--history', low, ...base]);
    assert.equal(q.code, 1, q.stdout + q.stderr);
    assert.match(q.stdout, /^FAIL volume quarantine \(below\): 600 against the median 1539 of thc-ct/m);
    // dataset, length, count, sha256 and psl have no annotation to compare, and no time copy is given.
    assert.equal(q.lines.at(-1), 'VERDICT quarantine (6 skipped)');
    const ok = await run(['--history', usual, ...base]);
    assert.equal(ok.code, 0, ok.stdout + ok.stderr);
    assert.match(ok.stdout, /^PASS volume ok \(within\): 600 against the median 1000 of thc-ct/m);
    // A count band takes no --raw-bytes.
    const extra = await run(['--history', usual, '--raw-bytes', '1000', ...base]);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /measures the record count, so --raw-bytes does not apply/);
    // A band of bytes judges --raw-bytes, not the count: 1000 is 65% of 1539,
    // where the count of 600 is 39%.
    const bytesRegistry = join(dir, 'registry.json');
    const reg = syntheticRegistry();
    reg.sources[0].band = { ...reg.sources[0].band, metric: 'bytes' };
    writeFileSync(bytesRegistry, JSON.stringify(reg));
    const bytesBase = ['--history', low, '--source', 'thc-ct', '--sources', bytesRegistry, join(dir, 'pack')];
    const none = await run(bytesBase);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /the band of thc-ct measures the bytes of the raw file: give --raw-bytes/);
    const byBytes = await run(['--raw-bytes', '1000', ...bytesBase]);
    assert.equal(byBytes.code, 0, byBytes.stdout + byBytes.stderr);
    assert.match(byBytes.stdout, /^PASS volume ok \(within\): 1000 against the median 1539 of thc-ct/m);
    // A history that checkBand refuses cannot run.
    writeFileSync(low, JSON.stringify([{ day: '2026-10-19', count: -1, quarantined: false }]));
    const bad = await run(['--history', low, ...base]);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /^verify-pack: could not run: history\[0\]\.count/);
  }));

test('verify-pack: a pack of no record exits 0 and prints SKIP, not PASS, for the checks over its blocks and for refind', () =>
  withTemp(async (dir) => {
    await writePackFiles([], join(dir, 'pack'), { codec: NAMES_CODEC });
    const r = await run([join(dir, 'pack')]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    for (const check of ['inflate', 'crc', 'record', 'order', 'unique', 'name']) assert.match(r.stdout, new RegExp(`^SKIP ${check} the pack holds no block$`, 'm'));
    assert.match(r.stdout, /^SKIP refind the pack holds no record to find$/m);
    assert.equal(r.lines.at(-1), `VERDICT ok (${DEFAULT_SKIPS.length + 7} skipped)`);
    const required = await run(['--require', 'refind', join(dir, 'pack')]);
    assert.equal(required.code, 1, required.stdout + required.stderr);
    assert.equal(required.lines.at(-1), `VERDICT unverified (${DEFAULT_SKIPS.length + 7} skipped; required and skipped: refind)`);
  }));

test('verify-pack: a source the registry does not hold is a FAIL sources, read from config/sources.json by default', async () => {
  const r = await run(['--source', 'no-such-source', ...CLEAN]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /^FAIL sources the source no-such-source is not in the registry$/m);
});

test('verify-pack: a key is never printed past 80 bytes, nor a control byte as itself', () =>
  withTemp(async (dir) => {
    const key = `com.\x1b${'Q'.repeat(60)}.${'q'.repeat(60)}.${'z'.repeat(60)}`;
    await writePackFiles([{ key, flags: 1, sources: [{ bit: 0, first: 298, last: 298 }] }], join(dir, 'pack'), { codec: NAMES_CODEC });
    for (const json of [false, true]) {
      const r = await run([...(json ? ['--json'] : []), join(dir, 'pack')]);
      assert.equal(r.code, 1, r.stderr);
      assert.equal(r.stdout.includes('\x1b'), false);
      assert.equal(r.stdout.includes(key.slice(5, 81)), false);
      assert.ok(r.stdout.includes(json ? JSON.stringify(quoteKey(key)).slice(1, -1) : quoteKey(key)), r.stdout);
    }
  }));

test('verify-pack: --json prints the result as one object', async () => {
  const r = await run(['--json', ...CLEAN]);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, true);
  assert.equal(out.verdict, 'ok');
  assert.deepEqual(
    out.checks.map((c) => c.check),
    [...CHECKS],
  );
  assert.equal(out.stats.records, 600);
});

test('verify-pack: a usage error, a file it cannot read or a bad annotation exits 2', () =>
  withTemp(async (dir) => {
    const notJson = join(dir, 'a.json');
    writeFileSync(notJson, '{');
    const badCount = join(dir, 'b.json');
    writeFileSync(badCount, JSON.stringify({ 'dev.pkgforge.domains.count': 'six hundred' }));
    const cases = [
      [[], /give the index and the parts/],
      [['--nope', ...CLEAN], /unknown flag --nope/],
      [['--expect-count', 'x', ...CLEAN], /--expect-count must be a whole number/],
      [['--span', '2026-10-26T00:00:00Z', ...CLEAN], /--span takes START,END/],
      [[`${FIX}/clean.part.000`], /no index is given/],
      [[...CLEAN, `${FIX}/pair.idx`], /two indexes are given/],
      [[`${FIX}/clean.part.000`, `${FIX}/truncated.part.000`, `${FIX}/clean.idx`], /part 0 is given twice/],
      [[`${FIX}/registry.json`, ...CLEAN], /named neither as a part/],
      [[`${FIX}/no-such.part.000`, `${FIX}/clean.idx`], /cannot read/],
      [['--annotations', notJson, ...CLEAN], /the annotations .*a\.json/],
      [['--annotations', badCount, ...CLEAN], /count is "six hundred", not a whole number/],
      [['--history', notJson, ...CLEAN], /--history needs the pack to name exactly one source/],
      [['--raw-bytes', '5', ...CLEAN], /--raw-bytes needs --history/],
      [['--psl', notJson, ...CLEAN], /could not run/],
      [['--span', '2026-10-27T00:00:00Z,2026-10-26T00:00:00Z', ...CLEAN], /ends before it starts/],
      [['--require', 'count,bytes', ...CLEAN], /--require names "bytes", which is not a check; the checks are idx, dataset, length,/],
      [['--require', 'count,', ...CLEAN], /--require names "", which is not a check/],
    ];
    for (const [args, pattern] of cases) {
      const r = await run(args);
      assert.equal(r.code, 2, `${args.join(' ')}: ${r.stdout}`);
      assert.match(r.stderr, pattern, args.join(' '));
      assert.equal(r.stdout, '', args.join(' '));
    }
  }));

test('verify-pack: parseFlags keeps a PATH after --json, and packFiles refuses a gap in the parts', () => {
  assert.deepEqual(parseFlags(['--json', 'a.idx']).paths, ['a.idx']);
  assert.equal(parseFlags(['--json', 'a.idx']).json, true);
  withTempSync((dir) => {
    for (const name of ['idx', 'part.000', 'part.002']) writeFileSync(join(dir, name), '');
    assert.throws(
      () => packFiles([dir]),
      (e) => e instanceof UsageError && /part 1 is not given, and part 2 is/.test(e.message),
    );
  });
});

test('verify-pack: lines prints one line a failure and writes a control byte of a detail as an escape', () => {
  const result = {
    verdict: 'fail',
    unverified: ['sha256', 'psl'],
    checks: [
      { check: 'idx', status: 'pass', detail: 'synthetic' },
      { check: 'name', status: 'fail', detail: 'a\x1b[2Jb' },
    ],
    errors: [
      { check: 'name', detail: 'a\x1b[2Jb' },
      { check: 'name', detail: 'c\nd\x9be' },
    ],
  };
  assert.deepEqual(lines(result), ['PASS idx synthetic', 'FAIL name a\\x1b[2Jb', 'FAIL name c\\x0ad\\x9be', 'VERDICT fail (2 skipped)']);
  assert.equal(lines({ ...result, verdict: 'unverified' }, ['count', 'psl', 'sha256']).at(-1), 'VERDICT unverified (2 skipped; required and skipped: psl, sha256)');
});

test('verify-pack: a read is never sized past the end of its file, however long the range the index asks', async () => {
  const pack = await openPack(packFiles([`${FIX}/pair.part.000`, `${FIX}/pair.idx`]));
  try {
    const part = readFileSync(`${FIX}/pair.part.000`);
    const idx = readFileSync(`${FIX}/pair.idx`);
    // 2^40 B: a buffer of that length cannot be allocated, so only a read
    // sized by the file answers.
    assert.deepEqual(Buffer.from(await pack.parts.read(0, 0, 2 ** 40)), part);
    assert.deepEqual(Buffer.from(await pack.idx.read(0, 2 ** 40)), idx);
    assert.deepEqual(Buffer.from(await pack.parts.read(0, 60, 2 ** 40)), part.subarray(60));
    assert.equal((await pack.parts.read(0, part.length + 10, 2 ** 40)).length, 0);
  } finally {
    await pack.close();
  }
});

test('verify-pack: readAt asks again when a read answers part of the range', async () => {
  const bytes = readFileSync(`${FIX}/pair.part.000`);
  const handle = await open(`${FIX}/pair.part.000`, 'r');
  try {
    // A handle that answers at most 5 bytes a read, as a pipe or a slow disk may.
    const trickle = { read: (buffer, at, length, position) => handle.read(buffer, at, Math.min(length, 5), position) };
    assert.deepEqual(Buffer.from(await readAt(trickle, bytes.length, 0, bytes.length)), bytes);
    assert.deepEqual(Buffer.from(await readAt(trickle, bytes.length, 3, 20)), bytes.subarray(3, 23));
  } finally {
    await handle.close();
  }
});

test('verify-pack: an --expect-* flag overrides the annotations file', () =>
  withTemp(async (dir) => {
    const annotations = join(dir, 'annotations.json');
    writeFileSync(annotations, JSON.stringify({ 'dev.pkgforge.domains.count': '5' }));
    const r = await run(['--annotations', annotations, '--expect-count', '6', `${FIX}/pair.part.000`, `${FIX}/pair.idx`]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^FAIL count the pack holds 2 records, the count annotation says 6$/m);
    assert.equal(r.stdout.includes('says 5'), false);
  }));

test('verify-pack: --history needs one source the registry holds, and a history checkBand accepts before any block is read', () =>
  withTemp(async (dir) => {
    const usual = join(dir, 'usual.json');
    writeFileSync(usual, JSON.stringify(history(1000)));
    const two = await run(['--history', usual, '--source', 'thc-ct,ct-le', '--sources', REGISTRY, ...CLEAN]);
    assert.equal(two.code, 2, two.stdout + two.stderr);
    assert.match(two.stderr, /^verify-pack: could not run: --history needs the pack to name exactly one source$/m);
    // Synthetic: an id no registry row holds.
    const absent = await run(['--history', usual, '--source', 'synthetic-absent', '--sources', REGISTRY, ...CLEAN]);
    assert.equal(absent.code, 2, absent.stdout + absent.stderr);
    assert.match(absent.stderr, /^verify-pack: could not run: --history: the source synthetic-absent is not in the registry$/m);
    // A history checkBand refuses, on a pack whose length fails first: the
    // history is refused before the pass, not left unread by a stopped run.
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify([{ day: '2026-10-19', count: -1, quarantined: false }]));
    const cut = await run(['--history', bad, '--source', 'thc-ct', '--sources', REGISTRY, `${FIX}/truncated.part.000`, `${FIX}/clean.idx`]);
    assert.equal(cut.code, 2, cut.stdout + cut.stderr);
    assert.match(cut.stderr, /^verify-pack: could not run: history\[0\]\.count/);
    assert.equal(cut.stdout, '');
  }));

test('verify-pack: a registry with a row that does not validate cannot run', () =>
  withTemp(async (dir) => {
    const registry = syntheticRegistry();
    delete registry.sources[0].adapter;
    const path = join(dir, 'registry.json');
    writeFileSync(path, JSON.stringify(registry));
    const r = await run(['--source', 'thc-ct', '--sources', path, ...CLEAN]);
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /^verify-pack: could not run: .*sources\[0\]\.adapter: missing: required/m);
    assert.equal(r.stdout, '');
  }));

test('verify-pack: the adapter is imported by its package name, which its exports map serves, never by a path into packages/adapter', () => {
  const specifiers = [...readFileSync(SCRIPT, 'utf8').matchAll(/^import .+ from '([^']+)';$/gm)].map((m) => m[1]);
  assert.ok(specifiers.includes('@domains/adapter'), specifiers.join(', '));
  assert.deepEqual(
    specifiers.filter((s) => s.includes('packages/adapter')),
    [],
  );
});

function withTempSync(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-pack-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------- the GHCR form (DOM-020)
//
// The GHCR form against the double of scripts/root/fixture.mjs, which stands
// on packages/testkit's world: the reader is packages/ghcr's, with its
// production dial, and the fixture files are the layers. The same files read
// locally and through GHCR give the same lines, because both forms read
// through readRanged.

const CLEAN_ANNOTATIONS = JSON.parse(readFileSync(join(ROOT, FIX, 'clean.annotations.json'), 'utf8'));
const REQUIRE = 'dataset,length,count,sha256,psl,sources,precision';

async function inRegistry(fn) {
  const reg = registry();
  try {
    await fn(reg);
    assert.deepEqual(reg.w.unusedBodies(), [], 'every GHCR answer body is read or cancelled');
  } finally {
    reg.close();
  }
}

// A pack manifest of the double: `part` and `idx` files of the fixtures as its layers.
const seedFixture = (reg, tag, { part = 'clean.part.000', annotations = CLEAN_ANNOTATIONS, type = artifactType('pack') } = {}) =>
  reg.seed('names', tag, type, annotations, [
    { title: 'part.000', bytes: readFileSync(join(ROOT, FIX, part)) },
    { title: 'idx', bytes: readFileSync(join(ROOT, FIX, 'clean.idx')) },
    { title: 'summary.json', bytes: Buffer.from('{}') },
  ]);

async function inProcess(argv) {
  const out = [];
  const err = [];
  const code = await verifyMain(argv, { write: (t) => out.push(t), err: (l) => err.push(l), sleep: async () => undefined });
  return {
    code,
    lines: out
      .join('')
      .split('\n')
      .filter((l) => l !== ''),
    err: err.join('\n'),
  };
}

test('verify-pack: the GHCR form reads a pack anonymously, takes its annotations, and gives the lines the local form gives for the same files', () =>
  inRegistry(async (reg) => {
    const digest = seedFixture(reg, 'names-d-20261026');
    const ghcr = await inProcess(['--repo', 'names', '--tag', 'names-d-20261026', '--require', REQUIRE, '--sources', REGISTRY]);
    assert.equal(ghcr.code, 0, ghcr.lines.join('\n') + ghcr.err);
    assert.match(ghcr.err, new RegExp(`ghcr\\.io/pkgforge-dev/domains\\.pkgforge\\.dev/names:names-d-20261026 ${digest}, read with no credential`));
    const local = await inProcess(['--annotations', `${FIX}/clean.annotations.json`, '--require', REQUIRE, '--sources', REGISTRY, ...CLEAN]);
    assert.equal(local.code, 0);
    assert.deepEqual(ghcr.lines, local.lines);
    assert.match(ghcr.lines.at(-1), /^VERDICT ok \(2 skipped\)$/);
  }));

test('verify-pack: in the GHCR form, a manifest whose count annotation is removed exits 1 with VERDICT unverified under --require count', () =>
  inRegistry(async (reg) => {
    const { 'dev.pkgforge.domains.count': _dropped, ...rest } = CLEAN_ANNOTATIONS;
    seedFixture(reg, 'names-d-20261026', { annotations: rest });
    const r = await inProcess(['--repo', 'names', '--tag', 'names-d-20261026', '--require', REQUIRE, '--sources', REGISTRY]);
    assert.equal(r.code, 1, r.lines.join('\n'));
    assert.ok(r.lines.includes('SKIP count the count annotation is absent: nothing to compare') || r.lines.some((l) => /^SKIP count /.test(l)), r.lines.join('\n'));
    assert.match(r.lines.at(-1), /^VERDICT unverified \(\d+ skipped; required and skipped: count\)$/);
  }));

test('verify-pack: in the GHCR form, a part layer shorter than the index says fails length, by the layer size the manifest gives', () =>
  inRegistry(async (reg) => {
    seedFixture(reg, 'names-d-20261026', { part: 'truncated.part.000' });
    const r = await inProcess(['--repo', 'names', '--tag', 'names-d-20261026', '--sources', REGISTRY]);
    assert.equal(r.code, 1, r.lines.join('\n'));
    assert.ok(
      r.lines.some((l) => l.startsWith('FAIL length ')),
      r.lines.join('\n'),
    );
  }));

test('verify-pack: the GHCR form refuses a manifest that is not a pack, an absent one, and a mix of the two forms, with exit 2', () =>
  inRegistry(async (reg) => {
    seedFixture(reg, 'ref-like', { type: artifactType('ref') });
    const notPack = await inProcess(['--repo', 'names', '--tag', 'ref-like']);
    assert.equal(notPack.code, 2);
    assert.match(notPack.err, /is "application\/vnd\.pkgforge\.domains\.ref\.v1", not a pack or a segment/);
    // A part layer out of its place, and a manifest with no index.
    reg.seed('names', 'out-of-order', artifactType('pack'), CLEAN_ANNOTATIONS, [
      { title: 'part.001', bytes: readFileSync(join(ROOT, FIX, 'clean.part.000')) },
      { title: 'idx', bytes: readFileSync(join(ROOT, FIX, 'clean.idx')) },
    ]);
    const order = await inProcess(['--repo', 'names', '--tag', 'out-of-order']);
    assert.equal(order.code, 2);
    assert.match(order.err, /the layer part\.001 stands where part\.000 belongs/);
    reg.seed('names', 'no-idx', artifactType('pack'), CLEAN_ANNOTATIONS, [{ title: 'part.000', bytes: readFileSync(join(ROOT, FIX, 'clean.part.000')) }]);
    const noIdx = await inProcess(['--repo', 'names', '--tag', 'no-idx']);
    assert.equal(noIdx.code, 2);
    assert.match(noIdx.err, /holds no idx layer/);
    const absent = await inProcess(['--repo', 'names', '--tag', 'names-d-20260101']);
    assert.equal(absent.code, 2);
    assert.match(absent.err, /could not run: GHCR holds no manifest names-d-20260101/);
    // A digest is a reference too.
    const byDigest = await inProcess(['--repo', 'names', '--tag', `sha256:${'0'.repeat(64)}`]);
    assert.equal(byDigest.code, 2);
    assert.match(byDigest.err, /could not run: GHCR holds no manifest sha256:0{64}/);
    for (const [argv, re] of [
      [['--repo', 'names'], /--repo and --tag come together/],
      [['--repo', 'names', '--tag', 'x', ...CLEAN], /the GHCR form \(--repo, --tag\) takes no PATH/],
      [['--repo', 'names', '--tag', 'x', '--annotations', `${FIX}/clean.annotations.json`], /reads the manifest's own annotations/],
      [['--repo', 'NAMES', '--tag', 'x'], /is not a package name/],
      [['--repo', 'names', '--tag', 'X'], /holds upper case/],
    ]) {
      const r = await inProcess(argv);
      assert.equal(r.code, 2, argv.join(' '));
      assert.match(r.err, re, argv.join(' '));
    }
  }));

// ---------------------------------------------------------------- the time copy (DOM-022)
//
// A feed pack of 300 synthetic rows with its time copy, written by
// writeFeedPack of @domains/feed, as the files a job holds and as the layers
// of a manifest of the double.

const FEED_ROWS = Array.from({ length: 300 }, (_, i) => ({
  key: `com.syn${String(i).padStart(4, '0')}`,
  flags: 0,
  firstSeen: 298 * 86_400 + ((i * 7919) % 300) * 60,
  sources: [0],
  basis: 16,
  confidence: 0,
  feedFlags: 0,
}));

async function feedFiles(rows = FEED_ROWS) {
  const sink = new MemorySink();
  const timeSink = new MemorySink();
  const pack = await writeFeedPack(rows, { compress: nodeCompress, sink, recordsPerBlock: 64, time: { sink: timeSink, recordsPerBlock: 64 } });
  return { idx: pack.summary.idx, parts: sink.parts(), timeIdx: pack.time.idx, timeParts: timeSink.parts() };
}

function writeFiles(dir, f, { time = true } = {}) {
  writeFileSync(join(dir, 'idx'), f.idx);
  for (const [i, p] of f.parts.entries()) writeFileSync(join(dir, `part.${String(i).padStart(3, '0')}`), p);
  if (time) {
    writeFileSync(join(dir, 'time.idx'), f.timeIdx);
    for (const [i, p] of f.timeParts.entries()) writeFileSync(join(dir, `time.part.${String(i).padStart(3, '0')}`), p);
  }
}

test('verify-pack: a directory holding a pack and its time copy passes time, and --require time exits 1 unverified without one', () =>
  withTemp(async (dir) => {
    const f = await feedFiles();
    writeFiles(dir, f);
    const r = await run(['--require', 'time', dir]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^PASS time the time copy \(1 part\(s\), 5 block\(s\)\) holds the 300 rows of the key copy in \(first_seen, key\) order$/m);
    // The same pack without its time copy: SKIP, and unverified under --require time.
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    writeFiles(plain, f, { time: false });
    const none = await run(['--require', 'time', plain]);
    assert.equal(none.code, 1, none.stdout + none.stderr);
    assert.match(none.stdout, /^SKIP time no time copy given$/m);
    assert.match(none.lines.at(-1), /^VERDICT unverified \(\d+ skipped; required and skipped: time\)$/);
    // Files named one by one take the same roles as a directory's.
    const named = await run([join(dir, 'idx'), join(dir, 'part.000'), join(dir, 'time.part.000'), join(dir, 'time.idx')]);
    assert.equal(named.code, 0, named.stdout + named.stderr);
    assert.match(named.stdout, /^PASS time /m);
  }));

test('verify-pack: the time copy of other rows exits 1 with FAIL time and no other failure', () =>
  withTemp(async (dir) => {
    const f = await feedFiles();
    const other = await feedFiles(FEED_ROWS.map((r, i) => (i === 150 ? { ...r, confidence: 4 } : r)));
    writeFiles(dir, { ...f, timeIdx: other.timeIdx, timeParts: other.timeParts });
    const r = await run([dir]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.deepEqual(
      r.lines.filter((l) => l.startsWith('FAIL')).map((l) => l.split(' ')[1]),
      ['time'],
    );
    assert.match(r.stdout, /^FAIL time the time copy's 300 rows are not the 300 rows of the key copy/m);
  }));

test('verify-pack: time parts with no time index, a time index with no part, or two time indexes are usage errors; time.idx is not a second index', () =>
  withTemp(async (dir) => {
    const f = await feedFiles();
    writeFiles(dir, f);
    assert.deepEqual(packFiles([dir]).time, { idx: join(dir, 'time.idx'), parts: [join(dir, 'time.part.000')] });
    assert.equal(packFiles([dir]).idx, join(dir, 'idx'));
    assert.throws(() => packFiles([join(dir, 'idx'), join(dir, 'part.000'), join(dir, 'time.part.000')]), /time parts are given with no time index/);
    assert.throws(() => packFiles([join(dir, 'idx'), join(dir, 'part.000'), join(dir, 'time.idx')]), /a time index is given with no time part/);
    // A second time index, by a prefix before its dot: refused, as a second idx is.
    writeFileSync(join(dir, 'other.time.idx'), f.timeIdx);
    assert.throws(
      () => packFiles([dir]),
      (e) => e instanceof UsageError && /^two time indexes are given: .*other\.time\.idx and .*[\\/]time\.idx$/.test(e.message),
    );
    rmSync(join(dir, 'other.time.idx'));
    writeFileSync(join(dir, 'time.part.002'), f.timeParts[0]);
    assert.throws(() => packFiles([dir]), /time part 1 is not given, and time part 2 is/);
  }));

test('verify-pack: a time part more than the time index names exits 1 with FAIL time and no other failure', () =>
  withTemp(async (dir) => {
    const f = await feedFiles();
    writeFiles(dir, f);
    writeFileSync(join(dir, 'time.part.001'), f.timeParts[0]);
    const r = await run([dir]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    assert.deepEqual(
      r.lines.filter((l) => l.startsWith('FAIL')),
      ["FAIL time the time copy's index names 1 part(s) and 2 were given"],
    );
  }));

test('verify-pack: in the GHCR form, a manifest with the layers time.idx and time.part.NNN passes time, and the same lines come from its files', () =>
  inRegistry(async (reg) =>
    withTemp(async (dir) => {
      const f = await feedFiles();
      const layers = (time) => [
        { title: 'part.000', bytes: f.parts[0] },
        { title: 'idx', bytes: f.idx },
        ...(time === null
          ? []
          : [
              { title: 'time.part.000', bytes: time.parts[0] },
              { title: 'time.idx', bytes: time.idx },
            ]),
      ];
      reg.seed('feed', 'feed-d-20261026', artifactType('pack'), {}, layers({ idx: f.timeIdx, parts: f.timeParts }));
      const ghcr = await inProcess(['--repo', 'feed', '--tag', 'feed-d-20261026', '--require', 'time']);
      assert.equal(ghcr.code, 0, ghcr.lines.join('\n') + ghcr.err);
      writeFiles(dir, f);
      const local = await inProcess(['--require', 'time', dir]);
      assert.deepEqual(ghcr.lines, local.lines);
      assert.ok(ghcr.lines.some((l) => l.startsWith('PASS time ')));
      // A time copy of other rows in the manifest: FAIL time.
      const other = await feedFiles(FEED_ROWS.map((r, i) => (i === 7 ? { ...r, firstSeen: r.firstSeen + 1 } : r)));
      reg.seed('feed', 'feed-d-bad', artifactType('pack'), {}, layers({ idx: other.timeIdx, parts: other.timeParts }));
      const bad = await inProcess(['--repo', 'feed', '--tag', 'feed-d-bad']);
      assert.equal(bad.code, 1, bad.lines.join('\n'));
      assert.ok(bad.lines.some((l) => l.startsWith('FAIL time ')));
      // A manifest with no time copy: SKIP, unverified under --require time.
      reg.seed('feed', 'feed-d-plain', artifactType('pack'), {}, layers(null));
      const plain = await inProcess(['--repo', 'feed', '--tag', 'feed-d-plain', '--require', 'time']);
      assert.equal(plain.code, 1);
      assert.ok(plain.lines.includes('SKIP time no time copy given'));
      // A time part out of its place, and time parts with no time.idx: exit 2.
      reg.seed('feed', 'feed-d-order', artifactType('pack'), {}, [...layers(null), { title: 'time.part.001', bytes: f.timeParts[0] }, { title: 'time.idx', bytes: f.timeIdx }]);
      const order = await inProcess(['--repo', 'feed', '--tag', 'feed-d-order']);
      assert.equal(order.code, 2);
      assert.match(order.err, /the layer time\.part\.001 stands where time\.part\.000 belongs/);
      reg.seed('feed', 'feed-d-noidx', artifactType('pack'), {}, [...layers(null), { title: 'time.part.000', bytes: f.timeParts[0] }]);
      const noIdx = await inProcess(['--repo', 'feed', '--tag', 'feed-d-noidx']);
      assert.equal(noIdx.code, 2);
      assert.match(noIdx.err, /holds time parts and no time\.idx layer/);
      // Two time.idx layers: exit 2, before a block is read.
      reg.seed('feed', 'feed-d-twoidx', artifactType('pack'), {}, [...layers({ idx: f.timeIdx, parts: f.timeParts }), { title: 'time.idx', bytes: f.timeIdx }]);
      const twoIdx = await inProcess(['--repo', 'feed', '--tag', 'feed-d-twoidx']);
      assert.equal(twoIdx.code, 2);
      assert.match(twoIdx.err, /feed:feed-d-twoidx holds two time\.idx layers/);
      assert.deepEqual(twoIdx.lines, []);
    }),
  ));

test('verify-pack: an error the script does not know exits 70 with its stack, never 1 or 2', async () => {
  const reader = {
    getManifest: async () => {
      throw new TypeError('planted: a defect of the reader');
    },
  };
  const err = [];
  const code = await verifyMain(['--repo', 'feed', '--tag', 'feed-d-20261026'], { reader, write: () => undefined, err: (l) => err.push(l), sleep: async () => undefined });
  assert.equal(code, 70);
  assert.match(err.join('\n'), /^verify-pack: internal error: TypeError: planted: a defect of the reader\n\s+at /m);
  // A GHCR error is an input the run could not take: 2.
  const ghcrErr = { getManifest: async () => Promise.reject(new GhcrError('missing', 'GHCR holds no manifest planted')) };
  assert.equal(await verifyMain(['--repo', 'feed', '--tag', 'feed-d-20261026'], { reader: ghcrErr, write: () => undefined, err: () => undefined, sleep: async () => undefined }), 2);
});

test('verify-pack: readRanged asks at most `chunk` bytes at a time, stops at an answer of 0, and never sizes past the object', async () => {
  const bytes = Buffer.from('0123456789');
  const asked = [];
  const fill = async (target, position) => {
    asked.push([position, target.length]);
    const n = Math.min(target.length, 2, bytes.length - position);
    target.set(bytes.subarray(position, position + n));
    return n;
  };
  assert.equal(Buffer.from(await readRanged(10, 1, 100, 3, fill)).toString(), '123456789');
  assert.ok(
    asked.every(([, n]) => n <= 3),
    JSON.stringify(asked),
  );
  assert.deepEqual(asked[0], [1, 3]);
  // An object that ends early answers what it holds.
  const short = await readRanged(10, 0, 10, 4, async (target, position) => (position >= 6 ? 0 : (target.fill(1), Math.min(target.length, 6 - position))));
  assert.equal(short.length, 6);
  assert.equal((await readRanged(10, 12, 5, 4, fill)).length, 0);
});
