// scripts/compact/measure.mjs: the synthetic inputs of the runner measurement
// of DOM-023 make one unit whole, plan.mjs and range.mjs merge them, and
// `result` holds the line it prints to what the stages and the merge gave.
// Each refusal is planted alone. .github/workflows/measure-compact.yml, read
// as YAML: dispatch only, read-only, one job that times the two stages of
// range.mjs under /usr/bin/time -v and prints the line through measure.mjs.
//
//   node scripts/test.mjs scripts/compact --name "measure"
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { checkText } from '../check-workflows.mjs';
import { elapsedSeconds, EXIT, Fault, indexesOf, keyOf, MAX_FEED_ROWS, main, parseTime, RESULT_FORMAT, TIME_FIELDS } from './measure.mjs';
import { EXIT as PLAN_EXIT, main as planMain } from './plan.mjs';
import { EXIT as RANGE_EXIT, main as rangeMain } from './range.mjs';

const WORKFLOW = fileURLToPath(new URL('../../.github/workflows/measure-compact.yml', import.meta.url));

async function call(fn, argv, deps = {}) {
  const out = [];
  const err = [];
  const code = await fn(argv, { out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => undefined, ...deps });
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

async function inTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'compact-measure-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The output of `/usr/bin/time -v -o FILE` as GNU time lays it out, one field
// a line after a tab; `drop` leaves out the line of one label.
function timeText({ wall = '0:12.97', rss = '187644', exit = '0', drop = null } = {}) {
  const lines = [
    exit === '0' ? null : `Command exited with non-zero status ${exit}`,
    '\tCommand being timed: "node scripts/compact/range.mjs write --plan plan.json --range 0 --out out"',
    '\tUser time (seconds): 12.34',
    '\tSystem time (seconds): 1.20',
    '\tPercent of CPU this job got: 104%',
    `\tElapsed (wall clock) time (h:mm:ss or m:ss): ${wall}`,
    '\tAverage shared text size (kbytes): 0',
    `\tMaximum resident set size (kbytes): ${rss}`,
    '\tMajor (requiring I/O) page faults: 0',
    '\tFile system outputs: 8',
    '\tPage size (bytes): 4096',
    `\tExit status: ${exit}`,
  ];
  return `${lines.filter((l) => l !== null && (drop === null || !l.includes(`${drop}:`))).join('\n')}\n`;
}

// Inputs, a one-range plan, both stages of range.mjs, and the two time files.
async function measured(dir, dataset = 'names', inputs = '7', overlap = '0.3') {
  const m = join(dir, 'm');
  const made = await call(main, ['inputs', '--dataset', dataset, '--inputs', inputs, '--rows', '30', '--overlap', overlap, '--records-per-block', '8', '--out', m]);
  assert.equal(made.code, EXIT.ok, made.text);
  const facts = JSON.parse(readFileSync(join(m, 'inputs.json'), 'utf8'));
  const plan = join(dir, 'plan.json');
  const p = await call(planMain, ['--dataset', dataset, '--tier', facts.tier, '--span', facts.span, '--root', join(m, 'root.json'), '--inputs', join(m, 'in'), '--ranges', '1', '--out', plan]);
  assert.equal(p.code, PLAN_EXIT.ok, p.text);
  const out = join(dir, 'out');
  for (const stage of ['count', 'write']) {
    const r = await call(rangeMain, [stage, '--plan', plan, '--range', '0', '--out', out, '--inputs', join(m, 'in')]);
    assert.equal(r.code, RANGE_EXIT.ok, r.text);
  }
  writeFileSync(join(dir, 'time.count'), timeText({ wall: '0:03.10', rss: '90112' }));
  writeFileSync(join(dir, 'time.write'), timeText());
  const argv = (over = {}) => {
    const flags = {
      inputs: join(m, 'inputs.json'),
      plan,
      'out-dir': out,
      'count-time': join(dir, 'time.count'),
      'write-time': join(dir, 'time.write'),
      'free-before': '1000000',
      'free-after': '990000',
      ...over,
    };
    return ['result', ...Object.entries(flags).flatMap(([k, v]) => [`--${k}`, v])];
  };
  return { m, facts, plan, out, made, argv };
}

const NOW = new Date('2026-10-29T22:00:00.123Z');

test('measure inputs: seven names day packs make the week whole, and result prints one line of both stages, the disk and the merge', () =>
  inTmp(async (dir) => {
    const w = await measured(dir);
    assert.match(w.made.out[0], /^inputs names 7 packs of tier d for the w unit from 2026-10-19T00:00:00Z: \d+ records, 210 distinct, \d+ B$/);
    assert.equal(w.facts.distinct, 210);
    assert.ok(w.facts.records > w.facts.distinct, 'the overlap puts some keys in two inputs');
    assert.deepEqual(w.facts.tags.slice(0, 2), ['names-d-20261019', 'names-d-20261020']);
    const r = await call(main, w.argv(), { now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out.length, 1);
    const line = JSON.parse(r.out[0]);
    assert.equal(line.format, RESULT_FORMAT);
    assert.equal(line.at, '2026-10-29T22:00:00Z');
    assert.deepEqual([line.dataset, line.tier, line.span.start, line.span.end], ['names', 'w', '2026-10-19T00:00:00Z', '2026-10-26T00:00:00Z']);
    assert.deepEqual([line.inputs, line.rows_per_input, line.distinct, line.input_records, line.ranges], [7, 30, 210, w.facts.records, 1]);
    assert.equal(line.output.records, 210);
    assert.ok(line.output.part_bytes > 0 && line.output.idx_bytes > 0);
    assert.equal(line.time_copy, null);
    assert.deepEqual(line.count, { wall_s: 3.1, user_s: 12.34, sys_s: 1.2, cpu_percent: 104, max_rss_kib: 90112, exit: 0 });
    assert.deepEqual(line.write, { wall_s: 12.97, user_s: 12.34, sys_s: 1.2, cpu_percent: 104, max_rss_kib: 187644, exit: 0 });
    assert.deepEqual(line.disk, { free_before_bytes: 1000000, free_after_bytes: 990000, used_bytes: 10000 });
    assert.ok(line.runner.cpus >= 1 && line.runner.mem_bytes > 0);
  }));

test('measure inputs: feed day packs carry their time copies, which the merge of disjoint inputs merges by range', () =>
  inTmp(async (dir) => {
    const w = await measured(dir, 'feed', '7', '0');
    assert.equal(w.facts.time_copies, true);
    assert.equal(w.facts.records, w.facts.distinct);
    const line = JSON.parse((await call(main, w.argv(), { now: NOW })).out[0]);
    assert.equal(line.time_copy, 'merged');
    assert.ok(line.output.time_part_bytes > 0);
  }));

test('measure inputs: 24 new-name hour packs make the day whole with no time copy, which the plan leaves to sort', () =>
  inTmp(async (dir) => {
    const w = await measured(dir, 'new-name', '24', '0.2');
    assert.equal(w.facts.time_copies, false);
    assert.deepEqual([w.facts.tier, w.facts.span, w.facts.distinct], ['d', '2026-10-26T00:00:00Z', 720]);
    const line = JSON.parse((await call(main, w.argv(), { now: NOW })).out[0]);
    assert.equal(line.time_copy, 'left to assemble.mjs');
    assert.equal(line.output.records, 720);
  }));

test('measure keys: each input ascends, every index of rows times K is in one input, and an overlap adds each shared index to one more', () => {
  for (const overlap of [0, 0.25, 1]) {
    const seen = new Map();
    let total = 0;
    for (let j = 0; j < 7; j += 1) {
      const idx = [...indexesOf(j, 7, 40, overlap, 1)];
      for (let n = 1; n < idx.length; n += 1) assert.ok(idx[n] > idx[n - 1], `input ${j} ascends`);
      const keys = idx.map((i) => keyOf('names', i));
      assert.deepEqual([...keys].sort(), keys, `the keys of input ${j} ascend as their indexes do`);
      for (const i of idx) seen.set(i, (seen.get(i) ?? 0) + 1);
      total += idx.length;
    }
    assert.equal(seen.size, 280);
    assert.deepEqual(
      [...seen.keys()].sort((a, b) => a - b),
      Array.from({ length: 280 }, (_, i) => i),
    );
    for (const n of seen.values()) assert.ok(n === 1 || n === 2);
    if (overlap === 0) assert.equal(total, 280);
    if (overlap === 1) assert.equal(total, 560);
    if (overlap === 0.25) assert.ok(total > 280 + 30 && total < 280 + 110, `${total - 280} shared of 280`);
  }
  assert.match(keyOf('names', 12), /^com\.m0000000012\.[0-9a-z]{6}$/);
  assert.match(keyOf('domains', 12), /^com\.m0000000012[0-9a-z]{6}$/);
});

test('measure result: a time output that lacks the peak memory is refused, exit 1', () =>
  inTmp(async (dir) => {
    const w = await measured(dir);
    writeFileSync(join(dir, 'time.write'), timeText({ drop: TIME_FIELDS.max_rss_kib }));
    const r = await call(main, w.argv(), { now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /FAIL the write time output holds no line\(s\) of "Maximum resident set size \(kbytes\)"/);
    assert.deepEqual(r.out, []);
  }));

test('measure result: a stage that exited other than 0 is no measurement, exit 1', () =>
  inTmp(async (dir) => {
    const w = await measured(dir);
    writeFileSync(join(dir, 'time.count'), timeText({ exit: '1' }));
    const r = await call(main, w.argv(), { now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /FAIL the count stage exited 1: a merge that failed is no measurement/);
  }));

test('measure result: a merge whose records are not the inputs distinct keys is refused, exit 1', () =>
  inTmp(async (dir) => {
    const w = await measured(dir);
    const facts = JSON.parse(readFileSync(join(w.m, 'inputs.json'), 'utf8'));
    writeFileSync(join(w.m, 'inputs.json'), `${JSON.stringify({ ...facts, distinct: facts.distinct + 1 })}\n`);
    const r = await call(main, w.argv(), { now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /FAIL the merge wrote 210 records; the inputs hold 211 distinct keys/);
  }));

test('measure result: a range file of another plan is refused, exit 1', () =>
  inTmp(async (dir) => {
    const w = await measured(dir);
    const path = join(w.out, 'range.key.000.json');
    const range = JSON.parse(readFileSync(path, 'utf8'));
    writeFileSync(path, `${JSON.stringify({ ...range, plan: '0'.repeat(64) })}\n`);
    const r = await call(main, w.argv(), { now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /FAIL range 0 is of the plan 0{64}, not [0-9a-f]{64}/);
  }));

test('measure result: an output directory with no range file is refused, exit 1', () =>
  inTmp(async (dir) => {
    const w = await measured(dir);
    const r = await call(main, w.argv({ 'out-dir': w.m }), { now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /holds no range\.key\.NNN\.json: the write stage wrote nothing/);
  }));

test('measure time: the elapsed time reads as h:mm:ss and m:ss.ss, and anything else is refused', () => {
  assert.equal(elapsedSeconds('1:02:03'), 3723);
  assert.equal(elapsedSeconds('0:01.50'), 1.5);
  assert.equal(elapsedSeconds('12:00.04'), 720.04);
  for (const bad of ['1.5', '', '1:2:3:4', 'a:00.1']) assert.throws(() => elapsedSeconds(bad), Fault, bad);
  assert.equal(parseTime(timeText({ wall: '1:02:03' }), 'write').wall_s, 3723);
  // A label twice is not one output of /usr/bin/time -v.
  assert.throws(() => parseTime(`${timeText()}${timeText()}`, 'write'), /holds 2 line\(s\) of "Exit status"/);
  assert.throws(() => parseTime(timeText({ rss: 'n/a' }), 'write'), /gives "Maximum resident set size \(kbytes\)" as "n\/a", not a number/);
});

test('measure usage: a fan-in, a row count, an overlap or an output it does not take is refused, exit 2', () =>
  inTmp(async (dir) => {
    const base = ['inputs', '--dataset', 'names', '--inputs', '7', '--rows', '5', '--out', join(dir, 'a')];
    const with_ = (k, v) => base.map((x, i) => (base[i - 1] === `--${k}` ? v : x));
    const full = join(dir, 'full');
    mkdirSync(full);
    writeFileSync(join(full, 'planted'), '');
    for (const [argv, what] of [
      [with_('inputs', '8'), /--inputs is "8", not one of 7, 24, 30/],
      [with_('rows', '0'), /--rows is "0", not a whole number of 1 to/],
      [with_('dataset', 'rev'), /--dataset is "rev", not one of names, domains, feed, new-name/],
      // Its --out is not empty, so a cap that let the rows through fails here, before any pack is written.
      [['inputs', '--dataset', 'feed', '--inputs', '7', '--rows', String(MAX_FEED_ROWS + 1), '--out', full], /--rows is "10000001", not a whole number of 1 to 10000000/],
      [[...base, '--overlap', '2'], /--overlap is "2", not a number of 0 to 1/],
      [['merge', '--dir', dir], /the first word is "merge", not inputs, free or result/],
      [['free', '--dir', dir, '--rows', '1'], /--rows is not a flag of free/],
      [['result', '--inputs', 'x'], /--plan is needed/],
    ]) {
      const r = await call(main, argv);
      assert.equal(r.code, EXIT.usage, `${argv.join(' ')}\n${r.text}`);
      assert.match(r.text, what);
    }
    // The inputs go into a new directory, never over another run's.
    writeFileSync(join(dir, 'planted'), '');
    const r = await call(main, ['inputs', '--dataset', 'names', '--inputs', '7', '--rows', '5', '--out', dir]);
    assert.equal(r.code, EXIT.usage, r.text);
    assert.match(r.text, /is not empty: the inputs go into a new directory/);
  }));

test('measure free: the bytes free on a directory, one whole number; a directory that does not exist is exit 2', () =>
  inTmp(async (dir) => {
    const r = await call(main, ['free', '--dir', dir]);
    assert.equal(r.code, EXIT.ok, r.text);
    assert.match(r.out[0], /^[1-9][0-9]*$/);
    const gone = await call(main, ['free', '--dir', join(dir, 'gone')]);
    assert.equal(gone.code, EXIT.usage, gone.text);
  }));

test('measure-compact: dispatch only, one read-only job that times both stages of range.mjs under /usr/bin/time -v and prints the line through measure.mjs', () => {
  const text = readFileSync(WORKFLOW, 'utf8');
  const wf = parse(text);
  assert.deepEqual(Object.keys(wf.on), ['workflow_dispatch']);
  assert.deepEqual(Object.keys(wf.on.workflow_dispatch.inputs), ['dataset', 'inputs', 'rows', 'overlap']);
  assert.deepEqual(wf.on.workflow_dispatch.inputs.inputs.options, ['7', '24', '30']);
  assert.deepEqual(wf.permissions, {});
  assert.deepEqual(Object.keys(wf.jobs), ['measure']);
  const job = wf.jobs.measure;
  assert.deepEqual(job.permissions, { contents: 'read' });
  assert.equal(job['runs-on'], 'ubuntu-24.04');
  // No step holds a token, and nothing is pushed.
  assert.doesNotMatch(text, /github\.token|REGISTRY_TOKEN|push\.mjs|oras /);
  const merge = job.steps.find((s) => s.id === 'merge');
  for (const stage of ['count', 'write']) {
    assert.match(
      merge.run,
      new RegExp(`/usr/bin/time -v -o "\\$WORK/time\\.${stage}" node scripts/compact/range\\.mjs ${stage} --plan "\\$WORK/plan\\.json" --range 0 --out "\\$WORK/out" --inputs "\\$WORK/m/in"`),
    );
  }
  assert.match(merge.run, /node scripts\/compact\/measure\.mjs result /);
  assert.match(merge.run, /free_before="\$\(node scripts\/compact\/measure\.mjs free --dir "\$WORK"\)"/);
  assert.deepEqual(checkText(text, '.github/workflows/measure-compact.yml'), []);
});
