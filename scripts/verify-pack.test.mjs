// scripts/verify-pack.mjs as a process, on the synthetic fixtures of
// packages/pack/test/verify (make-fixtures.ts) and on packs written to a
// temporary directory. Each exit code is read from the process itself. No test
// reaches the network; every name is synthetic.
//
//   node scripts/test.mjs scripts --name "verify-pack"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { writePackFiles } from '../packages/pack/node/index.ts';
import { NAMES_CODEC } from '../packages/pack/src/index.ts';
import { CHECKS, quoteKey } from '../packages/pack/src/verify.ts';
import { CLEAN_COUNT, CLEAN_SEED, syntheticNames, syntheticRegistry } from '../packages/pack/test/verify/synthetic.ts';
import { ROOT } from './files.mjs';
import { lines, openPack, packFiles, parseFlags, readAt, UsageError } from './verify-pack.mjs';

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
const DEFAULT_SKIPS = ['dataset', 'length', 'count', 'sha256', 'psl', 'sources', 'precision', 'volume'];

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
  assert.equal(ok.lines.at(-1), 'VERDICT ok (1 skipped)');
  // Every check but volume, with the default flags: the seven that skipped are named.
  const every = await run(['--require', CHECKS.filter((c) => c !== 'volume').join(','), ...CLEAN]);
  assert.equal(every.code, 1, every.stdout + every.stderr);
  assert.equal(every.lines.at(-1), 'VERDICT unverified (8 skipped; required and skipped: dataset, length, count, sha256, psl, sources, precision)');
});

test('verify-pack: the clean fixture with its annotations and the synthetic registry passes every check but the volume', async () => {
  const r = await run(['--annotations', `${FIX}/clean.annotations.json`, '--sources', REGISTRY, ...CLEAN]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const s = statusOf(r);
  for (const check of CHECKS) assert.equal(s[check], check === 'volume' ? 'SKIP' : 'PASS', check);
  assert.equal(r.lines.at(-1), 'VERDICT ok (1 skipped)');
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
  // idx passed and dataset had no annotation; the 15 checks after length did not run.
  assert.equal(r.lines.at(-1), 'VERDICT fail (16 skipped)');
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
    // dataset, length, count, sha256 and psl have no annotation to compare.
    assert.equal(q.lines.at(-1), 'VERDICT quarantine (5 skipped)');
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
