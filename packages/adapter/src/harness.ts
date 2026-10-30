// packages/adapter/src/harness.ts — run an adapter against recorded answers and
// hold it to the adapter contract (docs/architecture.md section 5.6).
//
//   const recordings = readRecordings(fixtureDir);          // @domains/adapter/node
//   const { first, again, next } = await runAdapter(adapter, { recordings, cursor, now });
//
// runAdapter runs `adapter.run` three times, each with a fresh in-memory writer
// and a fake fetch that answers from the recordings:
//   first  from `cursor`;
//   again  from `cursor` again, which must return equal segments and cursor;
//   next   from the cursor `first` returned, which must not write a window of
//          `first` again: the cursor moved past what it wrote.
// It throws ContractError, naming the check, when:
//   unrecorded     a request matched no recording, even one the adapter caught;
//   global-fetch   the adapter called the global fetch, or opened a WebSocket,
//                  an XMLHttpRequest or an EventSource, instead of ctx.fetch
//                  (a fetch captured before the run, or node:net, is not caught);
//   user-agent     a request did not send ctx.userAgent (ruling 11);
//   threw          run() threw;
//   result         the result is not { segments, cursor, stats, errors };
//   segment, cursor  a segment or a cursor breaks its grammar, or a cursor is over 4 KiB;
//   reported       the segments returned are not exactly the segments written;
//   source         a segment names a source the adapter's sources do not hold,
//                  or another precision or dataset than its source's;
//   deterministic  `again` differs from `first`;
//   continuation   `next` wrote a window `first` wrote, or `first` wrote
//                  segments and returned the cursor it started from.
//
// A recording is one JSON file, `NAME.http.json`:
//   { "format": "domains.http-recording.v1",
//     "origin": "recorded", "recorded_at": "2026-10-29T08:00:00Z",   (or "origin": "synthetic")
//     "request": { "method": "GET", "url": "https://...", "headers": { "if-none-match": "\"x\"" } },
//     "response": { "status": 200, "headers": { "content-type": "..." }, "body_base64": "..." } }
// A request matches a recording of its method and URL whose request headers it
// all carries; the recording that names the most headers wins, so a conditional
// GET finds its 304 and a plain GET its 200. Two equally good matches are an
// error. The body of a request is not matched. Redirects are followed as fetch
// follows them, each hop answered by its own recording.
//
// The harness replaces the global fetch while it runs, so two runAdapter calls
// in one process do not overlap: the second is refused as `options`. node:test
// runs a file's tests one at a time.
import { canonicalJson, jsonEqual } from "./json.ts";
import type { AdapterContext, AdapterModule, Cursor, Fetch, RunResult, Segment, Source } from "./types.ts";
import { ContractError, checkCursor, isIsoUtc, validateSegment } from "./validate.ts";
import { memoryWriter, type Written } from "./writer.ts";

export const RECORDING_FORMAT = "domains.http-recording.v1";
// The harness's own User-Agent: an adapter that sends a constant of its own
// instead of ctx.userAgent fails the user-agent check.
export const HARNESS_USER_AGENT = "domains.pkgforge.dev-harness/1 (test run, no network)";
const MAX_REDIRECTS = 20;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const NULL_BODY = new Set([204, 205, 304]);
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface Recording {
  readonly name: string;
  readonly origin: "recorded" | "synthetic";
  readonly recordedAt: string | null;
  readonly request: { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>> };
  readonly response: { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array };
}

type Obj = Readonly<Record<string, unknown>>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function bad(name: string, detail: string): ContractError {
  return new ContractError("recording", `${name}: ${detail}`);
}

function stringMap(v: unknown, name: string, field: string): Record<string, string> {
  if (v === undefined) return {};
  if (!isObject(v)) throw bad(name, `${field} is not an object`);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== "string") throw bad(name, `${field}.${k} is not a string`);
    const key = k.toLowerCase();
    if (Object.hasOwn(out, key)) throw bad(name, `${field} names ${key} twice`);
    out[key] = x;
  }
  return out;
}

function decodeBase64(text: unknown, name: string): Uint8Array {
  if (typeof text !== "string" || !BASE64.test(text)) throw bad(name, "response.body_base64 is not base64");
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// One recording file's JSON, checked field by field.
export function parseRecording(json: unknown, name: string): Recording {
  if (!isObject(json)) throw bad(name, "not an object");
  for (const k of Object.keys(json)) if (!["format", "origin", "recorded_at", "request", "response"].includes(k)) throw bad(name, `unknown field ${k}`);
  if (json.format !== RECORDING_FORMAT) throw bad(name, `format is not ${RECORDING_FORMAT}`);
  const origin = json.origin;
  if (origin !== "recorded" && origin !== "synthetic") throw bad(name, 'origin is not "recorded" or "synthetic"');
  // A recorded answer names the time it was read; a synthetic one says so.
  if (origin === "recorded" && !isIsoUtc(json.recorded_at)) throw bad(name, "a recorded answer needs recorded_at, an ISO 8601 UTC time");
  if (origin === "synthetic" && json.recorded_at !== undefined) throw bad(name, "a synthetic answer has no recorded_at");
  const { request, response } = json;
  if (!isObject(request) || !isObject(response)) throw bad(name, "request and response are objects");
  for (const k of Object.keys(request)) if (!["method", "url", "headers"].includes(k)) throw bad(name, `unknown field request.${k}`);
  for (const k of Object.keys(response)) if (!["status", "headers", "body_base64"].includes(k)) throw bad(name, `unknown field response.${k}`);
  if (typeof request.method !== "string" || !/^[A-Z]+$/.test(request.method)) throw bad(name, "request.method is not an upper-case method");
  let url: URL;
  try {
    url = new URL(String(request.url));
  } catch {
    // The parser's own message says only "Invalid URL".
    throw bad(name, `request.url ${JSON.stringify(request.url)} is not a URL`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw bad(name, "request.url is not http or https");
  const status = response.status;
  if (typeof status !== "number" || !Number.isInteger(status) || status < 200 || status > 599) throw bad(name, "response.status is not an integer from 200 to 599");
  const body = decodeBase64(response.body_base64, name);
  if (NULL_BODY.has(status) && body.byteLength > 0) throw bad(name, `a ${status} answer has no body`);
  return {
    name,
    origin,
    recordedAt: origin === "recorded" ? (json.recorded_at as string) : null,
    request: { method: request.method, url: url.href, headers: stringMap(request.headers, name, "request.headers") },
    response: { status, headers: stringMap(response.headers, name, "response.headers"), body },
  };
}

export interface RequestLog {
  readonly method: string;
  readonly url: string;
  readonly userAgent: string | null;
  // The recording that answered, or null for a miss.
  readonly recording: string | null;
}

export interface Replay {
  readonly fetch: Fetch;
  readonly requests: readonly RequestLog[];
  readonly misses: readonly RequestLog[];
}

// The answer to method, url and headers: the matching recording that names the
// most request headers.
function pick(recordings: readonly Recording[], method: string, url: string, headers: Headers): Recording | string {
  let best: Recording[] = [];
  let score = -1;
  for (const r of recordings) {
    if (r.request.method !== method || r.request.url !== url) continue;
    const names = Object.keys(r.request.headers);
    if (!names.every((k) => headers.get(k) === r.request.headers[k])) continue;
    if (names.length > score) {
      best = [r];
      score = names.length;
    } else if (names.length === score) best.push(r);
  }
  if (best.length === 0) return "no recording";
  if (best.length > 1) return `${best.length} recordings match equally: ${best.map((r) => r.name).join(", ")}`;
  return best[0]!;
}

export function replayFetch(recordings: readonly Recording[]): Replay {
  const keys = new Set<string>();
  for (const r of recordings) {
    const key = canonicalJson([r.request.method, r.request.url, r.request.headers]);
    if (keys.has(key)) throw new ContractError("recording", `${r.name}: another recording has the same method, URL and headers`);
    keys.add(key);
  }
  const requests: RequestLog[] = [];
  const misses: RequestLog[] = [];
  const fetch: Fetch = async (input, init) => {
    const req = new Request(input, init);
    const userAgent = req.headers.get("user-agent");
    let method = req.method;
    let url = req.url;
    for (let hop = 0; ; hop++) {
      const r = pick(recordings, method, url, req.headers);
      if (typeof r === "string") {
        const log = { method, url, userAgent, recording: null };
        requests.push(log);
        misses.push(log);
        throw new ContractError("unrecorded", `${method} ${url}: ${r}`);
      }
      requests.push({ method, url, userAgent, recording: r.name });
      const { status, headers, body } = r.response;
      const location = headers.location;
      if (REDIRECTS.has(status) && location !== undefined && req.redirect !== "manual") {
        if (req.redirect === "error") throw new TypeError(`fetch: ${url} redirects, and redirect is "error"`);
        if (hop >= MAX_REDIRECTS) throw new TypeError(`fetch: more than ${MAX_REDIRECTS} redirects from ${req.url}`);
        url = new URL(location, url).href;
        if (status === 303 || ((status === 301 || status === 302) && method === "POST")) method = "GET";
        continue;
      }
      const res = new Response(method === "HEAD" || NULL_BODY.has(status) ? null : body.slice(), { status, headers });
      // A constructed Response has no URL; fetch's answer names the last hop.
      Object.defineProperty(res, "url", { value: url });
      Object.defineProperty(res, "redirected", { value: hop > 0 });
      return res;
    }
  };
  return { fetch, requests, misses };
}

export interface HarnessOptions {
  readonly recordings: readonly Recording[];
  readonly cursor: Cursor;
  // The run's time, ISO 8601 UTC, passed as ctx.now.
  readonly now: string;
  readonly userAgent?: string;
  // The adapter's sources (its source.json); when given, every segment is held to them.
  readonly sources?: readonly Source[];
}

export interface HarnessRun {
  readonly result: RunResult;
  readonly requests: readonly RequestLog[];
  readonly written: readonly Written[];
}

export interface HarnessResult {
  readonly first: HarnessRun;
  readonly again: HarnessRun;
  readonly next: HarnessRun;
}

let trapped = false;

// The globals besides fetch that open a connection. Each is replaced while the
// harness runs, whether or not the runtime has it (Node has no XMLHttpRequest).
const NETWORK_GLOBALS = Object.freeze(["WebSocket", "XMLHttpRequest", "EventSource"] as const);

// Runs fn with the global fetch, WebSocket, XMLHttpRequest and EventSource
// replaced by traps that record the call and fail. A reference an adapter took
// before the run (a fetch captured at import time) or a socket of node:net is
// not trapped.
async function withGlobalTrap<T>(calls: string[], fn: () => Promise<T>): Promise<T> {
  if (trapped) throw new ContractError("options", "two runAdapter calls overlap in one process");
  const names = ["fetch", ...NETWORK_GLOBALS];
  const saved = names.map((name) => Object.getOwnPropertyDescriptor(globalThis, name));
  const fetchTrap = async (input: unknown): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    throw new ContractError("global-fetch", `the adapter called the global fetch for ${url}; it reads through ctx.fetch`);
  };
  // `new WebSocket(url)` records the call and throws. `new XMLHttpRequest()`
  // names no URL.
  const opener = (name: string) =>
    class {
      constructor(url?: unknown) {
        const call = url === undefined ? name : `${name} ${String(url)}`;
        calls.push(call);
        throw new ContractError("global-fetch", `the adapter opened ${call}; it reads through ctx.fetch`);
      }
    };
  trapped = true;
  names.forEach((name) => {
    Object.defineProperty(globalThis, name, { value: name === "fetch" ? fetchTrap : opener(name), configurable: true, writable: true });
  });
  try {
    return await fn();
  } finally {
    names.forEach((name, i) => {
      const d = saved[i];
      if (d === undefined) Reflect.deleteProperty(globalThis, name);
      else Object.defineProperty(globalThis, name, d);
    });
    trapped = false;
  }
}

// `result` as a RunResult, or ContractError `result`, `segment` or `cursor`:
// { segments, cursor, stats, errors }, each segment and the cursor held to
// their grammar. runAdapter holds every run to it, and so does
// scripts/ingest/run.mjs.
export function checkResult(result: unknown, what: string): RunResult {
  if (!isObject(result)) throw new ContractError("result", `${what}: run() did not return an object`);
  const { segments, cursor, stats, errors } = result;
  if (!Array.isArray(segments)) throw new ContractError("result", `${what}: segments is not a list`);
  segments.forEach((s: unknown, i: number) => {
    validateSegment(s, `${what}: segments[${i}]`);
  });
  checkCursor(cursor, `${what}: cursor`);
  if (!isObject(stats) || !Object.values(stats).every((n) => typeof n === "number" && Number.isFinite(n))) throw new ContractError("result", `${what}: stats is not an object of finite numbers`);
  if (!Array.isArray(errors)) throw new ContractError("result", `${what}: errors is not a list`);
  errors.forEach((e: unknown, i: number) => {
    if (!isObject(e) || typeof e.source !== "string" || typeof e.code !== "string" || typeof e.detail !== "string")
      throw new ContractError("result", `${what}: errors[${i}] is not { source, code, detail }`);
  });
  return result as unknown as RunResult;
}

// Nothing, or ContractError `source`: each segment names one of `sources`,
// with its precision and one of its datasets. runAdapter holds every run to
// it when given the sources, and so does scripts/ingest/run.mjs.
export function checkSources(segments: readonly Segment[], sources: readonly Source[], what: string): void {
  const byId = new Map(sources.map((s) => [s.id, s]));
  segments.forEach((seg, i) => {
    const s = byId.get(seg.source);
    if (s === undefined) throw new ContractError("source", `${what}: segments[${i}] is of ${seg.source}, which is not one of the adapter's sources (${[...byId.keys()].join(", ")})`);
    if (seg.precision !== s.precision) throw new ContractError("source", `${what}: segments[${i}] has precision ${seg.precision}; ${s.id} is ${s.precision}`);
    if (!s.datasets.includes(seg.dataset)) throw new ContractError("source", `${what}: segments[${i}] feeds ${seg.dataset}; ${s.id} feeds ${s.datasets.join(", ")}`);
  });
}

async function runOnce(adapter: AdapterModule, cursor: Cursor, options: HarnessOptions, userAgent: string, globalCalls: string[], what: string): Promise<HarnessRun> {
  const replay = replayFetch(options.recordings);
  const writer = memoryWriter();
  const ctx: AdapterContext = Object.freeze({ fetch: replay.fetch, now: options.now, userAgent, writer });
  const before = globalCalls.length;
  let result: unknown;
  let thrown: { error: unknown } | null = null;
  try {
    result = await adapter.run(JSON.parse(canonicalJson(cursor)) as Cursor, ctx);
  } catch (error) {
    thrown = { error };
  }
  // A network fault is named before the throw it may have caused.
  if (replay.misses.length > 0) throw new ContractError("unrecorded", `${what}: no recording for ${replay.misses.map((m) => `${m.method} ${m.url}`).join(", ")}`);
  if (globalCalls.length > before)
    throw new ContractError("global-fetch", `${what}: the global fetch, WebSocket, XMLHttpRequest or EventSource was called for ${globalCalls.slice(before).join(", ")}`);
  const noUa = replay.requests.filter((r) => r.userAgent !== userAgent);
  if (noUa.length > 0) throw new ContractError("user-agent", `${what}: ${noUa.map((r) => `${r.method} ${r.url} sent ${JSON.stringify(r.userAgent)}`).join(", ")}, not ctx.userAgent`);
  if (thrown !== null) throw new ContractError("threw", `${what}: run() threw: ${(thrown.error as Error)?.message ?? String(thrown.error)}`, { cause: thrown.error });
  const checked = checkResult(result, what);
  const wrote = writer.written.map((w) => w.segment);
  if (!jsonEqual(checked.segments, wrote)) throw new ContractError("reported", `${what}: run() returned ${checked.segments.length} segments and wrote ${wrote.length}, or not the same ones`);
  if (options.sources !== undefined) checkSources(checked.segments, options.sources, what);
  return { result: checked, requests: replay.requests, written: writer.written };
}

const windowOf = (s: Segment): string => canonicalJson([s.source, s.dataset, s.window]);

export async function runAdapter(adapter: AdapterModule, options: HarnessOptions): Promise<HarnessResult> {
  if (typeof adapter?.run !== "function") throw new ContractError("options", "the adapter module has no run function");
  if (!Array.isArray(options.recordings)) throw new ContractError("options", "recordings is not a list");
  if (!isIsoUtc(options.now)) throw new ContractError("options", `now ${JSON.stringify(options.now)} is not an ISO 8601 UTC time`);
  checkCursor(options.cursor, "the starting cursor");
  const userAgent = options.userAgent ?? HARNESS_USER_AGENT;
  if (typeof userAgent !== "string" || userAgent === "") throw new ContractError("options", "userAgent is empty");
  const globalCalls: string[] = [];
  return withGlobalTrap(globalCalls, async () => {
    const first = await runOnce(adapter, options.cursor, options, userAgent, globalCalls, "run 1");
    const again = await runOnce(adapter, options.cursor, options, userAgent, globalCalls, "run 2, from the same cursor");
    const a = first.result;
    const b = again.result;
    for (let i = 0; i < Math.max(a.segments.length, b.segments.length); i++) {
      if (!jsonEqual(a.segments[i] ?? null, b.segments[i] ?? null)) {
        throw new ContractError("deterministic", `segments[${i}] differs between two runs with the same inputs: ${canonicalJson(a.segments[i] ?? null)} then ${canonicalJson(b.segments[i] ?? null)}`);
      }
    }
    if (!jsonEqual(a.cursor, b.cursor))
      throw new ContractError("deterministic", `the cursor differs between two runs with the same inputs: ${canonicalJson(a.cursor)} then ${canonicalJson(b.cursor)}`);
    if (a.segments.length > 0 && jsonEqual(a.cursor, options.cursor)) throw new ContractError("continuation", "run 1 wrote segments and returned the cursor it started from");
    const next = await runOnce(adapter, a.cursor, options, userAgent, globalCalls, "run 3, from run 1's cursor");
    const seen = new Set(a.segments.map(windowOf));
    for (const s of next.result.segments) {
      if (seen.has(windowOf(s))) throw new ContractError("continuation", `run 3, from run 1's cursor, wrote ${s.source} ${s.dataset} ${s.window.start} to ${s.window.end} again`);
    }
    return { first, again, next };
  });
}
