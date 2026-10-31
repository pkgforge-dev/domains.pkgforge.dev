// scripts/measure/clock-verdict.mjs: the verdict of the four mixes of PASS and
// FAIL, the edges of the rule, the results it refuses, --check against each way
// config/clock.json can differ, the exit code of the process, and the committed
// results against the committed config/clock.json, docs/clock.md and the
// numbers of the rule in docs/architecture.md and TODO/RULES.md.
//
// Every test runs offline, on files it writes under the system's temporary
// directory, except the ones that read the committed files.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { DEFAULT_INTERVAL_MIN, readClock } from '../ingest/chain.mjs';
import { RULE } from './clock-gaps.mjs';
import { CLOCKS, checkClockFile, DEFAULT_CLOCK_FILE, decide, HOURS, INTERVAL_MIN, judge, judgeFiles, lines, main, passes, TABLE_HEAD, tableRows } from './clock-verdict.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'clock-verdict.mjs');
const ROOT = join(HERE, '..', '..');

const dirs = [];
after(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), 'domains-clock-verdict-'));
  dirs.push(d);
  return d;
};

const CLOCK_OF = { A: 'actions-schedule', B: 'actions-chain', C: 'worker' };
const slot = (letter) => CLOCKS.find((c) => c.letter === letter);

// A complete 48-hour result of clock `letter` with the given gaps, its verdict
// the one its numbers give under RULE unless `over` says otherwise. A key of
// `over` set to undefined is left out of the file.
function result(letter, p90, max, over = {}) {
  return {
    version: 1,
    clock: CLOCK_OF[letter],
    from: '2026-11-01T00:00:00Z',
    to: '2026-11-03T00:00:00Z',
    hours: 48,
    runs: 500,
    expected: 576,
    interval_min: 5,
    gaps_min: { median: p90 === null ? null : Math.min(p90, 5), p90, max },
    verdict: passes(p90, max) ? 'PASS' : 'FAIL',
    rule: { ...RULE },
    complete: true,
    ...over,
  };
}
const PASSING = (letter) => result(letter, 5.02, 5.9);
const FAILING = (letter) => result(letter, 411.82, 411.82);
// A result as text with the number 1e999 in place of the string "INF", which
// JSON.parse reads as Infinity and JSON.stringify cannot write.
const withInfinity = (doc) => `${JSON.stringify(doc).replace('"INF"', '1e999')}\n`;

// The three results written to files, and the flags that name them.
function filesOf(a, b, c) {
  const d = tmp();
  const flags = [];
  for (const [flag, doc] of [
    ['schedule', a],
    ['chain', b],
    ['worker', c],
  ]) {
    const path = join(d, `${flag}.json`);
    writeFileSync(path, typeof doc === 'string' ? doc : `${JSON.stringify(doc)}\n`);
    flags.push(`--${flag}`, path);
  }
  return { dir: d, flags };
}

function run(argv, opts = {}) {
  let out = '';
  let err = '';
  const code = main(argv, { stdout: { write: (s) => (out += s) }, stderr: { write: (s) => (err += s) }, ...opts });
  return { code, out, err };
}

const spawn = (argv) => spawnSync(process.execPath, [SCRIPT, ...argv], { cwd: ROOT, encoding: 'utf8' });
const clockLine = (out) => out.split('\n').find((l) => l.startsWith('clock: '));
const committed = () => judgeFiles(Object.fromEntries(CLOCKS.map((c) => [c.flag, c.file])));

test('clock verdict: the first clock that passes wins, A then B then C, and none when all fail', () => {
  const cases = [
    [[PASSING('A'), PASSING('B'), PASSING('C')], 'actions-schedule'],
    [[FAILING('A'), PASSING('B'), PASSING('C')], 'actions-chain'],
    [[FAILING('A'), FAILING('B'), PASSING('C')], 'worker'],
    [[FAILING('A'), FAILING('B'), FAILING('C')], 'none'],
  ];
  for (const [docs, want] of cases) {
    const judged = docs.map((doc, i) => judge(doc, CLOCKS[i]));
    assert.equal(decide(judged).clock, want);
    const r = run(filesOf(...docs).flags);
    assert.equal(r.code, 0, r.err);
    assert.equal(clockLine(r.out), `clock: ${want}`);
    assert.equal(r.out.split('\n').filter((l) => /^[ABC] /.test(l)).length, 3);
  }
  // A later clock that passes never wins over an earlier one.
  assert.equal(decide([PASSING('A'), FAILING('B'), FAILING('C')].map((doc, i) => judge(doc, CLOCKS[i]))).clock, 'actions-schedule');
  // `through` is the latest end of the windows judged, whichever clock wins.
  const later = result('C', 1, 2, { from: '2026-11-02T00:00:00Z', to: '2026-11-04T00:00:00Z' });
  assert.equal(decide([PASSING('A'), FAILING('B'), later].map((doc, i) => judge(doc, CLOCKS[i]))).through, '2026-11-04T00:00:00Z');
});

test("clock verdict: the rule's edges: a p90 of 15 and a max of 60 pass, a hair above fails, no gap fails, a gap of 0 passes", () => {
  assert.equal(judge(result('A', 15, 60), slot('A')).verdict, 'PASS');
  assert.equal(judge(result('A', 15.01, 60), slot('A')).verdict, 'FAIL');
  assert.equal(judge(result('A', 15, 60.01), slot('A')).verdict, 'FAIL');
  assert.equal(judge(result('A', null, 60), slot('A')).verdict, 'FAIL');
  assert.equal(judge(result('A', 5, null), slot('A')).verdict, 'FAIL');
  assert.equal(judge(result('A', 0, 0), slot('A')).verdict, 'PASS');
  // A result with no tick is judged, and fails: worker-clock-gaps.mjs gives a
  // cron with no tick in an ended window one gap, and clock-gaps.mjs one tick one gap.
  assert.equal(judge(result('A', null, null, { runs: 0 }), slot('A')).verdict, 'FAIL');
  assert.equal(judge(result('A', 2880, 2880, { runs: 0 }), slot('A')).verdict, 'FAIL');
});

test('clock verdict: a result that cannot be judged exits 2 and names its clock', () => {
  const B = (over) => result('B', 5, 6, over);
  const window = /clock B: the result's window, .* is not its 48 hours/;
  const bad = [
    [B({ clock: 'actions-schedule' }), /clock B: the result is of the clock "actions-schedule", not actions-chain/],
    [B({ complete: false }), /clock B: the result's window has not ended/],
    [B({ complete: null }), /clock B: the result's window has not ended/],
    [B({ complete: undefined }), /clock B: the result's window has not ended/],
    [B({ hours: 47.9 }), /clock B: the result covers 47.9 hours, not at least 48/],
    [B({ hours: '100' }), /clock B: the result covers "100" hours, not at least 48/],
    [B({ hours: undefined }), /clock B: the result covers null hours, not at least 48/],
    [withInfinity(B({ hours: 'INF' })), /clock B: the result covers Infinity hours, not at least 48/],
    [B({ version: 2 }), /clock B: the result is version 2, not 1/],
    [B({ verdict: 'FAIL' }), /clock B: the result says "FAIL", and its numbers under its own rule say PASS/],
    [result('B', 411, 411, { verdict: 'PASS' }), /clock B: the result says "PASS", and its numbers under its own rule say FAIL/],
    [B({ rule: undefined, verdict: 'banana' }), /clock B: the result names no rule it was judged by/],
    [B({ rule: null }), /clock B: the result names no rule it was judged by/],
    [B({ rule: [] }), /clock B: the result names no rule it was judged by/],
    [B({ gaps_min: { median: 5, p90: '5', max: 6 } }), /clock B: the result's gaps_min.p90 is not a number of minutes/],
    [B({ gaps_min: { median: 5, p90: -1, max: 6 } }), /clock B: the result's gaps_min.p90 is not a number of minutes/],
    [withInfinity(B({ gaps_min: { median: 5, p90: 'INF', max: 6 } })), /clock B: the result's gaps_min.p90 is not a number of minutes/],
    [B({ gaps_min: { median: 5, p90: 5, max: '6' } }), /clock B: the result's gaps_min.max is not a number of minutes/],
    [B({ gaps_min: { median: 5, p90: 5, max: -1 } }), /clock B: the result's gaps_min.max is not a number of minutes/],
    [B({ gaps_min: { median: 'abc', p90: 5, max: 6 } }), /clock B: the result's gaps_min.median is not a number of minutes/],
    [B({ gaps_min: { median: -1, p90: 5, max: 6 } }), /clock B: the result's gaps_min.median is not a number of minutes/],
    [B({ gaps_min: undefined }), /clock B: the result's gaps_min.median is not a number of minutes/],
    [B({ from: 'yesterday' }), /clock B: the result's from is not a UTC time/],
    [B({ from: 5 }), /clock B: the result's from is not a UTC time/],
    [B({ from: '2026-11-01T02:00:00+02:00' }), /clock B: the result's from is not a UTC time/],
    [B({ from: '2026-11-01' }), /clock B: the result's from is not a UTC time/],
    [B({ from: '2026-11-01T00:00Z' }), /clock B: the result's from is not a UTC time/],
    [B({ from: '+012026-11-01T00:00:00Z' }), /clock B: the result's from is not a UTC time/],
    [B({ from: '2026-02-30T00:00:00Z', to: '2026-03-04T00:00:00Z' }), /clock B: the result's from is not a UTC time/],
    [B({ to: '2026-11-03' }), /clock B: the result's to is not a UTC time/],
    [B({ to: '2026-11-03T00:00:00Zjunk' }), /clock B: the result's to is not a UTC time/],
    [B({ to: '2026-11-03T00:00:00' }), /clock B: the result's to is not a UTC time/],
    [B({ to: '2026-11-02T24:00:00Z' }), /clock B: the result's to is not a UTC time/],
    [B({ to: '2026-11-01T00:01:00Z' }), window],
    [B({ from: '2026-11-03T00:00:00Z', to: '2026-11-01T00:00:00Z' }), window],
    [B({ to: '2026-11-04T00:00:00Z' }), window],
    [B({ runs: 1.5 }), /clock B: the result's runs is not a whole number of 0 or more/],
    [B({ runs: -1 }), /clock B: the result's runs is not a whole number of 0 or more/],
    [B({ expected: 1.5 }), /clock B: the result's expected is not a whole number of 1 or more/],
    [B({ expected: 0 }), /clock B: the result's expected is not a whole number of 1 or more/],
    [B({ interval_min: 0 }), /clock B: the result's interval_min is not a whole number of 1 or more/],
    [B({ interval_min: undefined }), /clock B: the result's interval_min is not a whole number of 1 or more/],
    [[B()], /clock B: the result is not a JSON object/],
    ['null\n', /clock B: the result is not a JSON object/],
    ['5\n', /clock B: the result is not a JSON object/],
    ['{"version":', /clock B: --chain is not JSON/],
  ];
  for (const [doc, want] of bad) {
    const r = run(filesOf(FAILING('A'), doc, PASSING('C')).flags);
    assert.equal(r.code, 2, `${want}: ${r.out}`);
    assert.match(r.err, want);
    assert.equal(r.out, '', 'nothing is judged when one result cannot be');
  }
  const { dir, flags } = filesOf(FAILING('A'), PASSING('B'), PASSING('C'));
  flags[3] = join(dir, 'absent.json');
  const missing = run(flags);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /clock B: --chain cannot be read: ENOENT/);
});

test('clock verdict: a result judged by another rule is judged again by this one', () => {
  const lax = result('A', 120, 300, { verdict: 'PASS', rule: { p90_max_min: 180, max_max_min: 600 } });
  const r = run(filesOf(lax, PASSING('B'), PASSING('C')).flags);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /^A actions-schedule FAIL p90_gap_min=120 max_gap_min=300 .*\(judged again: its file was judged by \{"p90_max_min":180,"max_max_min":600\}\)$/m);
  assert.doesNotMatch(r.out, /^[BC] .*judged again/m, 'a result judged by the same rule carries no note');
  assert.equal(clockLine(r.out), 'clock: actions-chain');
});

test('clock verdict: the lines and the rows say none for a gap that does not exist', () => {
  const judged = [result('A', null, null, { runs: 0 }), PASSING('B'), PASSING('C')].map((doc, i) => judge(doc, CLOCKS[i]));
  const out = lines(judged, decide(judged));
  assert.equal(out[0], 'A actions-schedule FAIL p90_gap_min=none max_gap_min=none runs=0/576 window=2026-11-01T00:00:00Z..2026-11-03T00:00:00Z');
  assert.equal(tableRows(judged)[0], '| A. `schedule` | `docs/research/measure/DOM-001/schedule.json` | 2026-11-01T00:00:00Z to 2026-11-03T00:00:00Z | 5 min | 0 / 576 | none | none | none | FAIL |');
});

test('clock verdict: --check agrees with a matching config/clock.json and names each difference', () => {
  const { dir, flags } = filesOf(FAILING('A'), PASSING('B'), PASSING('C'));
  const good = { clock: 'actions-chain', decided: '2026-11-03T01:00:00Z', evidence: ['DOM-001', 'DOM-002'], p90_gap_min: 5.02, max_gap_min: 5.9, rule: { ...RULE }, interval_min: 10 };
  const now = Date.parse('2026-11-03T02:00:00Z');
  const path = join(dir, 'clock.json');
  const check = (doc) => {
    if (doc === undefined) rmSync(path, { force: true });
    else writeFileSync(path, typeof doc === 'string' ? doc : `${JSON.stringify(doc)}\n`);
    return run([...flags, '--check', '--clock', path], { now });
  };
  const ok = check(good);
  assert.equal(ok.code, 0, ok.out);
  assert.ok(ok.out.endsWith(`\nclock: actions-chain\ncheck: ${path} agrees\n`), ok.out);
  const { interval_min: _, ...noInterval } = good;
  // The edges that agree: the default interval, a decision at now, at the end
  // of the last window, and with milliseconds.
  for (const doc of [noInterval, { ...good, decided: '2026-11-03T02:00:00Z' }, { ...good, decided: '2026-11-03T00:00:00Z' }, { ...good, decided: '2026-11-03T01:00:00.500Z' }]) {
    const r = check(doc);
    assert.equal(r.code, 0, `${JSON.stringify(doc)}: ${r.out}`);
  }

  const without = (k) => Object.fromEntries(Object.entries(good).filter(([key]) => key !== k));
  const notUtc = (v) => [{ ...good, decided: v }, `its decided is ${JSON.stringify(v)}, not a UTC time`];
  const differs = [
    [{ ...good, clock: 'worker' }, /its clock is "worker", and the verdict is actions-chain/],
    [{ ...good, p90_gap_min: 5 }, /its p90_gap_min is 5, and clock B's is 5.02/],
    [{ ...good, max_gap_min: 6 }, /its max_gap_min is 6, and clock B's is 5.9/],
    [{ ...good, evidence: ['DOM-001'] }, /its evidence is \["DOM-001"\], not \["DOM-001","DOM-002"\]/],
    [{ ...good, rule: { p90_max_min: 20, max_max_min: 60 } }, /its rule is \{"p90_max_min":20,"max_max_min":60\}/],
    ...['decided', 'evidence', 'p90_gap_min', 'max_gap_min', 'rule'].map((k) => [without(k), new RegExp(`it has no ${k}\\n`)]),
    [{ ...good, note: 'x' }, /it has the key note, which no reader reads/],
    [{ ...good, interval_min: 5 }, /its interval is 5 min, and DOM-003 decided 10 \(INTERVAL_MIN\)/],
    [{ ...good, interval_min: 12 }, /its interval is 12 min, and DOM-003 decided 10 \(INTERVAL_MIN\)/],
    [{ ...good, decided: '2026-11-03T02:00:01Z' }, /its decided, 2026-11-03T02:00:01Z, is later than now/],
    [{ ...good, decided: '2026-11-02T23:59:59Z' }, /its decided, 2026-11-02T23:59:59Z, is earlier than 2026-11-03T00:00:00Z, the end of the last window the verdict rests on/],
    [{ ...good, decided: '0001-01-01T00:00:00Z' }, /its decided, 0001-01-01T00:00:00Z, is earlier than 2026-11-03T00:00:00Z/],
    notUtc('2026-13-45T00:00:00Z'),
    notUtc('2026-02-30T00:00:00Z'),
    notUtc('2026-04-31T00:00:00Z'),
    notUtc('2026-11-02T24:00:00Z'),
    notUtc('2026-11-03'),
    notUtc('2026-11-03T01:00Z'),
    notUtc('2026-11-03T01:00:00'),
    notUtc('2026-11-03T01:00:00+00:00'),
    notUtc('2026-11-03T01:00:00Zjunk'),
    notUtc('+012026-11-03T01:00:00Z'),
    [{ ...good, decided: 5 }, /its decided is 5, not a UTC time/],
    [{ ...good, interval_min: 13 }, /it does not read as scripts\/ingest\/chain\.mjs reads it: .*interval_min is 13/],
    [{ ...good, clock: 'sundial' }, /it does not read as scripts\/ingest\/chain\.mjs reads it: .*clock is "sundial"/],
    ['{"clock":', /it does not read as scripts\/ingest\/chain\.mjs reads it: .*is not JSON/],
    [undefined, /it does not exist/],
  ];
  for (const [doc, want] of differs) {
    const r = check(doc);
    assert.equal(r.code, 1, `${want}: ${r.out}`);
    assert.ok(r.out.includes(`\ncheck: ${path} differs\n`), r.out);
    if (typeof want === 'string') assert.ok(r.out.includes(want), `${want}: ${r.out}`);
    else assert.match(r.out, want);
  }

  // A verdict of none never agrees, whatever the file says.
  const none = filesOf(FAILING('A'), FAILING('B'), FAILING('C'));
  const nonePath = join(none.dir, 'clock.json');
  writeFileSync(nonePath, `${JSON.stringify({ ...good, clock: 'none' })}\n`);
  const r = run([...none.flags, '--check', '--clock', nonePath], { now });
  assert.equal(r.code, 1);
  assert.match(r.out, /no clock passes the rule, so no config\/clock\.json is written for it/);
});

test('clock verdict: usage errors exit 2 and judge nothing', () => {
  for (const [argv, want] of [
    [['--clocks', 'x'], /unknown flag --clocks/],
    [['--check', '--check'], /--check is given more than once/],
    [['--check=yes'], /--check takes no value/],
    ...['clock', 'schedule', 'chain', 'worker'].flatMap((k) => [
      [['--check', `--${k}`], new RegExp(`--${k} needs a value`)],
      [['--check', `--${k}=`], new RegExp(`--${k} needs a value`)],
    ]),
    [['--clock', 'config/clock.json'], /--clock needs --check/],
    [['config/clock.json'], /unexpected argument "config\/clock.json"/],
  ]) {
    const r = run(argv);
    assert.equal(r.code, 2, String(argv));
    assert.match(r.err, want);
    assert.match(r.err, /usage: node scripts\/measure\/clock-verdict\.mjs/);
    assert.equal(r.out, '');
  }
});

test('clock verdict: the process exits with the code main returns', () => {
  const absent = join(tmp(), 'absent.json');
  const differs = spawn(['--check', '--clock', absent]);
  assert.equal(differs.status, 1, `${differs.stdout}${differs.stderr}`);
  assert.ok(differs.stdout.endsWith(`\ncheck: ${absent} differs\n  it does not exist\n`), differs.stdout);
  const usage = spawn(['--bogus']);
  assert.equal(usage.status, 2, usage.stderr);
  assert.match(usage.stderr, /unknown flag --bogus/);
  const bad = spawn(filesOf(FAILING('A'), result('B', 5, 6, { version: 2 }), PASSING('C')).flags);
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /clock B: the result is version 2, not 1/);
});

test('clock verdict: importing the module runs nothing', () => {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(SCRIPT).href)});`], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, '');
});

test('clock verdict: the committed results and config/clock.json agree (the Prove)', () => {
  const r = spawn(['--check']);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  const read = readClock(DEFAULT_CLOCK_FILE);
  assert.notEqual(read, null);
  assert.equal(clockLine(r.stdout), `clock: ${read.clock}`);
  // The block that DOM-003's MEASURED line of the Prove records.
  assert.equal(
    r.stdout,
    [
      'A actions-schedule FAIL p90_gap_min=411.82 max_gap_min=411.82 runs=10/576 window=2026-10-28T20:20:09Z..2026-10-30T20:20:09Z',
      'B actions-chain PASS p90_gap_min=5.02 max_gap_min=5.9 runs=577/576 window=2026-10-28T15:16:01Z..2026-10-30T15:16:01Z',
      'C worker PASS p90_gap_min=1.01 max_gap_min=2.73 runs=2875/2880 window=2026-10-28T15:23:24.560Z..2026-10-30T15:23:24.560Z',
      'rule: the first of A, B and C whose p90 gap is at most 15 min and whose max gap is at most 60 min',
      'clock: actions-chain',
      'check: config/clock.json agrees',
      '',
    ].join('\n'),
  );
  assert.deepEqual(checkClockFile(DEFAULT_CLOCK_FILE, decide(committed())), []);
});

test('clock verdict: docs/clock.md holds the table of the committed results and names the verdict in force', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'clock.md'), 'utf8').split('\n');
  const head = doc.indexOf(TABLE_HEAD[0]);
  assert.notEqual(head, -1, `docs/clock.md lacks the head of the table:\n${TABLE_HEAD[0]}`);
  const end = doc.indexOf('', head);
  assert.deepEqual(doc.slice(head, end === -1 ? undefined : end), [...TABLE_HEAD, ...tableRows(committed())], 'the table is the head and one row per clock, in the rule order');
  assert.equal(doc.filter((l) => l.startsWith('|')).length, TABLE_HEAD.length + CLOCKS.length, 'docs/clock.md has one table');
  const { clock } = readClock(DEFAULT_CLOCK_FILE);
  assert.ok(
    doc.some((l) => l.includes(`The verdict in force is \`${clock}\``)),
    `docs/clock.md does not name the verdict in force, ${clock}`,
  );
});

// A text with its runs of white space made one space, so a phrase matches
// across the wrap of a line.
const flat = (text) => text.replace(/\s+/g, ' ');

test('clock verdict: every number in the prose of docs/clock.md comes from the files or the constants', () => {
  const text = readFileSync(join(ROOT, 'docs', 'clock.md'), 'utf8');
  const proseText = text
    .split('\n')
    .filter((l) => !l.startsWith('|'))
    .join('\n');
  const chain = JSON.parse(readFileSync(slot('B').file, 'utf8'));
  const runnerS = chain.cost.runner_s_total;
  const p = RULE.p90_max_min;
  const m = RULE.max_max_min;
  const facts = [
    `## The three clocks over ${HOURS} hours`,
    `whose p90 gap is at most ${p} minutes and whose largest gap is at most ${m} minutes`,
    `a clock that stops more than ${m} minutes before the window's end fails`,
    `sets \`interval_min\` to ${INTERVAL_MIN}, the default of \`scripts/ingest/chain.mjs\``,
    `sleeps to the next multiple of ${INTERVAL_MIN} minutes`,
    `At an interval of ${INTERVAL_MIN} minutes the p90 gap is expected to be about ${INTERVAL_MIN} minutes [E]`,
    `the measured chain used ${runnerS.toLocaleString('en-US')} s, about ${Math.round(runnerS / 360) / 10} hours, of runner time`,
    `The chain at ${INTERVAL_MIN} minutes is not measured`,
  ];
  for (const f of facts) assert.ok(flat(proseText).includes(f), `docs/clock.md lacks: ${f}`);
  assert.equal(INTERVAL_MIN, DEFAULT_INTERVAL_MIN, 'docs/clock.md calls the interval the default of chain.mjs');
  // Every other number is one of the same: ids, rulings and section numbers aside.
  const allowed = new Set([HOURS, p, m, INTERVAL_MIN, runnerS.toLocaleString('en-US'), Math.round(runnerS / 360) / 10].map(String));
  const bare = flat(proseText)
    .replace(/`[^`]*`/g, ' ')
    .replace(/\bDOM-\d+\b/g, ' ')
    .replace(/\bruling \d+\b/gi, ' ')
    .replace(/\bsections? \d+(?:\.\d+)*\b/gi, ' ');
  for (const [n] of bare.matchAll(/(?<![\w.,-])\d+(?:[.,]\d+)*(?!\w)/g)) assert.ok(allowed.has(n), `docs/clock.md states ${n}, which no file or constant gives`);
});

test("clock verdict: docs/architecture.md and ruling 17 state the rule's numbers", () => {
  const p = RULE.p90_max_min;
  const m = RULE.max_max_min;
  const architecture = flat(readFileSync(join(ROOT, 'docs', 'architecture.md'), 'utf8'));
  for (const f of [`a p90 of ${p} minutes and a maximum of ${m}`, `whose p90 gap is at most ${p} minutes and whose maximum gap is at most ${m} minutes`]) {
    assert.ok(architecture.includes(f), `docs/architecture.md lacks: ${f}`);
  }
  const rules = flat(readFileSync(join(ROOT, 'TODO', 'RULES.md'), 'utf8'));
  assert.ok(rules.includes(`**The clock thresholds are ${p} and ${m} minutes**`), 'ruling 17 of TODO/RULES.md does not state RULE');
});
