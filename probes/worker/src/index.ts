// probes/worker/src/index.ts — the temporary probe Worker domains-probe (DOM-061).
//
// Cron: every trigger of wrangler.toml writes one tick, ticks/<slug>/<scheduledTime>.json,
// with {v, cron, scheduledTime, startedAt, lag_ms} as its body and as its R2 custom
// metadata. The 5-minute trigger first writes the hot object hot/<scheduledTime>.bin,
// 1 MiB of random bytes standing for one hot-tier pack, and records the put's wall
// time as put_ms. Every tick writes heartbeat.json last.
//
// Fetch: the route table ROUTES. GET / lists it; GET /gaps answers DOM-002's result
// schema over a window of ticks (src/gaps.ts), kept GAPS_MAX_AGE_S seconds in the
// Cache API. Three measurement routes follow, each one row of ROUTES with its
// handler in a module beside this file: GET /kafka (DOM-005, src/kafka.ts) reads
// OpenINTEL's Kafka broker over cloudflare:sockets; GET /range (DOM-007,
// src/range.ts) reads byte ranges of a GHCR blob of this project's own package;
// GET /decode (DOM-008, src/decode.ts) decodes a sample pack read from the bucket
// PROBE. None of them touches the cron path or adds a binding. A route answers
// anyone: the probe holds random bytes, tick records and a sample pack of public
// names, and no caller is ever asked for a key (AGENTS.md absolute 8).
import {
  CRONS,
  checkHours,
  DEFAULT_HOURS,
  defaultFrom,
  gapsResult,
  HEARTBEAT_KEY,
  HOT_BYTES,
  hotKey,
  iso,
  keyTime,
  makeTick,
  ProbeError,
  RANDOM_CHUNK,
  requireCron,
  type Tick,
  TICK_VERSION,
  tickFromListing,
  tickKey,
  tickMetadata,
  tickPrefix,
  tickToJson,
  WORKER,
  type CronSpec,
} from "./gaps.ts";
import { kafkaRoute } from "./kafka.ts";
import { rangeRoute } from "./range.ts";
import { decodeRoute } from "./decode.ts";
import type { CronController, Env, ProbeBucket, ProbeListOptions } from "./types.ts";

// R2 answers at most 1,000 objects a list call, and fewer when it includes metadata.
const PAGE_LIMIT = 1000;
// MAX_HOURS of the minute cron is 20,160 ticks, 21 full pages. The bound leaves
// room for short pages and still stops a listing whose cursor never ends.
const MAX_PAGES = 400;
const JSON_TYPE = "application/json; charset=utf-8";

// /gaps answers anyone and lists up to about 30 pages of R2 a call, each a class A
// operation, so an answer is kept GAPS_MAX_AGE_S seconds in the Cache API of the
// data centre that served it, keyed on the normalised query: a caller who asks
// again within that time reads the cache, not R2. Cost is bounded by caching, never
// by refusing a caller (AGENTS.md absolute 8). Where no Cache API exists (Node, the
// unit tests) every call lists. Whether workers.dev keeps the entry is not measured.
// Not exported: workerd takes every named export of the entry as a handler.
const GAPS_MAX_AGE_S = 60;

// caches.default exists only in workerd, so Node's types do not declare it: the
// interface names the two members the probe uses (as packages/testkit/test/smoke-worker.ts).
interface DefaultCache {
  put(key: Request, response: Response): Promise<void>;
  match(key: Request): Promise<Response | undefined>;
}

const defaultCache = (): DefaultCache | undefined => (globalThis as unknown as { caches?: { default?: DefaultCache } }).caches?.default;

export interface Route {
  readonly method: "GET";
  readonly path: string;
  readonly entry: string;
  readonly summary: string;
  // `now` is the clock: Date.now in the Worker, a fixed one in a test.
  handle(request: Request, env: Env, url: URL, now: () => number): Promise<Response>;
}

export const ROUTES: readonly Route[] = [
  { method: "GET", path: "/", entry: "DOM-061", summary: "this route list", handle: async () => json(200, routeList()) },
  {
    method: "GET",
    path: "/gaps",
    entry: "DOM-061",
    summary: `DOM-002's result over the first hours=N whole hours of ticks (default ${DEFAULT_HOURS}), from the first tick of the minute cron; ticks=1 adds every tick the result read`,
    handle: gapsRoute,
  },
  kafkaRoute,
  rangeRoute,
  decodeRoute,
];

function routeList(): unknown {
  return { worker: WORKER, entry: "DOM-061", routes: ROUTES.map(({ method, path, entry, summary }) => ({ method, path, entry, summary })) };
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, { status, headers: { "content-type": JSON_TYPE, "cache-control": "no-store", ...headers } });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The probe's one logger: one JSON line per error, which Workers Logs indexes by
// field. Nothing else is logged: a tick's record is its R2 object.
function logError(op: string, id: string, err: unknown): void {
  console.error(JSON.stringify({ level: "error", worker: WORKER, op, id, error: errorMessage(err) }));
}

export function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let at = 0; at < length; at += RANDOM_CHUNK) crypto.getRandomValues(bytes.subarray(at, Math.min(length, at + RANDOM_CHUNK)));
  return bytes;
}

async function put(bucket: ProbeBucket, key: string, value: string | Uint8Array, options: Parameters<ProbeBucket["put"]>[2]): Promise<void> {
  const stored = await bucket.put(key, value, options);
  if (stored === null) throw new ProbeError(502, `R2 stored nothing for ${key}`);
}

// One cron invocation. startedMs is Date.now() read at the top of the handler. The
// tick is written even when the hot put fails, with the failure in put_error, and
// the invocation then fails so that Workers Logs shows it.
export async function recordTick(bucket: ProbeBucket, controller: CronController, startedMs: number): Promise<Tick> {
  const spec = requireCron(controller.cron);
  const scheduledMs = controller.scheduledTime;
  if (!Number.isSafeInteger(scheduledMs)) throw new ProbeError(500, `scheduledTime ${String(scheduledMs)} is not a whole number of milliseconds`);
  let putMs: number | null = null;
  let putError: string | null = null;
  if (spec.hot) {
    const bytes = randomBytes(HOT_BYTES);
    // In workerd the clock advances only across I/O, so the two readings bracket the put alone.
    const before = Date.now();
    try {
      await put(bucket, hotKey(scheduledMs), bytes, { httpMetadata: { contentType: "application/octet-stream" } });
      putMs = Date.now() - before;
    } catch (err) {
      putError = errorMessage(err);
    }
  }
  const tick = makeTick(spec, scheduledMs, startedMs, putMs, putError);
  await put(bucket, tickKey(spec, scheduledMs), `${JSON.stringify(tickToJson(tick))}\n`, { httpMetadata: { contentType: JSON_TYPE }, customMetadata: tickMetadata(tick) });
  const beat = { v: TICK_VERSION, worker: WORKER, cron: tick.cron, scheduledTime: iso(scheduledMs), beat: iso(Date.now()), ok: putError === null };
  await put(bucket, HEARTBEAT_KEY, `${JSON.stringify(beat)}\n`, { httpMetadata: { contentType: JSON_TYPE } });
  if (tick.putError !== null) throw new ProbeError(502, `the hot put of ${hotKey(scheduledMs)} failed: ${tick.putError}`);
  return tick;
}

interface Counter {
  calls: number;
}

async function firstTickTime(bucket: ProbeBucket, spec: CronSpec, counter: Counter): Promise<number | null> {
  counter.calls += 1;
  const listed = await bucket.list({ prefix: tickPrefix(spec), limit: 1 });
  const first = listed.objects[0];
  if (first === undefined) return null;
  const ms = keyTime(spec, first.key);
  if (ms === null) throw new ProbeError(500, `${first.key} under ${tickPrefix(spec)} is not a tick key`);
  return ms;
}

// The ticks of one cron whose scheduled time is in [fromMs, toMs), and its first
// tick at or past toMs, which closes the window's last gap. Keys hold the scheduled
// time as toISOString text, so their order is time order: the listing starts after
// the key of fromMs - 1 and stops at that first tick past the window.
async function listTicks(bucket: ProbeBucket, spec: CronSpec, fromMs: number, toMs: number, counter: Counter): Promise<Tick[]> {
  const ticks: Tick[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const options: ProbeListOptions = { prefix: tickPrefix(spec), limit: PAGE_LIMIT, include: ["customMetadata"] };
    if (cursor === undefined) options.startAfter = tickKey(spec, fromMs - 1);
    else options.cursor = cursor;
    counter.calls += 1;
    const listed = await bucket.list(options);
    for (const object of listed.objects) {
      const at = keyTime(spec, object.key);
      if (at === null) throw new ProbeError(500, `${object.key} under ${tickPrefix(spec)} is not a tick key`);
      if (at < fromMs) continue;
      ticks.push(tickFromListing(spec, object.key, object.customMetadata));
      if (at >= toMs) return ticks;
    }
    if (!listed.truncated) return ticks;
    if (listed.cursor === undefined || listed.cursor === "") throw new ProbeError(502, `R2 answered a truncated listing of ${tickPrefix(spec)} with no cursor`);
    cursor = listed.cursor;
  }
  throw new ProbeError(500, `the listing of ${tickPrefix(spec)} passed ${MAX_PAGES} pages`);
}

function hoursParam(text: string | null): number {
  if (text === null) return DEFAULT_HOURS;
  if (!/^\d{1,4}$/.test(text)) throw new ProbeError(400, "hours must be a whole number");
  return checkHours(Number(text));
}

function ticksParam(text: string | null): boolean {
  if (text === null || text === "0") return false;
  if (text === "1") return true;
  throw new ProbeError(400, "ticks must be 1 or 0");
}

async function gapsRoute(_request: Request, env: Env, url: URL, now: () => number): Promise<Response> {
  for (const name of url.searchParams.keys()) if (name !== "hours" && name !== "ticks") throw new ProbeError(400, `/gaps takes hours and ticks, not ${name}`);
  const hours = hoursParam(url.searchParams.get("hours"));
  const withTicks = ticksParam(url.searchParams.get("ticks"));
  const cache = defaultCache();
  const key = new Request(`${url.origin}/gaps?hours=${hours}&ticks=${withTicks ? 1 : 0}`);
  const hit = cache === undefined ? undefined : await cache.match(key);
  if (hit !== undefined) return hit;
  const counter: Counter = { calls: 0 };
  const firsts = new Map<string, number>();
  const found = await Promise.all(CRONS.map(async (spec) => [spec.cron, await firstTickTime(env.PROBE, spec, counter)] as const));
  for (const [cron, ms] of found) if (ms !== null) firsts.set(cron, ms);
  const fromMs = defaultFrom(firsts);
  const lists = fromMs === null ? [] : await Promise.all(CRONS.map((spec) => listTicks(env.PROBE, spec, fromMs, fromMs + hours * 3_600_000, counter)));
  const ticks = lists.flat();
  // Read after the listing's I/O, so that it is the time the listing ended.
  const nowMs = now();
  const result = gapsResult({ ticks, hours, fromMs, nowMs });
  const extra: Record<string, unknown> = { read_from: "R2 binding PROBE: a listing of ticks/ with custom metadata", list_calls: counter.calls };
  // The ticks the result read: the window's, and each cron's first tick past it.
  if (withTicks) extra.ticks = ticks.map(tickToJson);
  const response = json(200, { ...result, ...extra }, { "cache-control": `public, max-age=${GAPS_MAX_AGE_S}` });
  if (cache !== undefined) await cache.put(key, response.clone());
  return response;
}

export async function handleFetch(request: Request, env: Env, now: () => number = Date.now): Promise<Response> {
  const url = new URL(request.url);
  const route = ROUTES.find((candidate) => candidate.path === url.pathname);
  if (route === undefined) return json(404, { error: `no route ${url.pathname}`, routes: ROUTES.map((r) => r.path) });
  if (request.method !== route.method) return json(405, { error: `${url.pathname} answers ${route.method} only` }, { allow: route.method });
  try {
    return await route.handle(request, env, url, now);
  } catch (err) {
    const id = request.headers.get("cf-ray") ?? crypto.randomUUID();
    const status = err instanceof ProbeError ? err.status : 500;
    // A 4xx is the caller's query, answered in the body; only the probe's own failures are logged.
    if (status >= 500) logError(url.pathname, id, err);
    return json(status, { error: errorMessage(err), id });
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleFetch(request, env);
  },
  async scheduled(controller: CronController, env: Env): Promise<void> {
    const startedMs = Date.now();
    try {
      await recordTick(env.PROBE, controller, startedMs);
    } catch (err) {
      const slot = Number.isFinite(controller.scheduledTime) ? iso(controller.scheduledTime) : String(controller.scheduledTime);
      logError("scheduled", `${controller.cron}@${slot}`, err);
      throw err;
    }
  },
};
