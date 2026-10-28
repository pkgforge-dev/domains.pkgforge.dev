// The run and the verdict of scripts/measure/thc-day.mjs: a small day through
// every stage (fixtures/thc/day.txt with the mini list, counted by hand), the
// download's fallback and size checks against a local server, a stage that
// fails, and the pass rule.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { checkAgreement, download, gnuSortVersion, PASS_SECONDS, RESULT_FORMAT, StageError, verdict } from './thc-day.mjs';

const SCRIPT = fileURLToPath(new URL('./thc-day.mjs', import.meta.url));
const DAY = fileURLToPath(new URL('./fixtures/thc/day.txt', import.meta.url));
const PSL = fileURLToPath(new URL('./fixtures/thc/psl-mini.dat', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'thc-day-'));
const noSort = gnuSortVersion('sort') === null ? 'GNU sort is not on PATH' : false;
const gz = join(dir, 'day.txt.gz');
const body = gzipSync(readFileSync(DAY));
writeFileSync(gz, body);

let server;
let base;
const agents = new Set();
before(async () => {
  server = createServer((req, res) => {
    agents.add(req.headers['user-agent']);
    if (req.url === '/missing') {
      res.writeHead(404).end('no');
    } else if (req.url === '/moved') {
      res.writeHead(302, { location: '/day.txt.gz' }).end();
    } else if (req.url === '/day.txt.gz') {
      res.writeHead(200, { 'content-length': body.length }).end(body);
    } else {
      res.writeHead(500).end();
    }
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => {
  server.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });

test('thc day: a day through every stage gives the counts made by hand', { skip: noSort }, () => {
  const out = join(dir, 'out');
  const r = run('--day', '2026-10-26', '--input', gz, '--psl', PSL, '--work', join(dir, 'work'), '--out', out, '--sample-bits', '0', '--per-block', '4');
  assert.equal(r.status, 0, r.stderr);
  const stat = JSON.parse(readFileSync(join(out, '2026-10-26.stat.json'), 'utf8'));
  assert.equal(stat.format, 'domains.measure.thc-day.v1');
  assert.deepEqual(Object.keys(stat.stages), ['download', 'normalise', 'sort', 'split', 'encode', 'verify']);
  assert.equal(stat.counts.lines, 41);
  assert.equal(stat.normalise.records_written, 35);
  assert.equal(stat.counts.names, 29);
  assert.deepEqual(stat.counts.flags, { plain: 26, wildcard: 0, both: 3 });
  assert.equal(stat.counts.names_that_are_a_suffix, 2);
  assert.equal(stat.counts.distinct_registrable_icann, 14);
  assert.equal(stat.counts.distinct_sites_full_psl, 17);
  assert.equal(stat.counts.tlds, 9);
  assert.equal(stat.pack.blocks, 8);
  assert.deepEqual(stat.verify, { ok: true, records: 29, blocks: 8 });
  assert.equal(statSync(join(out, '2026-10-26.names.f64')).size, 29 * 8);
  assert.equal(statSync(join(out, '2026-10-26.regs.f64')).size, 14 * 8);
  assert.equal(stat.files.names.count, 29);
  assert.ok(stat.wall_seconds > 0);
  assert.equal(existsSync(join(dir, 'work', '2026-10-26.sorted')), false);
  assert.match(r.stdout, /^2026-10-26 wall=/);
});

test('thc day: a gzip stream that does not check fails the normalise stage and leaves its record', { skip: noSort }, () => {
  const cut = join(dir, 'cut.txt.gz');
  writeFileSync(cut, body.subarray(0, body.length - 6));
  const out = join(dir, 'out-cut');
  const r = run('--day', '2026-10-25', '--input', cut, '--psl', PSL, '--work', join(dir, 'work-cut'), '--out', out);
  assert.equal(r.status, 1);
  const failed = JSON.parse(readFileSync(join(out, '2026-10-25.failed.json'), 'utf8'));
  assert.equal(failed.failed.stage, 'normalise');
  assert.equal(existsSync(join(out, '2026-10-25.stat.json')), false);
});

test('thc day: a run refuses a missing flag and a sort that is not GNU sort', () => {
  assert.equal(run('--day', '2026-10-26', '--psl', PSL, '--work', dir, '--out', dir).status, 2);
  assert.equal(run('--day', '2026-10-26', '--input', gz, '--psl', PSL, '--work', dir, '--out', dir, '--sort', process.execPath).status, 2);
  assert.equal(run('--day', '2026-02-30', '--input', gz, '--psl', PSL, '--work', dir, '--out', dir).status, 2);
});

test('thc day: the download falls back to the next source and follows a redirect', async () => {
  const dest = join(dir, 'dl-1.gz');
  const r = await download({
    sources: [
      { source: 'cs2', url: `${base}/missing` },
      { source: 'hf', url: `${base}/moved` },
    ],
    dest,
    size: body.length,
  });
  assert.equal(r.ok, true);
  assert.equal(r.source, 'hf');
  assert.equal(r.bytes, body.length);
  assert.deepEqual(
    r.attempts.map((a) => [a.source, a.status]),
    [
      ['cs2', 404],
      ['hf', 200],
    ],
  );
  assert.deepEqual(readFileSync(dest), body);
  assert.deepEqual([...agents], [USER_AGENT], 'every request sends the contact User-Agent (ruling 11)');
});

test('thc day: the download refuses a file whose size is not the listing size', async () => {
  const r = await download({ sources: [{ source: 'cs2', url: `${base}/day.txt.gz` }], dest: join(dir, 'dl-2.gz'), size: body.length + 1 });
  assert.equal(r.ok, false);
  assert.match(r.attempts[0].error, /the listing says/);
  const none = await download({ sources: [{ source: 'cs2', url: 'http://127.0.0.1:9/day.txt.gz' }], dest: join(dir, 'dl-3.gz'), size: 1 });
  assert.equal(none.ok, false);
  assert.ok(none.attempts[0].error);
});

function result(days) {
  return {
    format: RESULT_FORMAT,
    span: { first: days[0].day, last: days[days.length - 1].day, days: days.length, gaps: [] },
    [`distinct_names_${days.length}d`]: 100,
    [`distinct_registrable_${days.length}d`]: 10,
    bytes_per_name: 6.1,
    novelty_curve: [],
    per_day: days.map((d) => ({
      stages: { download: 1, normalise: 1, sort: 1, split: 1, encode: 1, verify: 1 },
      peak_rss_kib: 2048,
      distinct_names: 50,
      bytes_per_name: 6.1,
      source: 'hf',
      runner_os: 'Linux',
      verified: true,
      ...d,
    })),
  };
}

test('thc day: the verdict passes a day under 30 minutes on a runner and fails the rest', () => {
  assert.equal(verdict(result([{ day: '2026-10-25', wall_seconds: 600 }])).pass, true);
  const slow = verdict(result([{ day: '2026-09-15', wall_seconds: PASS_SECONDS }]));
  assert.equal(slow.pass, false);
  assert.match(slow.reasons[0], /2026-09-15 took 1800s/);
  assert.equal(verdict(result([{ day: '2026-10-25', wall_seconds: 600, runner_os: null }])).pass, false);
  assert.equal(verdict(result([{ day: '2026-10-25', wall_seconds: 600, verified: false }])).pass, false);
  assert.throws(() => verdict({ format: 'other' }));
  assert.throws(() => verdict({ format: RESULT_FORMAT, per_day: [] }));
});

test('thc day: every day is judged, so one slow, unverified or desktop day in any place fails the whole', () => {
  const days = (n) => Array.from({ length: n }, (_, i) => ({ day: `2026-09-${String(i + 1).padStart(2, '0')}`, wall_seconds: 600 + i }));
  assert.equal(verdict(result(days(2))).pass, true);
  assert.equal(verdict(result(days(28))).pass, true);
  for (const [n, at] of [
    [2, 1],
    [28, 13],
    [28, 27],
  ]) {
    for (const [fault, re] of [
      [{ wall_seconds: PASS_SECONDS + 1 }, /took 1801s, not under 1800s/],
      [{ verified: false }, /did not verify/],
      [{ runner_os: null }, /was not measured on a runner/],
      [{ wall_seconds: undefined }, /took undefineds, not under 1800s/],
      [{ wall_seconds: 'fast' }, /took fasts, not under 1800s/],
    ]) {
      const list = days(n);
      Object.assign(list[at], fault);
      const v = verdict(result(list));
      assert.equal(v.pass, false, `${n} days, fault at ${at}: ${JSON.stringify(fault)}`);
      assert.equal(v.reasons.length, 1);
      assert.match(v.reasons[0], new RegExp(`^${list[at].day} `));
      assert.match(v.reasons[0], re);
    }
  }
  // The format is checked on its own: per_day being right does not save a wrong format.
  assert.throws(() => verdict({ ...result(days(2)), format: 'domains.measure.thc-day.v1' }), /format is domains\.measure\.thc-day\.v1, not domains\.measure\.thc\.v1/);
});

test('thc day: the stages must agree on the list and on the names counted', () => {
  const sha = 'a'.repeat(64);
  assert.doesNotThrow(() => checkAgreement({ runPsl: sha, splitPsl: sha, names: 29 }));
  assert.doesNotThrow(() => checkAgreement({ runPsl: sha, splitPsl: sha, names: 29, counted: { encode: 29, verify: 29 } }));
  const refused = (args, re) =>
    assert.throws(
      () => checkAgreement(args),
      (e) => e instanceof StageError && re.test(e.message),
      JSON.stringify(args),
    );
  refused({ runPsl: sha, splitPsl: 'b'.repeat(64), names: 29 }, /^split: read another list than the run$/);
  refused({ runPsl: undefined, splitPsl: undefined, names: 29 }, /^split: read another list/);
  refused({ runPsl: sha, splitPsl: sha, names: 29, counted: { encode: 28, verify: 29 } }, /^verify: split counted 29 names, encode 28, verify 29$/);
  refused({ runPsl: sha, splitPsl: sha, names: 29, counted: { encode: 29, verify: 30 } }, /verify 30/);
  refused({ runPsl: sha, splitPsl: sha, names: 29, counted: { encode: undefined, verify: undefined } }, /encode undefined/);
});

test('thc day: --verdict prints the stage seconds and PASS or FAIL, with exit 0, 1 or 2', () => {
  const ok = join(dir, 'ok.json');
  writeFileSync(ok, JSON.stringify(result([{ day: '2026-10-25', wall_seconds: 600 }])));
  const pass = run('--verdict', ok);
  assert.equal(pass.status, 0);
  assert.match(pass.stdout, /2026-10-25 wall=600s download=1s normalise=1s sort=1s split=1s encode=1s verify=1s/);
  assert.match(pass.stdout, /union days=1 .* distinct_names_1d=100 distinct_registrable_1d=10 bytes_per_name=6.1/);
  assert.match(pass.stdout, /\nPASS\n$/);
  const bad = join(dir, 'bad.json');
  writeFileSync(bad, JSON.stringify(result([{ day: '2026-10-25', wall_seconds: 2000 }])));
  const fail = run('--verdict', bad);
  assert.equal(fail.status, 1);
  assert.match(fail.stdout, /\nFAIL 2026-10-25 took 2000s/);
  assert.equal(run('--verdict', join(dir, 'absent.json')).status, 2);
});
