// scripts/bench/feed-window.mjs — DOM-022's bench, run as a process on
// synthetic rows, and its parts on planted inputs: the verdict one step past the
// limit, the check of a page against a sort of every row, the keys of a list of
// names, and the flags. No test reaches the network; every row is synthetic, and
// the list of names is written here.
//
//   node scripts/test.mjs scripts/bench --name "feed-window"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadPsl } from '@domains/names';
import { checkPage, judge, keysOfNames, MAX_SEED, main, PSL_FILE, parseFlags, rowsOfNames, syntheticRows, UsageError, WrongPage } from './feed-window.mjs';

const SCRIPT = fileURLToPath(new URL('./feed-window.mjs', import.meta.url));

function run(args) {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', fail);
    child.on('close', (code) => done({ code, stdout, stderr }));
  });
}

test('feed-window bench: 3,000 synthetic rows give a page of the first rows of the order from the time copy, a PASS line and exit 0', async () => {
  const r = await run(['--rows', '3000', '--limit', '50', '--seed', '7']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.schema, 'domains.bench.feed-window.v3');
  assert.equal(out.entry, 'DOM-022');
  assert.equal(out.rows, 3000);
  assert.deepEqual([out.key_copy.blocks, out.time_copy.blocks], [1, 1]);
  assert.ok(out.time_copy.bytes > 0 && out.key_copy.bytes > 0);
  assert.equal(out.page.rows, 50);
  assert.deepEqual([out.page.copy_read, out.page.blocks_read, out.page.time_blocks_read, out.page.key_blocks_read], ['time', 1, 1, 0]);
  assert.deepEqual(
    out.criteria.map((c) => [c.name, c.pass]),
    [['one-page-at-most-40-blocks', true]],
  );
  assert.match(r.stderr, /PASS one-page-at-most-40-blocks/);
  assert.match(out.rows_of, /^synthetic/);
});

test('feed-window bench: the newest and the oldest page of many blocks read one or two blocks of the time copy; the key copy forced reads every block and prints FAIL, exit 1', async () => {
  // 64 rows a block: 10,000 rows are 157 blocks of each copy.
  const base = ['--rows', '10000', '--records-per-block', '64', '--limit', '50', '--seed', '7'];
  for (const order of ['first_seen.desc', 'first_seen.asc']) {
    const r = await run([...base, '--order', order]);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual([out.key_copy.blocks, out.time_copy.blocks], [157, 157]);
    assert.equal(out.page.copy_read, 'time');
    assert.ok(out.page.blocks_read >= 1 && out.page.blocks_read <= 2, `${order}: ${out.page.blocks_read}`);
  }
  // The key copy and a sort: every block of the pack.
  const key = await run([...base, '--copy', 'key']);
  assert.equal(key.code, 1, key.stderr);
  const out = JSON.parse(key.stdout);
  assert.deepEqual([out.page.copy_read, out.page.blocks_read, out.page.key_blocks_read], ['key', 157, 157]);
  assert.equal(out.pass, false);
  assert.match(key.stderr, /FAIL one-page-at-most-40-blocks/);
});

test('feed-window bench: the verdict passes at 40 blocks and fails at 41', () => {
  assert.equal(judge({ blocks_read: 40 }).pass, true);
  assert.equal(judge({ blocks_read: 41 }).pass, false);
});

test('feed-window bench: a page that differs from the sort is refused, by row, by length, and by any field of a row', () => {
  const rows = syntheticRows(5, 3);
  checkPage(rows, rows);
  // The same rows as other objects are the same page.
  checkPage(
    rows.map((r) => ({ ...r, sources: [...r.sources] })),
    rows,
  );
  assert.throws(() => checkPage(rows.slice(0, 4), rows), WrongPage);
  const swapped = [rows[1], rows[0], ...rows.slice(2)];
  assert.throws(() => checkPage(swapped, rows), WrongPage);
  // One field of row 2 changed, each field alone, the key and first_seen kept.
  for (const [field, value] of [
    ['firstSeen', rows[2].firstSeen + 1],
    ['flags', 1],
    ['sources', [1, 8]],
    ['basis', 2],
    ['confidence', 3],
    ['feedFlags', 2 + 16],
  ]) {
    const changed = rows.map((r, i) => (i === 2 ? { ...r, [field]: value } : r));
    assert.throws(
      () => checkPage(changed, rows),
      (e) => e instanceof WrongPage && /^row 2 of the page is /.test(e.message),
      field,
    );
  }
});

test('feed-window bench: the flags are checked, and a usage error exits 2', async () => {
  assert.deepEqual(parseFlags(['--rows', '10']), {
    rows: 10,
    order: 'first_seen.desc',
    limit: 1000,
    seed: 1,
    recordsPerBlock: 4096,
    suffix: null,
    suspectShare: 0,
    suspect: 'exclude',
    copy: 'auto',
    names: null,
    dayShare: 0.4,
    from: 298 * 86_400,
    sources: null,
    out: null,
  });
  assert.deepEqual(
    [parseFlags(['--rows', '10', '--suspect-share', '0.01', '--suspect', 'only', '--copy', 'time'])].map((f) => [f.suspectShare, f.suspect, f.copy]),
    [[0.01, 'only', 'time']],
  );
  assert.deepEqual(
    [parseFlags(['--rows', '10', '--day-share', '1', '--from', '2026-10-26T12:00:00Z', '--source', 'isc-new,oi-nrd'])].map((f) => [f.dayShare, f.from, f.sources]),
    [[1, 298 * 86_400 + 12 * 3600, [8, 1]]],
  );
  for (const argv of [
    [],
    ['--rows', '0'],
    ['--rows', 'x'],
    ['--rows', '5', '--order', 'key'],
    ['--rows', '5', '--limit', '10001'],
    ['--rows', '5', '--nope', '1'],
    ['--rows', '5', '--suffix', 'COM'],
    ['--rows', '5', '--suspect-share', '1.5'],
    ['--rows', '5', '--suspect-share', '-0.1'],
    ['--rows', '5', '--suspect', 'maybe'],
    ['--rows', '5', '--copy', 'both'],
    ['--names', join(tmpdir(), 'no-such-names-file.txt')],
    ['--rows', '5', '--day-share', '1.5'],
    ['--rows', '5', '--from', '2026-10-27T00:00:00Z'],
    ['--rows', '5', '--from', '2026-10-26T24:00:00Z'],
    ['--rows', '5', '--from', '2026-10-26'],
    ['--rows', '5', '--source', 'ct-le'],
    ['--rows', '5', '--source', 'oi-nrd,oi-nrd'],
  ])
    assert.throws(() => parseFlags(argv), UsageError, argv.join(' '));
  // The largest seed the flag takes is the one its message names.
  assert.equal(parseFlags(['--rows', '5', '--seed', String(MAX_SEED)]).seed, MAX_SEED);
  assert.throws(
    () => parseFlags(['--rows', '5', '--seed', String(MAX_SEED + 1)]),
    (e) => e instanceof UsageError && e.message === `--seed must be a whole number of 0 to ${MAX_SEED}`,
  );
  assert.equal(MAX_SEED, 999_999_999);
  const r = await run(['--rows', '5', '--order', 'sideways']);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--order takes/);
});

test('feed-window bench: a page that differs from the sort exits 3, and any other error 70 with its stack, through main', async () => {
  // The bench's own run, planted: the check of the page throws WrongPage, and
  // anything else is an error of the bench.
  const quiet = console.error;
  const said = [];
  console.error = (line) => said.push(String(line));
  try {
    assert.equal(
      await main(['--rows', '5'], async () => {
        checkPage([], syntheticRows(1, 1));
      }),
      3,
    );
    assert.equal(
      await main(['--rows', '5'], async () => {
        throw new TypeError('planted');
      }),
      70,
    );
    assert.match(said.at(-1), /^feed-window bench: internal error: TypeError: planted\n\s+at /);
    assert.equal(await main(['--rows', '0'], async () => assert.fail('no run on a usage error')), 2);
  } finally {
    console.error = quiet;
  }
});

test('feed-window bench: a share of suspect rows leaves the keys and times of the seed, and suspect=only reads a page of them equal to the sort', async () => {
  const plain = syntheticRows(2000, 9);
  const flagged = syntheticRows(2000, 9, 0.05);
  assert.deepEqual(
    flagged.map((r) => [r.key, r.firstSeen]),
    plain.map((r) => [r.key, r.firstSeen]),
  );
  const share = flagged.filter((r) => r.feedFlags !== 0).length / flagged.length;
  assert.ok(share > 0.03 && share < 0.07, String(share));
  // A suspect row carries its reason, suspect-cert (bit 4).
  assert.ok(flagged.every((r) => r.feedFlags === 0 || r.feedFlags === 2 + 16));
  assert.ok(plain.every((r) => r.feedFlags === 0));
  const r = await run(['--rows', '3000', '--limit', '50', '--seed', '7', '--suspect-share', '0.05', '--suspect', 'only']);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.page.rows, 50);
  assert.equal(out.window.suspect, 'only');
  assert.ok(out.suspect_rows > 0 && out.window.rows === out.suspect_rows, `${out.window.rows} rows of the window, ${out.suspect_rows} suspect`);
  assert.match(out.rows_of, /a share 0\.05 of the rows suspect/);
});

test('feed-window bench: --from cuts the window inside the day, --source filters by source, and --day-share sets the share of day rows; each page equals the sort', async () => {
  const base = ['--rows', '3000', '--records-per-block', '64', '--limit', '50', '--seed', '7', '--order', 'first_seen.asc'];
  const cut = await run([...base, '--from', '2026-10-26T12:00:00Z']);
  assert.equal(cut.code, 0, cut.stderr);
  const c = JSON.parse(cut.stdout);
  assert.deepEqual([c.window.start, c.window.sources, c.day_share], ['2026-10-26T12:00:00Z', null, 0.4]);
  // The rows of the window: the day rows, which stand for the whole day, and
  // the second rows from 12:00.
  assert.ok(c.window.rows > c.day_precision_rows && c.window.rows < c.rows, String(c.window.rows));
  // A source filter that drops the day rows reads the run of the day's first
  // second whole before it reaches 12:00.
  const oi = await run([...base, '--from', '2026-10-26T12:00:00Z', '--source', 'oi-nrd']);
  assert.ok(oi.code === 0 || oi.code === 1, oi.stderr);
  const o = JSON.parse(oi.stdout);
  assert.deepEqual([o.window.sources, o.page.rows], [['oi-nrd'], 50]);
  assert.ok(o.page.blocks_read > c.page.blocks_read, `${o.page.blocks_read} against ${c.page.blocks_read}`);
  assert.match(o.read_of, /source=oi-nrd, over the window 2026-10-26T12:00:00Z to 2026-10-27T00:00:00Z/);
  // Every row at the start of the day.
  const day = await run([...base, '--day-share', '1']);
  assert.equal(day.code, 0, day.stderr);
  const d = JSON.parse(day.stdout);
  assert.deepEqual([d.day_precision_rows, d.rows, d.day_share], [3000, 3000, 1]);
  assert.match(d.rows_of, /a share 1 of day-precision rows/);
});

test('feed-window bench: the synthetic rows are distinct, ascending, of one day, and the same for one seed', () => {
  const rows = syntheticRows(2000, 9);
  for (let i = 1; i < rows.length; i += 1) assert.ok(rows[i - 1].key < rows[i].key);
  const day = 298 * 86_400;
  assert.ok(rows.every((r) => r.firstSeen >= day && r.firstSeen < day + 86_400));
  assert.ok(rows.every((r) => (r.sources[0] === 8 ? r.firstSeen === day : true)));
  const share = rows.filter((r) => r.sources[0] === 8).length / rows.length;
  assert.ok(share > 0.35 && share < 0.45, String(share));
  assert.deepEqual(syntheticRows(2000, 9), rows);
});

test('feed-window bench: a list of names gives the keys of their registrable domains, refused and repeated names counted, and the bench reads them', async () => {
  const psl = await loadPsl(readFileSync(PSL_FILE));
  // Synthetic names: a repeat, an upper-case one, a name below a registrable
  // domain, a suffix alone, a name of no dot, a comment and a blank line.
  const text = ['example-one.com', 'example-one.com', 'EXAMPLE-TWO.co.uk', 'www.example-three.com.np', 'co.uk', 'nodot', '# a comment', '', 'xn--bcher-kva.de'].join('\n');
  const got = keysOfNames(text, psl);
  assert.deepEqual(got.keys, ['com.example-one', 'de.xn--bcher-kva', 'np.com.example-three', 'uk.co.example-two']);
  assert.equal(got.lines, 7);
  assert.equal(got.distinct, 4);
  assert.deepEqual(got.refused, { 'public-suffix': 1, 'no-dot': 1 });
  assert.deepEqual(keysOfNames(text, psl, 2).keys, ['com.example-one', 'de.xn--bcher-kva']);
  const rows = rowsOfNames(got.keys, 3);
  assert.deepEqual(
    rows.map((r) => r.key),
    got.keys,
  );
  const dir = mkdtempSync(join(tmpdir(), 'feed-window-'));
  try {
    const file = join(dir, 'names.txt');
    writeFileSync(file, text);
    const r = await run(['--names', file, '--limit', '3']);
    assert.equal(r.code, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.rows, 4);
    assert.match(out.rows_of, /^the keys of the names of .*names\.txt \(7 lines, 4 distinct registrable domains, refused .*\); first_seen synthetic/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('feed-window bench: the feed, the pack and the names are imported by their package names, never by a path into packages/', () => {
  const specifiers = [...readFileSync(SCRIPT, 'utf8').matchAll(/^import .+ from '([^']+)';$/gm)].map((m) => m[1]);
  for (const name of ['@domains/feed', '@domains/pack', '@domains/names']) assert.ok(specifiers.includes(name), `${name}: ${specifiers.join(', ')}`);
  assert.deepEqual(
    specifiers.filter((s) => s.includes('packages/')),
    [],
  );
});
