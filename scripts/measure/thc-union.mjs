// scripts/measure/thc-union.mjs — merge the days of a measure-thc-day.yml run
// into result.json (DOM-009, TODO/ingest.md): the union of the names and of the
// registrable domains over every day, the novelty curve, the pack bytes a name,
// and each day's stage seconds. It generalises design A's union4.mjs
// (docs/research/2026-10-27-design-a/scripts/union4.mjs) from four fixed days
// to the days it is given, and reads the same hash files.
//
// The hash files are samples: a day keeps the hashes whose top `sample_bits`
// bits are zero (1 in 16 at the default of thc-day.mjs), because the whole
// files of 54 days are about 29 GB for the names alone, more than the 14 GB a
// runner's disk is guaranteed to hold, and 29 GB of artifacts a run. [E] That is the listing's 35,765,972,194 B of gzip over the 54
// days, at the 32,554,702 names in 319,917,410 B of 2026-10-26, 8 bytes a name.
// A September day is larger than an October one, by a factor the samples so
// far put between 1.7 and 2.8; no whole September day is measured yet. Every count
// of one day in its stat file is exact; the union counts are estimates, scaled
// by the observed ratio of each day's exact count to its sampled count (which
// is 2^sample_bits for a uniform hash), and result.json states the scale, the
// relative standard error and the expected hash collisions beside each one.
// With sample_bits 0 the union is exact up to hash collisions.
//
// The novelty curve gives, for each day in date order, the share of its names
// (and of its registrable domains) that no earlier day of the run holds, and
// the share the previous listed day also holds. The first day has no earlier
// day, so its share of new names is 1 by definition.
//
// The merge partitions the hash space into buckets; within a bucket each value
// carries its day index in its low bits, so one native sort orders the values
// and, for each value, the days that hold it, earliest first.
//
// Usage:
//   node scripts/measure/thc-union.mjs --in DIR --out RESULT.json [--listing LISTING.json]
//     reads every DAY.stat.json under DIR (any depth) with its DAY.names.f64 and DAY.regs.f64.
//     With --listing, the days must be exactly the listed days of their span, and the gaps are the
//     calendar days the listing does not hold.
// Exit codes: 0 merged; 1 the days do not agree (a missing, extra or repeated day, another list,
//   sample or block size, a hash file that does not match its stat); 2 could not run.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { checkSortedUnique, F64Error, readF64, sampleLimit } from './f64cmp.mjs';
import { RESULT_FORMAT, STAGES, STAT_FORMAT } from './thc-day.mjs';
import { gapsOf, ListingError, readListing } from './thc-list.mjs';

export class UnionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UnionError';
  }
}

// Every *.stat.json under dir, as { path, stat }, in day order.
export function findStats(dir) {
  const found = [];
  const walk = (at) => {
    for (const e of readdirSync(at, { withFileTypes: true })) {
      const full = join(at, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.stat.json')) found.push({ path: full, stat: JSON.parse(readFileSync(full, 'utf8')) });
    }
  };
  walk(dir);
  return found.sort((a, b) => (a.stat.day < b.stat.day ? -1 : a.stat.day > b.stat.day ? 1 : 0));
}

// arrays: one sorted duplicate-free Float64Array a day, in day order, every
// value below limit. Returns the distinct values of the union, and per day the
// values no earlier day holds (first) and the values the day before holds (previous).
export function mergeDays(arrays, limit) {
  const days = arrays.length;
  let mult = 2;
  while (mult < days) mult *= 2;
  let buckets = 256;
  while ((limit / buckets) * mult > 2 ** 53) buckets *= 2;
  const width = limit / buckets;
  const pos = new Array(days).fill(0);
  const ends = new Array(days).fill(0);
  const first = new Array(days).fill(0);
  const previous = new Array(days).fill(0);
  let distinct = 0;
  for (let b = 0; b < buckets; b++) {
    const lo = b * width;
    const hi = lo + width;
    let n = 0;
    for (let d = 0; d < days; d++) {
      const a = arrays[d];
      let p = pos[d];
      while (p < a.length && a[p] < hi) p += 1;
      ends[d] = p;
      n += p - pos[d];
    }
    if (n === 0) continue;
    const tmp = new Float64Array(n);
    let k = 0;
    for (let d = 0; d < days; d++) {
      const a = arrays[d];
      for (let p = pos[d]; p < ends[d]; p++) tmp[k++] = (a[p] - lo) * mult + d;
      pos[d] = ends[d];
    }
    tmp.sort();
    let lastV = -1;
    let lastD = -1;
    for (let i = 0; i < n; i++) {
      const v = Math.floor(tmp[i] / mult);
      const d = tmp[i] - v * mult;
      if (v !== lastV) {
        distinct += 1;
        first[d] += 1;
        lastV = v;
      } else if (d === lastD + 1) {
        previous[d] += 1;
      }
      lastD = d;
    }
  }
  for (let d = 0; d < days; d++) {
    if (pos[d] !== arrays[d].length) throw new UnionError(`day ${d} holds a value at or above the sample limit`);
  }
  return { distinct, first, previous };
}

// The union estimate from the sampled distinct count, scaled by the ratio of
// the exact to the sampled day counts. relative_standard_error is that of a
// count of a Bernoulli sample of the union at the observed rate,
// sqrt((1 - p) / sampled). expected_hash_collisions is the number of pairs of
// distinct keys expected to share a hash in the sample, scaled the same way: the
// union is undercounted by about that many.
export function estimate(sampledDistinct, exactSum, sampledSum, sampleBits, limit) {
  const scale = sampleBits === 0 || sampledSum === 0 ? 1 : exactSum / sampledSum;
  const p = 1 / scale;
  const rse = sampleBits === 0 || sampledDistinct === 0 ? 0 : Math.sqrt((1 - p) / sampledDistinct);
  const collisions = (sampledDistinct * sampledDistinct) / (2 * limit);
  return {
    value: Math.round(sampledDistinct * scale),
    sampled_distinct: sampledDistinct,
    scale: +scale.toFixed(6),
    nominal_scale: 2 ** sampleBits,
    relative_standard_error: +rse.toExponential(2),
    expected_hash_collisions: Math.round(collisions * scale),
  };
}

const ratio = (n, d) => (d === 0 ? null : +(n / d).toFixed(4));

function checkAgreement(stats) {
  const first = stats[0].stat;
  const seen = new Set();
  for (const { path, stat } of stats) {
    if (stat.format !== STAT_FORMAT) throw new UnionError(`${path}: format ${stat.format}`);
    if (seen.has(stat.day)) throw new UnionError(`${stat.day} appears twice`);
    seen.add(stat.day);
    if (stat.settings?.sample_bits !== first.settings?.sample_bits) throw new UnionError(`${stat.day}: sample bits ${stat.settings?.sample_bits}, ${first.day} has ${first.settings?.sample_bits}`);
    if (stat.settings?.per_block !== first.settings?.per_block) throw new UnionError(`${stat.day}: ${stat.settings?.per_block} names a block, ${first.day} has ${first.settings?.per_block}`);
    if (stat.psl?.sha256 !== first.psl?.sha256) throw new UnionError(`${stat.day}: another Public Suffix List than ${first.day}`);
    if (stat.verify?.ok !== true) throw new UnionError(`${stat.day}: the pack did not verify`);
  }
}

function checkListing(stats, listingPath) {
  const { days } = readListing(listingPath);
  const firstDay = stats[0].stat.day;
  const lastDay = stats[stats.length - 1].stat.day;
  const inSpan = days.filter((d) => d.day >= firstDay && d.day <= lastDay);
  const have = new Map(stats.map(({ stat }) => [stat.day, stat]));
  const missing = inSpan.filter((d) => !have.has(d.day)).map((d) => d.day);
  const extra = [...have.keys()].filter((day) => !inSpan.some((d) => d.day === day));
  if (missing.length > 0 || extra.length > 0)
    throw new UnionError(`the days are not the listed days of ${firstDay}..${lastDay}: missing ${missing.join(',') || 'none'}, not listed ${extra.join(',') || 'none'}`);
  for (const d of inSpan) {
    const listed = have.get(d.day).download?.listing_bytes;
    if (listed !== undefined && listed !== d.size) throw new UnionError(`${d.day}: measured a ${listed} B file, the listing says ${d.size}`);
  }
  return gapsOf(inSpan);
}

function loadSample(path, stat, kind, limit) {
  const meta = stat.files?.[kind];
  if (!meta) throw new UnionError(`${stat.day}: the stat names no ${kind} file`);
  const values = readF64(join(dirname(path), meta.file));
  if (values.length !== meta.count) throw new UnionError(`${meta.file}: ${values.length} values, the stat says ${meta.count}`);
  checkSortedUnique(values, limit, meta.file);
  return values;
}

function dayRow(stat) {
  const stages = {};
  const rss = {};
  for (const s of STAGES) {
    stages[s] = stat.stages?.[s]?.seconds ?? null;
    rss[s] = stat.stages?.[s]?.peak_rss_kib ?? null;
  }
  return {
    day: stat.day,
    source: stat.download?.source ?? (stat.download?.input ? 'local input' : null),
    download_mb_per_s: stat.download?.mb_per_s ?? null,
    gz_bytes: stat.counts.gz_bytes,
    lines: stat.counts.lines,
    distinct_names: stat.counts.names,
    distinct_registrable: stat.counts.distinct_registrable_icann,
    distinct_sites: stat.counts.distinct_sites_full_psl,
    pack_bytes: stat.pack.pack_bytes,
    bytes_per_name: stat.pack.bytes_per_name,
    wall_seconds: stat.wall_seconds,
    stages,
    stage_peak_rss_kib: rss,
    peak_rss_kib: stat.peak_rss_kib,
    runner_os: stat.runner?.os ?? null,
    verified: stat.verify?.ok === true,
  };
}

export function union(stats, { listing = null } = {}) {
  if (stats.length === 0) throw new UnionError('no stat file found');
  checkAgreement(stats);
  const gaps = listing === null ? gapsOf(stats.map(({ stat }) => ({ day: stat.day }))) : checkListing(stats, listing);
  const sampleBits = stats[0].stat.settings.sample_bits;
  const limit = sampleLimit(sampleBits);
  const n = stats.length;
  const sums = { names: 0, regs: 0, packBytes: 0 };
  for (const { stat } of stats) {
    sums.names += stat.counts.names;
    sums.regs += stat.counts.distinct_registrable_icann;
    sums.packBytes += stat.pack.pack_bytes;
  }
  const out = {};
  const curve = stats.map(({ stat }) => ({ day: stat.day, names: stat.counts.names, registrable: stat.counts.distinct_registrable_icann }));
  for (const [kind, exactOf, field] of [
    ['names', (s) => s.counts.names, 'names'],
    ['regs', (s) => s.counts.distinct_registrable_icann, 'registrable'],
  ]) {
    const arrays = stats.map(({ path, stat }) => loadSample(path, stat, kind, limit));
    const sampled = arrays.map((a) => a.length);
    const merged = mergeDays(arrays, limit);
    const exactSum = stats.reduce((a, { stat }) => a + exactOf(stat), 0);
    const sampledSum = sampled.reduce((a, b) => a + b, 0);
    const fractions = stats.map(({ stat }, d) => (exactOf(stat) === 0 ? null : sampled[d] / exactOf(stat))).filter((x) => x !== null);
    out[field] = {
      ...estimate(merged.distinct, exactSum, sampledSum, sampleBits, limit),
      sample_fraction_min: +Math.min(...fractions).toFixed(6),
      sample_fraction_max: +Math.max(...fractions).toFixed(6),
    };
    for (let d = 0; d < n; d++) {
      curve[d][`sampled_${field}`] = sampled[d];
      curve[d][`share_new_${field}`] = ratio(merged.first[d], sampled[d]);
      curve[d][`share_${field}_in_previous_day`] = d === 0 ? null : ratio(merged.previous[d], sampled[d]);
    }
  }
  const perDay = stats.map(({ stat }) => dayRow(stat));
  const slowest = perDay.reduce((a, b) => (b.wall_seconds > a.wall_seconds ? b : a));
  const runners = [
    ...new Set(
      stats.map(({ stat }) =>
        JSON.stringify({
          os: stat.runner?.os ?? null,
          arch: stat.runner?.arch ?? null,
          image: stat.runner?.image ?? null,
          image_version: stat.runner?.image_version ?? null,
          cpus: stat.runner?.cpus,
          mem_bytes: stat.runner?.mem_bytes,
        }),
      ),
    ),
  ].map((s) => JSON.parse(s));
  return {
    format: RESULT_FORMAT,
    entry: 'DOM-009',
    created: new Date().toISOString(),
    span: { first: stats[0].stat.day, last: stats[n - 1].stat.day, days: n, gaps, listing_checked: listing !== null },
    settings: { sample_bits: sampleBits, per_block: stats[0].stat.settings.per_block, psl_sha256: stats[0].stat.psl.sha256 },
    runners,
    [`distinct_names_${n}d`]: out.names.value,
    [`distinct_registrable_${n}d`]: out.registrable.value,
    estimate: { method: sampleBits === 0 ? 'every hash' : `hash sample, 1 in ${2 ** sampleBits}, scaled by the exact day counts`, names: out.names, registrable: out.registrable },
    sum_daily_names: sums.names,
    sum_daily_registrable: sums.regs,
    bytes_per_name: sums.names === 0 ? 0 : +(sums.packBytes / sums.names).toFixed(3),
    slowest_day: { day: slowest.day, wall_seconds: slowest.wall_seconds },
    novelty_curve: curve,
    per_day: perDay,
  };
}

function main(argv) {
  const args = parseArgs(argv);
  if (typeof args.in !== 'string' || typeof args.out !== 'string') {
    console.error('usage: node scripts/measure/thc-union.mjs --in DIR --out RESULT.json [--listing LISTING.json]');
    return 2;
  }
  let result;
  try {
    result = union(findStats(args.in), { listing: typeof args.listing === 'string' ? args.listing : null });
  } catch (err) {
    console.error(`thc-union: ${err.message}`);
    return err instanceof UnionError || err instanceof F64Error || err instanceof ListingError ? 1 : 2;
  }
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(result, null, 1) + '\n');
  const n = result.span.days;
  console.log(
    `days=${n} gaps=${result.span.gaps.join(',') || 'none'} distinct_names_${n}d=${result[`distinct_names_${n}d`]} distinct_registrable_${n}d=${result[`distinct_registrable_${n}d`]} bytes_per_name=${result.bytes_per_name} slowest=${result.slowest_day.day}:${result.slowest_day.wall_seconds}s`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
