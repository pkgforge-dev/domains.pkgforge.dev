// scripts/measure/edge-load.mjs — an open-loop load of one URL of the Worker,
// that counts each answer by its status and by who wrote it: the Worker of
// apps/api, or Cloudflare's edge in its place (DOM-062, TODO/serve.md).
//
// Question: does anything in front of the Worker (a rate-limit rule, a WAF
// rule, Bot Fight Mode, a challenge) refuse or challenge a scripted caller at
// this rate? A gate of any kind gates consumers (AGENTS.md absolute 8).
//
// Usage:
//   node scripts/measure/edge-load.mjs --url https://domains.pkgforge.dev/healthz --rps 100 --seconds 60 --expect 200 [--prefill 5] [--doh https://cloudflare-dns.com/dns-query] [--family 4|6] [--h2] [--timeout-ms 30000] [--place local] [--out FILE]
//
// warm: --prefill requests, one at a time, before the clock starts, and not
//   counted in the run. On /healthz they load the root into an isolate and the
//   manifest of root:latest into the colo's cache, so the timed requests meet
//   the Worker warm.
// The load: request i starts at t0 + i * 1000 / rps ms, whatever the earlier
//   ones are doing (openLoop of range-load.mjs), for rps * seconds requests.
// --doh: the host's A and AAAA records are read from that DNS-over-HTTPS
//   server (the JSON form, as curl --doh-url reads the wire form). Without it,
//   the system resolver answers. Either way the addresses are read once, the
//   record names them, and every connection goes to them.
// --family 4 or 6: only the addresses of that family, so every request leaves
//   over one family. Without it a caller with both families can spread its
//   requests over its IPv4 and its IPv6 addresses, and a rule that counts per
//   source address sees each share apart.
// --h2: every request goes over one HTTP/2 connection, opened again only when
//   the server closes it. A caller whose network spreads its connections over
//   several public addresses (several uplinks) then still sends from one, for
//   as long as the connection lasts; transport.connections counts them. Without
//   it, requests go over a pool of HTTP/1.1 keep-alive connections, and the
//   record counts those.
//
// Who wrote an answer: the Worker sets `access-control-expose-headers` on
// every answer (CORS of apps/api/src/answer.ts), so an answer that carries it
// is the Worker's, and one that lacks it is the edge's own. Of an edge answer
// the script keeps only the Cloudflare error code of its body (such as 1015),
// never the body: a Cloudflare error page names the caller's address.
//
// Classes, in this order: challenge (the answer carries `cf-mitigated`), 429,
// 403, 503, expected (--expect, written by the Worker), 5xx (any other 5xx),
// other (any other status, an answer of --expect that the edge wrote, a
// redirect, which is never followed, a client timeout or a failed connection).
// Latency is the client's: from the start of the request to the last byte,
// over every request, failed ones included. A percentile is the value at index
// floor(n * q) of the ascending list (quantile of probes/worker/src/gaps.ts).
//
// The verdict is PASS when every criterion passes:
//   requests            at least one request ran
//   no-429              no answer of status 429: the entry's Prove
//   no-gate             no answer of 403 or 503 and none with cf-mitigated
//   5xx-at-most-1pct    at most 1% of answers 5xx
//   other-at-most-1pct  at most 1% of answers other
//   prefill-expected    every prefill request answered --expect from the Worker
//
// stdout: the table, one criterion a line, then PASS or FAIL. --out: the
// result, schema domains.measure.edge-load.v1. The host of a *.workers.dev URL
// is written as WORKER.ACCOUNT.workers.dev (redactHost of range-load.mjs).
//
// Exit codes: 0 PASS · 1 FAIL (the finding; --out is written) · 2 could not run
// (usage, or the resolver gave no address for the host, or none of --family).
import { lookup as systemLookup } from 'node:dns/promises';
import http from 'node:http';
import http2 from 'node:http2';
import https from 'node:https';
import { isIP } from 'node:net';
import { release, type } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs, repeatedFlag } from '../lib/args.mjs';
import { USER_AGENT } from '../lib/user-agent.mjs';
import { openLoop, redactHost, spread, writeAtomic } from './range-load.mjs';

export const SCHEMA = 'domains.measure.edge-load.v1';
// The header the Worker sets on every answer (apps/api/src/answer.ts, CORS).
export const WORKER_HEADER = 'access-control-expose-headers';
const BODY_KEEP_BYTES = 64 * 1024;
const SAMPLES = 10;
const USAGE =
  'usage: node scripts/measure/edge-load.mjs --url <http(s) URL> --rps N [--seconds 60] [--expect 200] [--prefill 5] [--doh <DoH URL>] [--family 4|6] [--h2] [--timeout-ms 30000] [--place P] [--out FILE]';

export const DEFINITIONS = Object.freeze({
  writer: `worker: the answer carries ${WORKER_HEADER}, which the Worker sets on every answer (apps/api/src/answer.ts); edge: it does not, so Cloudflare answered in the Worker's place`,
  classes:
    'challenge: the answer carries cf-mitigated; 429, 403 and 503: that status; expected: --expect from the Worker; 5xx: any other 5xx; other: anything else, an edge answer of --expect, a redirect (never followed), a client timeout or a failed connection',
  latency_ms: 'the client: from the start of a request to the last byte of its answer, over every request of the run, failed ones included',
  quantiles: 'the value at index floor(n * q) of the ascending list (probes/worker/src/gaps.ts quantile)',
  open_loop: 'request i starts at t0 + i * 1000 / rps ms, whatever the earlier ones are doing; client_lag_ms is how late the client started it',
  warm: '--prefill requests one at a time before the clock starts, not counted in the run',
});

export class UsageError extends Error {}

function intFlag(a, name, min, max, fallback) {
  const v = a[name];
  if (v === undefined) return fallback;
  if (v === true) throw new UsageError(`--${name} needs a value`);
  const n = /^\d{1,16}$/.test(v) ? Number(v) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new UsageError(`--${name} must be a whole number from ${min} to ${max}`);
  return n;
}

function httpUrl(v, name) {
  let u;
  try {
    u = new URL(v);
  } catch {
    throw new UsageError(`--${name} is not a URL`);
  }
  if (!/^https?:$/.test(u.protocol)) throw new UsageError(`--${name} must be an http or https URL`);
  return u;
}

// The flags, checked. Throws UsageError.
export function parseFlags(argv) {
  const a = parseArgs(argv);
  if (a._.length > 0) throw new UsageError(`unexpected argument ${a._[0]}`);
  const known = ['url', 'rps', 'seconds', 'expect', 'prefill', 'doh', 'family', 'h2', 'timeout-ms', 'place', 'out'];
  for (const k of Object.keys(a)) if (k !== '_' && !known.includes(k)) throw new UsageError(`unknown flag --${k}`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given twice`);
  for (const k of ['url', 'doh', 'family', 'place', 'out']) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a.family !== undefined && a.family !== '4' && a.family !== '6') throw new UsageError('--family must be 4 or 6');
  if (a.h2 !== undefined && a.h2 !== true) throw new UsageError('--h2 takes no value');
  if (a.url === undefined) throw new UsageError('--url is required');
  const url = httpUrl(a.url, 'url');
  if (a.rps === undefined) throw new UsageError('--rps is required');
  const place = a.place ?? 'local';
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(place)) throw new UsageError('--place is a short lowercase label, such as operator or runner');
  return {
    url: url.href,
    rps: intFlag(a, 'rps', 1, 500, 0),
    seconds: intFlag(a, 'seconds', 1, 600, 60),
    expect: intFlag(a, 'expect', 100, 599, 200),
    prefill: intFlag(a, 'prefill', 0, 100, 5),
    doh: a.doh === undefined ? null : httpUrl(a.doh, 'doh').href,
    family: a.family === undefined ? null : Number(a.family),
    h2: a.h2 === true,
    timeoutMs: intFlag(a, 'timeout-ms', 1000, 120000, 30000),
    place,
    out: a.out,
  };
}

// The A and AAAA addresses of `host` from a DoH server's JSON answers, in the
// order the server gave them, A first. Throws when the server fails or gives none.
export async function dohAddresses(doh, host, timeoutMs) {
  const out = [];
  for (const [rr, family] of [
    [1, 4],
    [28, 6],
  ]) {
    const u = new URL(doh);
    u.searchParams.set('name', host);
    u.searchParams.set('type', rr === 1 ? 'A' : 'AAAA');
    const res = await fetch(u, { headers: { accept: 'application/dns-json', 'user-agent': USER_AGENT }, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`the DoH server answered ${res.status} for ${host} ${rr === 1 ? 'A' : 'AAAA'}`);
    const doc = await res.json();
    if (doc?.Status !== 0 && doc?.Status !== 3) throw new Error(`the DoH server gave DNS status ${doc?.Status} for ${host}`);
    for (const ans of Array.isArray(doc.Answer) ? doc.Answer : []) {
      if (ans?.type === rr && typeof ans.data === 'string' && isIP(ans.data) === family) out.push({ address: ans.data, family });
    }
  }
  if (out.length === 0) throw new Error(`the DoH server gave no A or AAAA address for ${host}`);
  return out;
}

// A lookup for net.connect that answers `host` with fixed addresses, and any
// other name with the system resolver.
export function pinnedLookup(host, addresses) {
  return (name, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'object' && options !== null ? options : {};
    if (name.toLowerCase() !== host) {
      systemLookup(name, { all: true }).then(
        (list) => (opts.all ? cb(null, list) : cb(null, list[0].address, list[0].family)),
        (err) => cb(err),
      );
      return;
    }
    const list = opts.family === 4 || opts.family === 6 ? addresses.filter((x) => x.family === opts.family) : addresses;
    if (list.length === 0) {
      cb(Object.assign(new Error(`no IPv${opts.family} address for ${name}`), { code: 'ENOTFOUND' }));
      return;
    }
    if (opts.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  };
}

// The Cloudflare error code of an edge page, such as 1015, or null. Only the
// code is kept: the page also names the caller's address.
export function edgeCode(text) {
  const m = /error code:?\s*(\d{4})\b/i.exec(text) ?? /\bError\s+(\d{4})\b/.exec(text);
  return m ? Number(m[1]) : null;
}

// The answer of one request, built from its stream: the status and headers
// at the head, the first BODY_KEEP_BYTES of the body, and the time to its end
// or to its failure. The first of end and fail settles it; a later call does nothing.
function answerOf(started, done) {
  const chunks = [];
  let kept = 0;
  let bytes = 0;
  return {
    data(c) {
      bytes += c.length;
      if (kept < BODY_KEEP_BYTES) {
        chunks.push(c);
        kept += c.length;
      }
    },
    end(status, headers, remote) {
      done({ status, headers, text: Buffer.concat(chunks).toString('utf8'), bytes, remote, ms: performance.now() - started, client: null });
    },
    fail(err) {
      const timedOut = err?.name === 'TimeoutError' || err?.cause?.name === 'TimeoutError';
      done({ status: null, headers: {}, text: '', bytes: 0, remote: null, ms: performance.now() - started, client: timedOut ? 'client-timeout' : `client-error ${err?.code ?? err?.name ?? 'Error'}` });
    },
  };
}

const earlyEnd = () => Object.assign(new Error('the answer ended early'), { code: 'EARLY_END' });

// One request over HTTP/1.1, on a socket of `agent`; `sockets` collects every
// socket the run used. Never rejects: a failure is in the record.
export function getAnswer(url, { agent, lookup, timeoutMs, sockets }) {
  const started = performance.now();
  const u = new URL(url);
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((done) => {
    const a = answerOf(started, done);
    let req;
    try {
      req = mod.get(u, { agent, lookup, headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) }, (res) => {
        // Read at the head: once the body ends, a kept-alive socket goes back to the pool and leaves the answer.
        const remote = res.socket?.remoteAddress ?? null;
        res.on('data', (c) => a.data(c));
        res.on('end', () => a.end(res.statusCode, res.headers, remote));
        res.on('error', (err) => a.fail(err));
        res.on('close', () => {
          if (!res.complete) a.fail(earlyEnd());
        });
      });
    } catch (err) {
      a.fail(err);
      return;
    }
    req.on('socket', (sock) => sockets?.add(sock));
    req.on('error', (err) => a.fail(err));
  });
}

// One HTTP/2 connection to `origin` for the whole run, so every request leaves
// from one source address of the caller. A new one opens only when the server
// closes the last, and `opened` counts them.
export function h2Session(origin, lookup) {
  let session = null;
  let opened = 0;
  return {
    get() {
      if (session === null || session.closed || session.destroyed) {
        const s = http2.connect(origin, lookup ? { lookup } : {});
        // A session error fails the streams it carries, and each records it.
        s.on('error', () => {});
        s.on('goaway', () => {
          if (session === s) session = null;
        });
        session = s;
        opened += 1;
      }
      return session;
    },
    opened: () => opened,
    close: () => session?.close(),
  };
}

// One request over the run's HTTP/2 connection. Never rejects: a failure is in the record.
export function getAnswerH2(url, { h2, timeoutMs }) {
  const started = performance.now();
  const u = new URL(url);
  return new Promise((done) => {
    const a = answerOf(started, done);
    let req;
    try {
      req = h2.get().request({ ':method': 'GET', ':path': `${u.pathname}${u.search}`, accept: 'application/json', 'user-agent': USER_AGENT }, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      a.fail(err);
      return;
    }
    let head = null;
    req.on('response', (headers) => {
      const { ':status': status, ...rest } = headers;
      head = { status, headers: rest, remote: req.session?.socket?.remoteAddress ?? null };
    });
    req.on('data', (c) => a.data(c));
    req.on('end', () => (head === null ? a.fail(earlyEnd()) : a.end(head.status, head.headers, head.remote)));
    req.on('error', (err) => a.fail(err));
  });
}

// The run's transport: HTTP/1.1 over a keep-alive pool, or one HTTP/2 connection.
function transportOf(flags, resolver) {
  const u = new URL(flags.url);
  if (flags.h2) {
    const h2 = h2Session(u.origin, resolver.lookup);
    return { protocol: 'h2', get: (url) => getAnswerH2(url, { h2, timeoutMs: flags.timeoutMs }), connections: () => h2.opened(), close: () => h2.close() };
  }
  const mod = u.protocol === 'https:' ? https : http;
  const agent = new mod.Agent({ keepAlive: true, maxSockets: Number.POSITIVE_INFINITY, lookup: resolver.lookup });
  const sockets = new Set();
  return {
    protocol: 'http/1.1',
    get: (url) => getAnswer(url, { agent, lookup: resolver.lookup, timeoutMs: flags.timeoutMs, sockets }),
    connections: () => sockets.size,
    close: () => agent.destroy(),
  };
}

// The writer, class and key of one answer.
export function classify(a, expect) {
  if (a.client !== null) return { writer: null, cls: 'other', key: a.client, code: null };
  const writer = a.headers[WORKER_HEADER] === undefined ? 'edge' : 'worker';
  const mitigated = typeof a.headers['cf-mitigated'] === 'string' ? a.headers['cf-mitigated'] : null;
  const code = writer === 'edge' ? edgeCode(a.text) : null;
  const key = `${writer}-${a.status}${code === null ? '' : `-${code}`}${mitigated === null ? '' : `-mitigated-${mitigated}`}`;
  let cls;
  if (mitigated !== null) cls = 'challenge';
  else if (a.status === 429 || a.status === 403 || a.status === 503) cls = String(a.status);
  else if (a.status === expect && writer === 'worker') cls = 'expected';
  else if (a.status >= 500 && a.status <= 599) cls = '5xx';
  else cls = 'other';
  return { writer, cls, key, code };
}

// The `version` of a JSON body, as /healthz answers it, or null.
function versionOf(text) {
  try {
    const v = JSON.parse(text)?.version;
    return typeof v === 'string' ? v : null;
  } catch {
    return null;
  }
}

function recordOf(i, lag, a, expect) {
  const { writer, cls, key, code } = classify(a, expect);
  const ray = typeof a.headers['cf-ray'] === 'string' ? a.headers['cf-ray'] : '';
  const cache = a.headers['x-domains-cache'];
  return {
    i,
    lag,
    ms: a.ms,
    writer,
    cls,
    key,
    code,
    colo: /-([A-Z]{3})$/.exec(ray)?.[1] ?? null,
    remote: a.remote,
    cache: writer === 'worker' ? (typeof cache === 'string' ? cache : 'absent') : null,
    version: writer === 'worker' ? versionOf(a.text) : null,
  };
}

const tally = (values) => {
  const out = {};
  for (const v of values) if (v !== null) out[v] = (out[v] ?? 0) + 1;
  return out;
};

// The counts and spreads of a list of records.
export function summarize(records) {
  const counts = { requests: records.length, expected: 0, 429: 0, 403: 0, 503: 0, challenge: 0, '5xx': 0, other: 0 };
  for (const r of records) counts[r.cls] += 1;
  return {
    counts,
    by_status: tally(records.map((r) => r.key)),
    writers: tally(records.map((r) => r.writer ?? 'none')),
    latency_ms: spread(records.map((r) => r.ms)),
    client_lag_ms: spread(records.flatMap((r) => (r.lag === null ? [] : [r.lag]))),
    colos: tally(records.map((r) => r.colo)),
    remotes: tally(records.map((r) => r.remote)),
    cache: tally(records.map((r) => r.cache)),
    versions: tally(records.map((r) => r.version)),
    samples: records
      .filter((r) => r.cls !== 'expected')
      .slice(0, SAMPLES)
      .map((r) => ({ i: r.i, key: r.key, code: r.code })),
  };
}

// The criteria of a run.
export function judge(summary, prefill) {
  const c = summary.counts;
  const n = c.requests;
  return [
    { name: 'requests', pass: n > 0, detail: `${n} requests answered or failed` },
    { name: 'no-429', pass: c[429] === 0, detail: `${c[429]} of ${n}` },
    { name: 'no-gate', pass: c[403] + c[503] + c.challenge === 0, detail: `403 ${c[403]} · 503 ${c[503]} · challenge ${c.challenge} of ${n}` },
    { name: '5xx-at-most-1pct', pass: c['5xx'] * 100 <= n, detail: `${c['5xx']} of ${n}` },
    { name: 'other-at-most-1pct', pass: c.other * 100 <= n, detail: `${c.other} of ${n}` },
    { name: 'prefill-expected', pass: prefill.expected === prefill.requests, detail: `${prefill.expected} of ${prefill.requests}` },
  ];
}

const cell = (v) => (v === null || v === undefined ? '-' : String(v));
const line = (o) =>
  Object.entries(o)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${k}:${v}`)
    .join(' ') || '-';

export function table(result) {
  const { run, target, resolver, transport, prefill, summary: s } = result;
  const c = s.counts;
  return [
    `edge-load place=${run.place} rps=${run.rps} seconds=${run.seconds} expect=${run.expect} prefill=${run.prefill} family=${run.family ?? 'any'} h2=${run.h2} timeout_ms=${run.timeout_ms}`,
    `target       ${target.host}${target.path}`,
    `resolver     ${resolver.kind}${resolver.doh ? ` ${resolver.doh}` : ''}: ${resolver.addresses.map((x) => x.address).join(' ') || '-'}`,
    `transport    ${transport.protocol}, ${transport.connections} connection(s) opened`,
    `prefill      ${prefill.expected} of ${prefill.requests} expected  ${line(prefill.by_status)}`,
    `requests     ${c.requests}  ${run.expect} ${c.expected}  429 ${c[429]}  403 ${c[403]}  503 ${c[503]}  challenge ${c.challenge}  5xx ${c['5xx']}  other ${c.other}`,
    `by_status    ${line(s.by_status)}`,
    `writers      ${line(s.writers)}`,
    `latency_ms   p50 ${cell(s.latency_ms.p50)}  p95 ${cell(s.latency_ms.p95)}  max ${cell(s.latency_ms.max)}  (client: request start to last byte)`,
    `client_lag   p95 ${cell(s.client_lag_ms.p95)} ms  max ${cell(s.client_lag_ms.max)} ms`,
    `colos        ${line(s.colos)}`,
    `remotes      ${line(s.remotes)}`,
    `cache        ${line(s.cache)}  (x-domains-cache of the Worker's answers)`,
    `versions     ${line(s.versions)}`,
  ].join('\n');
}

// The addresses the run connects to, read once: the DoH server's, the system
// resolver's, or the literal of the URL; only those of --family when it is set.
export async function resolverOf(flags) {
  const host = new URL(flags.url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
  let kind;
  let all;
  if (isIP(host)) {
    kind = 'literal';
    all = [{ address: host, family: isIP(host) }];
  } else if (flags.doh !== null) {
    kind = 'doh';
    all = await dohAddresses(flags.doh, host, flags.timeoutMs);
  } else {
    kind = 'system';
    all = (await systemLookup(host, { all: true })).map((x) => ({ address: x.address, family: x.family }));
  }
  const addresses = flags.family === null ? all : all.filter((x) => x.family === flags.family);
  if (addresses.length === 0) throw new Error(`the ${kind} resolver gave no IPv${flags.family} address for ${host}`);
  return { kind, doh: flags.doh, family: flags.family, addresses, lookup: kind === 'literal' ? undefined : pinnedLookup(host, addresses) };
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr } = {}) {
  let flags;
  try {
    flags = parseFlags(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    stderr.write(`edge-load: ${err.message}\n${USAGE}\n`);
    return 2;
  }
  let resolver;
  try {
    resolver = await resolverOf(flags);
  } catch (err) {
    stderr.write(`edge-load: could not run: ${err.message}\n`);
    return 2;
  }
  const transport = transportOf(flags, resolver);
  const startedAt = new Date().toISOString();
  let records;
  let prefillRecords;
  try {
    prefillRecords = [];
    for (let i = 0; i < flags.prefill; i += 1) prefillRecords.push(recordOf(i, null, await transport.get(flags.url), flags.expect));
    records = await openLoop(flags.rps * flags.seconds, flags.rps, async (i, lag) => recordOf(i, lag, await transport.get(flags.url), flags.expect));
  } finally {
    transport.close();
  }
  const u = new URL(flags.url);
  const prefill = { requests: prefillRecords.length, expected: prefillRecords.filter((r) => r.cls === 'expected').length, by_status: tally(prefillRecords.map((r) => r.key)) };
  const summary = summarize(records);
  const result = {
    schema: SCHEMA,
    entry: 'DOM-062',
    started_at: startedAt,
    ended_at: new Date().toISOString(),
    target: { host: redactHost(u.host), path: u.pathname },
    run: {
      place: flags.place,
      rps: flags.rps,
      seconds: flags.seconds,
      expect: flags.expect,
      prefill: flags.prefill,
      family: flags.family,
      h2: flags.h2,
      timeout_ms: flags.timeoutMs,
      user_agent: USER_AGENT,
    },
    conditions: { node: process.version, os: `${type()} ${release()}`, platform: process.platform },
    resolver: { kind: resolver.kind, doh: resolver.doh, family: resolver.family, addresses: resolver.addresses },
    transport: { protocol: transport.protocol, connections: transport.connections() },
    prefill,
    summary,
    criteria: judge(summary, prefill),
    definitions: DEFINITIONS,
  };
  result.verdict = result.criteria.every((c) => c.pass) ? 'PASS' : 'FAIL';
  stdout.write(`${table(result)}\n${result.criteria.map((c) => `${c.pass ? 'PASS' : 'FAIL'} ${c.name}  ${c.detail}`).join('\n')}\n${result.verdict}\n`);
  if (flags.out) {
    writeAtomic(resolve(flags.out), `${JSON.stringify(result, null, 2)}\n`);
    stderr.write(`edge-load: wrote ${flags.out}\n`);
  }
  return result.verdict === 'PASS' ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main(process.argv.slice(2));
