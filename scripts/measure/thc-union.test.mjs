// The merge of scripts/measure/thc-union.mjs: the union and the novelty counts
// against a brute-force count, the estimate from a sample, the listing check,
// and the refusals of days that do not agree.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sampleLimit, writeF64 } from './f64cmp.mjs';
import { verdict } from './thc-day.mjs';
import { estimate, findStats, mergeDays, UnionError, union } from './thc-union.mjs';

const SCRIPT = fileURLToPath(new URL('./thc-union.mjs', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'thc-union-'));
after(() => rmSync(root, { recursive: true, force: true }));

function brute(arrays) {
  const seen = new Map();
  const first = arrays.map(() => 0);
  const previous = arrays.map(() => 0);
  arrays.forEach((a, d) => {
    for (const v of a) {
      if (!seen.has(v)) {
        seen.set(v, new Set());
        first[d] += 1;
      }
      if (d > 0 && seen.get(v).has(d - 1)) previous[d] += 1;
      seen.get(v).add(d);
    }
  });
  return { distinct: seen.size, first, previous };
}

test('thc union: mergeDays counts the union, the first day of each value and the day before', () => {
  const arrays = [new Float64Array([1, 5, 9]), new Float64Array([5, 6]), new Float64Array([1, 6, 7])];
  assert.deepEqual(mergeDays(arrays, 16), { distinct: 5, first: [3, 1, 1], previous: [0, 1, 1] });
});

test('thc union: mergeDays equals a brute-force count on random days across buckets', () => {
  let seed = 7;
  const rand = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed;
  };
  const limit = sampleLimit(20);
  for (const days of [1, 2, 5, 70]) {
    const arrays = [];
    for (let d = 0; d < days; d++) {
      const s = new Set();
      for (let i = 0; i < 300; i++) s.add(rand() % 2000 === 0 ? limit - 1 : (rand() % 4096) * (limit / 4096));
      arrays.push(Float64Array.from([...s].sort((a, b) => a - b)));
    }
    assert.deepEqual(mergeDays(arrays, limit), brute(arrays.map((a) => [...a])), `${days} days`);
  }
  assert.throws(() => mergeDays([new Float64Array([16])], 16), UnionError);
});

test('thc union: the estimate scales the sampled union by the exact day counts', () => {
  assert.deepEqual(estimate(100, 1000, 1000, 0, 2 ** 53).value, 100);
  const e = estimate(1000, 16000, 1000, 4, sampleLimit(4));
  assert.equal(e.value, 16000);
  assert.equal(e.scale, 16);
  assert.equal(e.nominal_scale, 16);
  assert.ok(e.relative_standard_error > 0 && e.relative_standard_error < 0.05);
});

let n = 0;
function writeDay(dir, day, names, regs, extra = {}) {
  mkdirSync(dir, { recursive: true });
  const stat = {
    format: 'domains.measure.thc-day.v1',
    day,
    runner: { os: 'Linux', arch: 'X64', cpus: 4, mem_bytes: 1 },
    settings: { sample_bits: 0, per_block: 4096 },
    psl: { sha256: 'a'.repeat(64) },
    stages: { download: { seconds: 1 }, normalise: { seconds: 2, peak_rss_kib: 1024 }, sort: { seconds: 3 }, split: { seconds: 4 }, encode: { seconds: 5 }, verify: { seconds: 6 } },
    download: { source: 'hf', listing_bytes: 100 },
    counts: { gz_bytes: 100, lines: names.length, names: names.length, distinct_registrable_icann: regs.length, distinct_sites_full_psl: regs.length },
    pack: { pack_bytes: names.length * 6, bytes_per_name: 6 },
    verify: { ok: true },
    files: { names: { file: `${day}.names.f64`, count: names.length }, regs: { file: `${day}.regs.f64`, count: regs.length } },
    peak_rss_kib: 1024,
    wall_seconds: 21 + n++,
    ...extra,
  };
  writeF64(join(dir, `${day}.names.f64`), Float64Array.from(names));
  writeF64(join(dir, `${day}.regs.f64`), Float64Array.from(regs));
  writeFileSync(join(dir, `${day}.stat.json`), JSON.stringify(stat));
}

function listing(dir, days) {
  const path = join(dir, 'listing.json');
  writeFileSync(path, JSON.stringify(days.map((d) => ({ type: 'file', path: `${d.slice(0, 4)}/${Number(d.slice(5, 7))}/${d}.txt.gz`, size: 100 }))));
  return path;
}

test('thc union: merges the days of a run, with the gaps the listing leaves', () => {
  const dir = join(root, 'ok');
  writeDay(join(dir, 'thc-day-2026-10-03'), '2026-10-03', [1, 2, 3], [1]);
  writeDay(join(dir, 'thc-day-2026-10-05'), '2026-10-05', [2, 3, 4, 5], [1, 2]);
  writeDay(join(dir, 'thc-day-2026-10-06'), '2026-10-06', [5, 6], [3]);
  const r = union(findStats(dir), { listing: listing(dir, ['2026-10-03', '2026-10-05', '2026-10-06', '2026-10-07']) });
  assert.equal(r.format, 'domains.measure.thc.v1');
  assert.deepEqual(r.span, { first: '2026-10-03', last: '2026-10-06', days: 3, gaps: ['2026-10-04'], listing_checked: true });
  assert.equal(r.distinct_names_3d, 6);
  assert.equal(r.distinct_registrable_3d, 3);
  assert.equal(r.sum_daily_names, 9);
  assert.equal(r.bytes_per_name, 6);
  assert.deepEqual(
    r.novelty_curve.map((p) => [p.day, p.share_new_names, p.share_names_in_previous_day, p.share_new_registrable]),
    [
      ['2026-10-03', 1, null, 1],
      ['2026-10-05', 0.5, 0.5, 0.5],
      ['2026-10-06', 0.5, 0.5, 1],
    ],
  );
  assert.deepEqual(r.slowest_day.day, '2026-10-06');
  assert.deepEqual(r.per_day[0].stages, { download: 1, normalise: 2, sort: 3, split: 4, encode: 5, verify: 6 });
  assert.equal(r.estimate.method, 'every hash');
});

test('thc union: refuses days that do not agree, a file that is not its stat, and a missing listed day', () => {
  const base = (name) => {
    const dir = join(root, name);
    writeDay(join(dir, 'a'), '2026-10-05', [1, 2], [1]);
    return dir;
  };
  const bits = base('bits');
  writeDay(join(bits, 'b'), '2026-10-06', [1], [1], { settings: { sample_bits: 4, per_block: 4096 } });
  assert.throws(() => union(findStats(bits)), UnionError);
  const psl = base('psl');
  writeDay(join(psl, 'b'), '2026-10-06', [1], [1], { psl: { sha256: 'b'.repeat(64) } });
  assert.throws(() => union(findStats(psl)), UnionError);
  const count = base('count');
  writeDay(join(count, 'b'), '2026-10-06', [1], [1], { files: { names: { file: '2026-10-06.names.f64', count: 2 }, regs: { file: '2026-10-06.regs.f64', count: 1 } } });
  assert.throws(() => union(findStats(count)), UnionError);
  const twice = base('twice');
  writeDay(join(twice, 'b'), '2026-10-05', [1], [1]);
  assert.throws(() => union(findStats(twice)), UnionError);
  const missing = base('missing');
  writeDay(join(missing, 'b'), '2026-10-07', [1], [1]);
  assert.throws(() => union(findStats(missing), { listing: listing(missing, ['2026-10-05', '2026-10-06', '2026-10-07']) }), UnionError);
  const size = base('size');
  writeDay(join(size, 'b'), '2026-10-06', [1], [1], { download: { source: 'hf', listing_bytes: 99 } });
  assert.throws(() => union(findStats(size), { listing: listing(size, ['2026-10-05', '2026-10-06']) }), UnionError);
  assert.throws(() => union([]), UnionError);
});

test('thc union: the command line writes result.json, with exit 0, 1 or 2', () => {
  const dir = join(root, 'cli');
  writeDay(join(dir, 'a'), '2026-10-05', [1, 2], [1]);
  writeDay(join(dir, 'b'), '2026-10-06', [2, 3], [1]);
  const out = join(root, 'cli-result', 'result.json');
  const r = spawnSync(process.execPath, [SCRIPT, '--in', dir, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /days=2 gaps=none distinct_names_2d=3 distinct_registrable_2d=1/);
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).distinct_names_2d, 3);
  const bad = join(root, 'cli-bad');
  writeDay(join(bad, 'a'), '2026-10-05', [1], [1]);
  writeDay(join(bad, 'b'), '2026-10-06', [1], [1], { verify: { ok: false } });
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--in', bad, '--out', out]).status, 1);
  assert.equal(spawnSync(process.execPath, [SCRIPT, '--in', dir]).status, 2);
});

test('thc union: the estimate uses the observed ratio of exact to sampled counts, not the nominal one', () => {
  // 15,000 exact names sampled as 1,000 at 4 bits: the scale is 15, not 16.
  const e = estimate(1000, 15000, 1000, 4, 1e6);
  assert.equal(e.scale, 15);
  assert.equal(e.nominal_scale, 16);
  assert.equal(e.value, 15000);
  // sqrt((1 - 1/15) / 1000) = 0.030551
  assert.equal(e.relative_standard_error, 0.0306);
  // 1000^2 / (2 * 1e6) = 0.5 pairs in the sample, times the scale 15.
  assert.equal(e.expected_hash_collisions, 8);
  assert.equal(estimate(0, 0, 0, 4, 1e6).scale, 1);
  assert.equal(estimate(0, 100, 10, 4, 1e6).relative_standard_error, 0);
});

test('thc union: a day measured off a runner reaches per_day as runner_os null, and the verdict fails it', () => {
  const dir = join(root, 'desktop');
  writeDay(join(dir, 'a'), '2026-10-05', [1, 2], [1]);
  writeDay(join(dir, 'b'), '2026-10-06', [2, 3], [1], { runner: { os: null, arch: null } });
  const r = union(findStats(dir));
  assert.deepEqual(
    r.per_day.map((d) => d.runner_os),
    ['Linux', null],
  );
  const v = verdict(r);
  assert.equal(v.pass, false);
  assert.deepEqual(v.reasons, ['2026-10-06 was not measured on a runner']);
  const none = join(root, 'no-runner');
  writeDay(join(none, 'a'), '2026-10-05', [1], [1], { runner: undefined });
  assert.equal(union(findStats(none)).per_day[0].runner_os, null);
});

test('thc union: each disagreement is refused for its own fault', () => {
  const refused = (name, setup, re, opts = {}) => {
    const dir = join(root, `refuse-${name}`);
    writeDay(join(dir, 'a'), '2026-10-05', [1, 2], [1]);
    setup(dir);
    assert.throws(
      () => union(findStats(dir), opts.listing ? { listing: opts.listing(dir) } : {}),
      (e) => re.test(e.message),
      name,
    );
  };
  refused('block', (d) => writeDay(join(d, 'b'), '2026-10-06', [1], [1], { settings: { sample_bits: 0, per_block: 1024 } }), /2026-10-06: 1024 names a block, 2026-10-05 has 4096/);
  refused('format', (d) => writeDay(join(d, 'b'), '2026-10-06', [1], [1], { format: 'domains.measure.thc-day.v0' }), /format domains\.measure\.thc-day\.v0/);
  refused('verify', (d) => writeDay(join(d, 'b'), '2026-10-06', [1], [1], { verify: { ok: false } }), /2026-10-06: the pack did not verify/);
  refused('unlisted', (d) => writeDay(join(d, 'b'), '2026-10-06', [1], [1]) || writeDay(join(d, 'c'), '2026-10-07', [1], [1]), /missing none, not listed 2026-10-06/, {
    listing: (d) => listing(d, ['2026-10-05', '2026-10-07']),
  });
  refused('unsorted', (d) => writeDay(join(d, 'b'), '2026-10-06', [3, 1, 2], [1]), /2026-10-06\.names\.f64: value 1 is not above value 0/);
  refused('repeated', (d) => writeDay(join(d, 'b'), '2026-10-06', [1], [4, 4]), /2026-10-06\.regs\.f64: value 1 is not above value 0/);
  refused('no file', (d) => writeDay(join(d, 'b'), '2026-10-06', [1], [1], { files: { names: { file: '2026-10-06.names.f64', count: 1 } } }), /2026-10-06: the stat names no regs file/);
});
