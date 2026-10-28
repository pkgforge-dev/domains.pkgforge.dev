// scripts/measure/range-load.mjs — Range reads of a GHCR blob made by the probe
// Worker's /range route, under an open-loop load or one at a time (DOM-007,
// TODO/storage.md). The route is probes/worker/src/range.ts.
//
// Usage:
//   node scripts/measure/range-load.mjs --url "$PROBE_URL/range" --rps 100 --seconds 60 --mode cold --expect 206 [--out FILE]
//   node scripts/measure/range-load.mjs --url "$PROBE_URL/range" --rps 50 --seconds 60 --mode warm --expect 206
//   node scripts/measure/range-load.mjs --url "$PROBE_URL/range" --mode single [--count 30] [--sizes 1024,25600,65536,1048576]
//   node scripts/measure/range-load.mjs --merge DIR [--out docs/research/measure/DOM-007/result.json]
//
// Options: --repo (default pkgforge-dev/domains.pkgforge.dev/probe); --tag (default
// size-1536m, or a manifest digest); --length (cold and warm, default 25600 B);
// --cache (cold: none, signed or block, default none; warm is always block);
// --blocks (warm, default 50); --timeout-ms (each request, default 30000);
// --seed (the offsets' generator, default random, recorded); --place (where it
// ran: a label such as operator or runner, default local); --out (the result file).
//
// The pin: the tag moves (DOM-006 pushes new bytes to probe:size-1536m on every
// dispatch), so the first request reads 1 byte by the tag and every request of
// the run names the manifest digest it answered. The pin is not counted.
//
// cold: open loop. Request i starts at t0 + i * 1000 / rps ms, whatever the earlier
//   ones are doing, and asks a block of --length bytes never asked before in the
//   run: a block index drawn without repetition from the seed.
// warm: open loop over --blocks fixed blocks, block k at offset k * length, with
//   cache=block. Each block is read once before the clock starts (the prefill,
//   not counted), so the timed requests can find it in the Worker's cache.
// single: for each size of --sizes, --count reads one at a time with cache=none,
//   each a new random block (cold); then one prefill read and --count reads of
//   one fixed block with cache=block (warm).
//
// An answer is classified by the read's `status` in the route's JSON when the
// Worker answered 200 with JSON, else by the Worker's own HTTP status: `expected`
// (ok and --expect), 429, 5xx, or other (any other status, a step that timed out,
// a client timeout or a failed connection). Latency is the client's: from the
// start of the request to the last byte of the answer, over every request,
// failed ones included. A percentile is the value at index floor(n * q) of the
// ascending list: quantile() of probes/worker/src/gaps.ts, DOM-001's definition.
//
// The verdict of cold and warm is PASS when every criterion passes:
//   p95-under-<N>ms     p95 latency under 3,000 ms (cold) or 300 ms (warm): the entry's Prove
//   no-429              no answer of status 429: the entry's Prove
//   5xx-at-most-1pct    at most 1% of answers 5xx: the entry's Prove
//   other-at-most-1pct  at most 1% of answers other: this script's rule, so a run
//                       of 404s or timeouts cannot pass on its latency alone
//   warm-reads-cached   (warm) more than half of the expected answers came from the
//                       block cache: this script's rule, else the run timed GHCR,
//                       not the cache
// single is PASS when every read answered --expect.
//
// stdout: the table, one criterion a line, then PASS or FAIL. --out: the result,
// schema domains.measure.range-load.v1. The host of a *.workers.dev URL is
// written as WORKER.ACCOUNT.workers.dev: the account's subdomain stays out of
// every output (docs/security/secrets.md).
//
// --merge DIR reads every .json file of DIR, each a result of this script (any
// other file there is refused, and so is one whose verdict does not follow from
// its own criteria), and prints one Markdown table of the load runs and one of
// the single reads, by place, mode and rate: the table the entry puts in
// docs/architecture.md section 4.3. Every place in DIR must hold the whole
// plan (PLAN: the single reads, and cold and warm at 20, 50 and 100 requests a
// second), else the merge is refused and nothing is written. --out writes them
// as one result, schema domains.measure.range-load.result.v1, which names every
// manifest digest the runs read (`refs`) and every place (`places`). PASS when
// every run passed.
//
// Exit codes: 0 PASS · 1 FAIL (the finding; --out is written) · 2 could not run
// (usage, the pin read did not answer 200 with a read of --expect, a --merge
// file that is not a result of this script or whose verdict does not follow
// from its criteria, or a place whose plan is not whole).
import { randomInt } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { quantile } from '../../probes/worker/src/gaps.ts';
import { DEFAULT_REPO, LIMITS } from '../../probes/worker/src/range.ts';
import { parseArgs } from '../lib/args.mjs';

export const SCHEMA = 'domains.measure.range-load.v1';
export const RESULT_SCHEMA = 'domains.measure.range-load.result.v1';
export const DEFAULT_TAG = 'size-1536m';
export const P95_LIMIT_MS = Object.freeze({ cold: 3000, warm: 300 });
// The entry's sizes, read as binary: 1 KiB, 25 KiB, 64 KiB and 1 MiB.
export const SINGLE_SIZES = Object.freeze([1024, 25600, 65536, 1048576]);
const PREFILL_CONCURRENCY = 5;
const SAMPLES = 10;
const USAGE =
  'usage: node scripts/measure/range-load.mjs --url <probe>/range --mode cold|warm --rps N [--seconds 60] [--expect 206] [--repo R] [--tag T] [--length B] [--cache none|signed|block] [--blocks 50] [--timeout-ms 30000] [--seed N] [--place P] [--out FILE]\n' +
  '       node scripts/measure/range-load.mjs --url <probe>/range --mode single [--count 30] [--sizes 1024,25600,65536,1048576] [--expect 206] [--repo R] [--tag T] [--out FILE]\n' +
  '       node scripts/measure/range-load.mjs --merge DIR [--out FILE]';

export const DEFINITIONS = Object.freeze({
  latency_ms: 'the client: from the start of a request to the last byte of its answer, over every request of the run, failed ones included',
  worker_ms: "the route's own total_ms: from its first step to its answer",
  classes:
    "expected: the Worker answered 200 with JSON whose ok is true and whose status is --expect; 429 and 5xx: the read's status, or the Worker's own when it did not answer JSON 200; other: anything else, a step that timed out, a client timeout or a failed connection",
  quantiles: 'the value at index floor(n * q) of the ascending list (probes/worker/src/gaps.ts quantile)',
  open_loop: 'request i starts at t0 + i * 1000 / rps ms, whatever the earlier ones are doing; client_lag_ms is how late the client started it',
  cold: 'each request asks a block of --length bytes never asked before in the run',
  warm: 'block k of --blocks at offset k * length, cache=block, each read once before the clock starts',
});

export class UsageError extends Error {}

const DIGEST = /^sha256:[0-9a-f]{64}$/;

function intFlag(a, name, min, max, fallback) {
  const v = a[name];
  if (v === undefined) return fallback;
  if (v === true) throw new UsageError(`--${name} needs a value`);
  const n = /^\d{1,16}$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

// The flags, checked. Throws UsageError.
export function parseFlags(argv) {
  const a = parseArgs(argv);
  if (a._.length > 0) throw new UsageError(`unexpected argument ${a._[0]}`);
  const known = ['url', 'mode', 'rps', 'seconds', 'expect', 'repo', 'tag', 'length', 'cache', 'blocks', 'count', 'sizes', 'timeout-ms', 'seed', 'place', 'out', 'merge'];
  for (const k of Object.keys(a)) if (k !== '_' && !known.includes(k)) throw new UsageError(`unknown flag --${k}`);
  for (const k of ['url', 'mode', 'repo', 'tag', 'cache', 'sizes', 'place', 'out', 'merge']) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a.merge !== undefined) {
    const extra = Object.keys(a).filter((k) => !['_', 'merge', 'out'].includes(k));
    if (extra.length > 0) throw new UsageError(`--merge takes --out only, not --${extra[0]}`);
    return { merge: a.merge, out: a.out };
  }
  if (typeof a.url !== 'string') throw new UsageError('--url is required: the probe Worker /range URL');
  let url;
  try {
    url = new URL(a.url);
  } catch {
    throw new UsageError('--url is not a URL');
  }
  if (!/^https?:$/.test(url.protocol) || !url.pathname.endsWith('/range')) throw new UsageError('--url must be an http or https URL ending in /range');
  const mode = a.mode;
  if (!['cold', 'warm', 'single'].includes(mode)) throw new UsageError('--mode must be cold, warm or single');
  const tag = a.tag ?? DEFAULT_TAG;
  if (!/^(?:[a-z0-9_][a-z0-9._-]{0,127}|sha256:[0-9a-f]{64})$/.test(tag)) throw new UsageError('--tag must be a lowercase tag or a manifest digest sha256:<64 hex>');
  const repo = a.repo ?? DEFAULT_REPO;
  const place = a.place ?? 'local';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(place)) throw new UsageError('--place is a short lowercase label, such as operator or runner');
  const flags = {
    url: url.href,
    mode,
    repo,
    tag,
    place,
    expect: intFlag(a, 'expect', 100, 599, 206),
    timeoutMs: intFlag(a, 'timeout-ms', 1000, 120000, 30000),
    seed: intFlag(a, 'seed', 0, 2 ** 31 - 1, randomInt(2 ** 31)),
    out: a.out,
  };
  if (mode === 'single') {
    for (const k of ['rps', 'seconds', 'length', 'cache', 'blocks']) if (a[k] !== undefined) throw new UsageError(`--${k} is not a flag of --mode single`);
    const sizes = (a.sizes ?? SINGLE_SIZES.join(',')).split(',').map((s) => (/^\d{1,7}$/.test(s) ? Number(s) : Number.NaN));
    if (sizes.length === 0 || sizes.some((s) => !Number.isSafeInteger(s) || s < 1 || s > LIMITS.max_length))
      throw new UsageError(`--sizes is a comma list of byte counts from 1 to ${LIMITS.max_length}`);
    return { ...flags, sizes, count: intFlag(a, 'count', 1, 1000, 30) };
  }
  for (const k of ['count', 'sizes']) if (a[k] !== undefined) throw new UsageError(`--${k} is a flag of --mode single`);
  if (a.rps === undefined) throw new UsageError('--rps is required for --mode cold and warm');
  const cache = a.cache ?? (mode === 'warm' ? 'block' : 'none');
  if (mode === 'warm' && cache !== 'block') throw new UsageError('--mode warm reads with --cache block');
  if (!['none', 'signed', 'block'].includes(cache)) throw new UsageError('--cache must be none, signed or block');
  if (mode === 'cold' && a.blocks !== undefined) throw new UsageError('--blocks is a flag of --mode warm');
  return {
    ...flags,
    rps: intFlag(a, 'rps', 1, 500, 0),
    seconds: intFlag(a, 'seconds', 1, 600, 60),
    length: intFlag(a, 'length', 1, LIMITS.max_length, 25600),
    cache,
    blocks: intFlag(a, 'blocks', 1, 10000, 50),
  };
}

// A *.workers.dev host without the account's subdomain: WORKER.ACCOUNT.workers.dev.
export function redactHost(host) {
  const labels = host.toLowerCase().split('.');
  if (labels.length >= 4 && labels.at(-1) === 'dev' && labels.at(-2) === 'workers') return [labels[0], 'ACCOUNT', ...labels.slice(-2)].join('.');
  return host.toLowerCase();
}

// The /range URL of one read; any query of the base is replaced.
export function readUrl(base, { repo, ref, offset, length, cache }) {
  const u = new URL(base);
  u.search = '';
  for (const [k, v] of Object.entries({ repo, tag: ref, offset, length, cache })) u.searchParams.set(k, String(v));
  return u.href;
}

// A seeded generator of floats in [0, 1) (mulberry32): the run's offsets are reproducible from its seed.
export function mulberry32(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// `count` distinct block indices below `blocks`. Refuses a count over half of
// the blocks, where drawing without repetition stops being cheap.
export function distinctBlocks(rand, count, blocks) {
  if (count * 2 > blocks) throw new UsageError(`${count} distinct blocks of ${blocks} in the layer: lower --rps or --seconds, or --length`);
  const seen = new Set();
  const out = [];
  while (out.length < count) {
    const k = Math.floor(rand() * blocks);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

// One request to the Worker. Never rejects: a failure is in the record.
export async function getAnswer(url, timeoutMs) {
  const started = performance.now();
  try {
    // The Worker never redirects: a 3xx fails here and counts as other, and
    // nothing is followed to another host.
    const res = await fetch(url, { headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    return { http: res.status, body, ms: performance.now() - started, client: null };
  } catch (err) {
    return { http: null, body: null, ms: performance.now() - started, client: err?.name === 'TimeoutError' ? 'client-timeout' : `client-error ${err?.cause?.code ?? err?.name ?? 'Error'}` };
  }
}

const isAnswer = (a) => a.http === 200 && a.body !== null && typeof a.body === 'object' && !Array.isArray(a.body) && a.body.v === 1;

// The class of one answer, and the key it is counted under in by_status.
export function classify(a, expect) {
  if (a.client !== null) return { cls: 'other', key: a.client };
  if (!isAnswer(a)) {
    const key = `worker-${a.http}${a.http === 200 ? '-not-an-answer' : ''}`;
    if (a.http === 429) return { cls: '429', key };
    if (a.http >= 500 && a.http <= 599) return { cls: '5xx', key };
    return { cls: 'other', key };
  }
  const { ok, status, failed_at: at, error } = a.body;
  if (ok === true && status === expect) return { cls: 'expected', key: String(status) };
  if (status === 429) return { cls: '429', key: `429@${at}` };
  if (Number.isInteger(status) && status >= 500 && status <= 599) return { cls: '5xx', key: `${status}@${at}` };
  if (status === null || status === undefined) return { cls: 'other', key: `${error === 'timeout' ? 'timeout' : 'error'}@${at}` };
  return { cls: 'other', key: `${status}@${at ?? 'end'}${ok === true ? '' : '-refused'}` };
}

// The record of one request, kept by the summary.
function recordOf(i, offset, lag, a, expect) {
  const { cls, key } = classify(a, expect);
  const body = isAnswer(a) ? a.body : null;
  return {
    i,
    offset,
    lag,
    ms: a.ms,
    cls,
    key,
    error: body?.error ?? null,
    subrequests: Number.isInteger(body?.subrequests) ? body.subrequests : null,
    worker_ms: Number.isFinite(body?.total_ms) ? body.total_ms : null,
    colo: typeof body?.colo === 'string' ? body.colo : null,
    cache: body?.cache && typeof body.cache === 'object' ? { manifest: body.cache.manifest, signed: body.cache.signed, block: body.cache.block } : {},
  };
}

const r0 = (v) => (v === null ? null : Math.round(v));

function spread(values) {
  const max = values.length === 0 ? null : Math.max(...values);
  return { n: values.length, p50: r0(quantile(values, 0.5)), p95: r0(quantile(values, 0.95)), max: r0(max) };
}

// The counts and spreads of a list of records.
export function summarize(records) {
  const counts = { requests: records.length, expected: 0, 429: 0, '5xx': 0, other: 0 };
  const byStatus = {};
  const colos = {};
  const cache = {};
  for (const r of records) {
    counts[r.cls] += 1;
    byStatus[r.key] = (byStatus[r.key] ?? 0) + 1;
    if (r.colo !== null) colos[r.colo] = (colos[r.colo] ?? 0) + 1;
    for (const [kind, state] of Object.entries(r.cache)) {
      if (state === undefined) continue;
      cache[kind] ??= { hit: 0, miss: 0, error: 0 };
      if (state in cache[kind]) cache[kind][state] += 1;
    }
  }
  const subs = records.flatMap((r) => (r.subrequests === null ? [] : [r.subrequests]));
  return {
    counts,
    by_status: byStatus,
    latency_ms: spread(records.map((r) => r.ms)),
    worker_ms: spread(records.flatMap((r) => (r.worker_ms === null ? [] : [r.worker_ms]))),
    subrequests: {
      n: subs.length,
      p50: quantile(subs, 0.5),
      max: subs.length === 0 ? null : Math.max(...subs),
      mean: subs.length === 0 ? null : Math.round((subs.reduce((s, v) => s + v, 0) / subs.length) * 100) / 100,
    },
    cache,
    colos,
    client_lag_ms: spread(records.flatMap((r) => (r.lag === null ? [] : [r.lag]))),
    block_hits_expected: records.filter((r) => r.cls === 'expected' && r.cache.block === 'hit').length,
    samples: records
      .filter((r) => r.cls !== 'expected')
      .slice(0, SAMPLES)
      .map((r) => ({ i: r.i, offset: r.offset, key: r.key, error: r.error })),
  };
}

// The criteria of a cold or warm run.
export function judge(summary, mode) {
  const c = summary.counts;
  const n = c.requests;
  const limit = P95_LIMIT_MS[mode];
  const p95 = summary.latency_ms.p95;
  const criteria = [
    { name: 'requests', pass: n > 0, detail: `${n} requests answered or failed` },
    { name: `p95-under-${limit}ms`, pass: p95 !== null && p95 < limit, detail: `p95 ${p95} ms` },
    { name: 'no-429', pass: c[429] === 0, detail: `${c[429]} of ${n}` },
    { name: '5xx-at-most-1pct', pass: c['5xx'] * 100 <= n, detail: `${c['5xx']} of ${n}` },
    { name: 'other-at-most-1pct', pass: c.other * 100 <= n, detail: `${c.other} of ${n}` },
  ];
  if (mode === 'warm')
    criteria.push({ name: 'warm-reads-cached', pass: summary.block_hits_expected * 2 > c.expected, detail: `${summary.block_hits_expected} of ${c.expected} expected answers from the block cache` });
  return criteria;
}

// Reads 1 byte by the tag, and returns the manifest digest and layer it named. Throws on anything else.
export async function pin(flags) {
  const url = readUrl(flags.url, { repo: flags.repo, ref: flags.tag, offset: 0, length: 1, cache: 'none' });
  const a = await getAnswer(url, flags.timeoutMs);
  const { cls, key } = classify(a, flags.expect);
  if (cls !== 'expected') throw new Error(`the pin read of ${flags.repo}:${flags.tag} answered ${key}${a.body?.error ? `: ${a.body.error}` : ''}`);
  const digest = a.body.manifest?.digest;
  const layer = a.body.layer;
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new Error('the pin read named no manifest digest');
  if (DIGEST.test(flags.tag) && digest !== flags.tag) throw new Error(`the pin read of ${flags.tag} answered the manifest ${digest}`);
  if (!layer || typeof layer.digest !== 'string' || !DIGEST.test(layer.digest) || !Number.isSafeInteger(layer.size) || layer.size < 1)
    throw new Error('the pin read named no layer with a digest and a size');
  return { tag: flags.tag, digest, layer: { digest: layer.digest, size: layer.size, title: layer.title ?? null }, colo: a.body.colo ?? null, at: new Date().toISOString() };
}

// Starts fire(i) at t0 + i * 1000 / rps ms for `count` requests, never waiting for
// an earlier one, and resolves to every record once all have ended.
export async function openLoop(count, rps, fire) {
  const interval = 1000 / rps;
  const t0 = performance.now() + 20;
  const pending = [];
  for (let i = 0; i < count; i += 1) {
    const at = t0 + i * interval;
    const wait = at - performance.now();
    if (wait > 1) await delay(wait);
    pending.push(fire(i, Math.max(0, performance.now() - at)));
  }
  return Promise.all(pending);
}

// Runs `fn` over `items` with at most `limit` at a time.
async function pooled(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const at = next;
      next += 1;
      out[at] = await fn(items[at], at);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

async function loadRun(flags, pinned) {
  const { rps, seconds, length, cache, blocks } = flags;
  const count = rps * seconds;
  const layerBlocks = Math.floor(pinned.layer.size / length);
  const rand = mulberry32(flags.seed);
  const read = (offset) => readUrl(flags.url, { repo: flags.repo, ref: pinned.digest, offset, length, cache });
  let offsets;
  let prefill = null;
  if (flags.mode === 'cold') {
    offsets = distinctBlocks(rand, count, layerBlocks).map((k) => k * length);
  } else {
    if (blocks > layerBlocks) throw new UsageError(`--blocks ${blocks} of ${length} B pass the layer's ${pinned.layer.size} B`);
    const fixed = Array.from({ length: blocks }, (_, k) => k * length);
    offsets = Array.from({ length: count }, (_, i) => fixed[i % blocks]);
    const filled = await pooled(fixed, PREFILL_CONCURRENCY, async (offset) => classify(await getAnswer(read(offset), flags.timeoutMs), flags.expect));
    prefill = { requests: fixed.length, expected: filled.filter((c) => c.cls === 'expected').length };
  }
  const records = await openLoop(count, rps, async (i, lag) => recordOf(i, offsets[i], lag, await getAnswer(read(offsets[i]), flags.timeoutMs), flags.expect));
  return { records, prefill };
}

async function singleRun(flags, pinned) {
  const rand = mulberry32(flags.seed);
  const rows = [];
  const all = [];
  for (const size of flags.sizes) {
    const layerBlocks = Math.floor(pinned.layer.size / size);
    const read = (offset, cache) => readUrl(flags.url, { repo: flags.repo, ref: pinned.digest, offset, length: size, cache });
    const cold = [];
    for (const [i, k] of distinctBlocks(rand, flags.count, layerBlocks).entries()) cold.push(recordOf(i, k * size, null, await getAnswer(read(k * size, 'none'), flags.timeoutMs), flags.expect));
    // The warm block is the layer's first; the prefill read stores it and is not counted.
    const prefill = classify(await getAnswer(read(0, 'block'), flags.timeoutMs), flags.expect);
    const warm = [];
    for (let i = 0; i < flags.count; i += 1) warm.push(recordOf(i, 0, null, await getAnswer(read(0, 'block'), flags.timeoutMs), flags.expect));
    rows.push({ size, kind: 'cold', cache: 'none', ...summarize(cold) });
    rows.push({ size, kind: 'warm', cache: 'block', prefill: prefill.key, ...summarize(warm) });
    all.push(...cold, ...warm);
  }
  return { rows, all };
}

const cell = (v) => (v === null || v === undefined ? '-' : String(v));

function cacheLine(cache) {
  const kinds = Object.entries(cache);
  if (kinds.length === 0) return 'none read';
  return kinds.map(([kind, s]) => `${kind} hit ${s.hit} miss ${s.miss} error ${s.error}`).join(' · ');
}

export function loadTable(result) {
  const { run, target, summary: s } = result;
  const byStatus = Object.entries(s.by_status)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  const colos = Object.entries(s.colos)
    .map(([k, v]) => `${k}:${v}`)
    .join(' ');
  return [
    `range-load mode=${run.mode} place=${run.place} rps=${run.rps} seconds=${run.seconds} cache=${run.cache} length=${run.length} expect=${run.expect} seed=${run.seed}`,
    `target       ${target.host}${target.path} repo=${target.repo} ref=${target.ref} (tag ${target.tag}) layer=${target.layer.digest} ${target.layer.size} B`,
    `requests     ${s.counts.requests}  ${run.expect} ${s.counts.expected}  429 ${s.counts[429]}  5xx ${s.counts['5xx']}  other ${s.counts.other}`,
    `by_status    ${byStatus || '-'}`,
    `latency_ms   p50 ${cell(s.latency_ms.p50)}  p95 ${cell(s.latency_ms.p95)}  max ${cell(s.latency_ms.max)}  (client: request start to last byte)`,
    `worker_ms    p50 ${cell(s.worker_ms.p50)}  p95 ${cell(s.worker_ms.p95)}  max ${cell(s.worker_ms.max)}  (the route's total_ms)`,
    `subrequests  p50 ${cell(s.subrequests.p50)}  max ${cell(s.subrequests.max)}  mean ${cell(s.subrequests.mean)}`,
    `cache        ${cacheLine(s.cache)}`,
    `colos        ${colos || '-'}`,
    `client_lag   p95 ${cell(s.client_lag_ms.p95)} ms  max ${cell(s.client_lag_ms.max)} ms`,
    ...(result.prefill ? [`prefill      ${result.prefill.expected} of ${result.prefill.requests} blocks read before the clock`] : []),
  ].join('\n');
}

export function singleTable(result) {
  const head = `range-load mode=single place=${result.run.place} count=${result.run.count} expect=${result.run.expect} seed=${result.run.seed}\ntarget       ${result.target.host}${result.target.path} repo=${result.target.repo} ref=${result.target.ref} (tag ${result.target.tag})`;
  const cols = 'size_B     kind  n    ok   p50_ms  p95_ms  max_ms  worker_p50  block_hits';
  const lines = result.rows.map((r) =>
    [
      String(r.size).padEnd(10),
      r.kind.padEnd(5),
      String(r.counts.requests).padEnd(4),
      String(r.counts.expected).padEnd(4),
      cell(r.latency_ms.p50).padEnd(7),
      cell(r.latency_ms.p95).padEnd(7),
      cell(r.latency_ms.max).padEnd(7),
      cell(r.worker_ms.p50).padEnd(11),
      r.cache.block ? String(r.cache.block.hit) : '-',
    ].join(' '),
  );
  return [head, cols, ...lines].join('\n');
}

const PLACE_ORDER = (a, b) => a.place.localeCompare(b.place) || a.mode.localeCompare(b.mode) || a.rps - b.rps;

// The runs each place of a merge must hold: the entry's Approach (DOM-007).
export const PLAN = Object.freeze(['single', ...['cold', 'warm'].flatMap((mode) => [20, 50, 100].map((rps) => `${mode} ${rps}`))]);

// The run files of `dir` as one result. Every .json file there must be a result
// of this script: anything else is refused, so a stray file never joins the record.
export function mergeRuns(dir) {
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  if (files.length === 0) throw new Error(`${dir} holds no .json result`);
  const runs = [];
  const singles = [];
  const layers = new Map();
  for (const file of files) {
    let r;
    try {
      r = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    } catch {
      throw new Error(`${file} is not JSON`);
    }
    if (r?.schema !== SCHEMA) throw new Error(`${file} is not a result of this script (schema ${JSON.stringify(r?.schema ?? null)}, not ${SCHEMA})`);
    if (r.verdict !== 'PASS' && r.verdict !== 'FAIL') throw new Error(`${file} carries no verdict`);
    if (!Array.isArray(r.criteria) || r.criteria.length === 0) throw new Error(`${file} carries no criteria`);
    const own = r.criteria.every((c) => c.pass === true) ? 'PASS' : 'FAIL';
    if (own !== r.verdict) throw new Error(`${file} says ${r.verdict}, its criteria say ${own}`);
    layers.set(r.target.ref, r.target.layer);
    const head = { file, place: r.run.place, ref: r.target.ref, started_at: r.started_at, verdict: r.verdict, failed: r.criteria.filter((c) => !c.pass).map((c) => c.name) };
    if (r.run.mode === 'single') {
      const rows = r.rows.map((row) => ({
        size: row.size,
        kind: row.kind,
        requests: row.counts.requests,
        expected: row.counts.expected,
        latency_ms: row.latency_ms,
        worker_ms: row.worker_ms,
        block_hits: row.cache.block?.hit ?? null,
      }));
      singles.push({ ...head, mode: 'single', rps: 0, rows });
    } else {
      const s = r.summary;
      runs.push({
        ...head,
        mode: r.run.mode,
        rps: r.run.rps,
        seconds: r.run.seconds,
        cache: r.run.cache,
        length: r.run.length,
        counts: s.counts,
        latency_ms: s.latency_ms,
        worker_ms: s.worker_ms,
        subrequests: s.subrequests,
        colos: s.colos,
      });
    }
  }
  runs.sort(PLACE_ORDER);
  singles.sort(PLACE_ORDER);
  const all = [...runs, ...singles];
  const places = [...new Set(all.map((x) => x.place))].sort();
  const missing = places.flatMap((place) => {
    const held = new Set(all.filter((x) => x.place === place).map((x) => (x.mode === 'single' ? 'single' : `${x.mode} ${x.rps}`)));
    return PLAN.filter((k) => !held.has(k)).map((k) => `${place} ${k}`);
  });
  if (missing.length > 0) throw new Error(`the plan is not whole; missing: ${missing.join(', ')}`);
  return {
    schema: RESULT_SCHEMA,
    entry: 'DOM-007',
    places,
    refs: [...layers.entries()].map(([ref, layer]) => ({ ref, layer })),
    runs,
    singles,
    verdict: all.every((x) => x.verdict === 'PASS') ? 'PASS' : 'FAIL',
    definitions: DEFINITIONS,
  };
}

// The merged result as two Markdown tables.
export function mergeTable(m) {
  const lines = [
    '| place | mode | rps | requests | expected | 429 | 5xx | other | p50 ms | p95 ms | max ms | worker p50 ms | subrequests p50 | verdict |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
    ...m.runs.map((r) =>
      [
        r.place,
        r.mode,
        r.rps,
        r.counts.requests,
        r.counts.expected,
        r.counts[429],
        r.counts['5xx'],
        r.counts.other,
        cell(r.latency_ms.p50),
        cell(r.latency_ms.p95),
        cell(r.latency_ms.max),
        cell(r.worker_ms.p50),
        cell(r.subrequests.p50),
        r.verdict,
      ].join(' | '),
    ),
  ].map((row, i) => (i < 2 ? row : `| ${row} |`));
  if (m.singles.length > 0) {
    lines.push('', '| place | size B | kind | n | expected | p50 ms | p95 ms | max ms | worker p50 ms | block hits |', '| --- | ---: | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
    for (const s of m.singles) {
      for (const r of s.rows)
        lines.push(
          `| ${[s.place, r.size, r.kind, r.requests, r.expected, cell(r.latency_ms.p50), cell(r.latency_ms.p95), cell(r.latency_ms.max), cell(r.worker_ms.p50), cell(r.block_hits)].join(' | ')} |`,
        );
    }
  }
  lines.push('', `refs: ${m.refs.map((x) => `${x.ref} (layer ${x.layer.digest}, ${x.layer.size} B)`).join('; ')}`);
  if (m.refs.length > 1) lines.push(`NOTE the runs read ${m.refs.length} manifests, so not one blob`);
  return lines.join('\n');
}

function mergeMain(flags, stdout, stderr) {
  let merged;
  try {
    merged = mergeRuns(resolve(flags.merge));
  } catch (err) {
    stderr.write(`range-load: could not merge: ${err.message}\n`);
    return 2;
  }
  stdout.write(`${mergeTable(merged)}\n${merged.verdict}\n`);
  if (flags.out) {
    writeAtomic(resolve(flags.out), `${JSON.stringify(merged, null, 2)}\n`);
    stderr.write(`range-load: wrote ${flags.out}\n`);
  }
  return merged.verdict === 'PASS' ? 0 : 1;
}

// Writes through a temporary file in the same directory, so a killed process leaves the old file whole.
function writeAtomic(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`range-load: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  if (flags.merge !== undefined) return mergeMain(flags, stdout, stderr);
  const startedAt = new Date().toISOString();
  let pinned;
  let measured;
  try {
    pinned = await pin(flags);
    measured = flags.mode === 'single' ? await singleRun(flags, pinned) : await loadRun(flags, pinned);
  } catch (err) {
    stderr.write(`range-load: could not run: ${err.message}\n`);
    return 2;
  }
  const u = new URL(flags.url);
  const target = { host: redactHost(u.host), path: u.pathname, repo: flags.repo, tag: flags.tag, ref: pinned.digest, layer: pinned.layer };
  const base = { schema: SCHEMA, entry: 'DOM-007', started_at: startedAt, ended_at: new Date().toISOString(), target, pin: pinned, definitions: DEFINITIONS };
  let result;
  let table;
  if (flags.mode === 'single') {
    const criteria = [{ name: 'all-expected', pass: measured.all.every((r) => r.cls === 'expected'), detail: `${measured.all.filter((r) => r.cls === 'expected').length} of ${measured.all.length}` }];
    result = {
      ...base,
      run: { mode: 'single', place: flags.place, count: flags.count, sizes: flags.sizes, expect: flags.expect, seed: flags.seed, timeout_ms: flags.timeoutMs },
      rows: measured.rows,
      criteria,
    };
    table = singleTable(result);
  } else {
    const summary = summarize(measured.records);
    const run = {
      mode: flags.mode,
      place: flags.place,
      rps: flags.rps,
      seconds: flags.seconds,
      cache: flags.cache,
      length: flags.length,
      expect: flags.expect,
      seed: flags.seed,
      timeout_ms: flags.timeoutMs,
    };
    if (flags.mode === 'warm') run.blocks = flags.blocks;
    result = { ...base, run, prefill: measured.prefill, summary, criteria: judge(summary, flags.mode) };
    table = loadTable(result);
  }
  result.verdict = result.criteria.every((c) => c.pass) ? 'PASS' : 'FAIL';
  stdout.write(`${table}\n${result.criteria.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}  ${c.detail}`).join('\n')}\n${result.verdict}\n`);
  if (flags.out) {
    writeAtomic(resolve(flags.out), `${JSON.stringify(result, null, 2)}\n`);
    stderr.write(`range-load: wrote ${flags.out}\n`);
  }
  return result.verdict === 'PASS' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
