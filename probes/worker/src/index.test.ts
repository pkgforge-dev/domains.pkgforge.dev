// probes/worker/src/index.test.ts — the probe Worker's cron path and routes under
// Node, against a fake R2 bucket that keeps keys in order, pages its listings and
// returns custom metadata only when a listing asks for it, as R2 does. This is the
// mock tier: the deployed probe is the acceptance test (DOM-061's Prove).
//
//   node scripts/test.mjs probes/worker --name probe
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { COMPATIBILITY_DATE, COMPATIBILITY_FLAGS } from "@domains/testkit";
import { CRONS, gapsResult, HEARTBEAT_KEY, HOT_BYTES, hotKey, OPS_PER_HOT_PUT, OPS_PER_TICK, ProbeError, requireCron, tickFromJson, tickKey } from "./gaps.ts";
import worker, { handleFetch, ROUTES, recordTick } from "./index.ts";
import type { Env, ProbeBucket, ProbeListOptions, ProbeObject, ProbeObjects, ProbePutOptions } from "./types.ts";

const M1 = requireCron("* * * * *");
const M5 = requireCron("*/5 * * * *");
const MIN = 60_000;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");

interface Stored {
  readonly value: string | Uint8Array;
  readonly options: ProbePutOptions | undefined;
}

class FakeBucket implements ProbeBucket {
  readonly objects = new Map<string, Stored>();
  readonly calls: { op: "put" | "list"; key?: string; options?: ProbeListOptions }[] = [];
  pageLimit = 1000;
  dropMetadata = false;
  failPut: (key: string) => boolean = () => false;

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: ProbePutOptions): Promise<ProbeObject | null> {
    this.calls.push({ op: "put", key });
    if (this.failPut(key)) throw new Error("R2 put failed (planted)");
    const copy = typeof value === "string" ? value : new Uint8Array(value instanceof ArrayBuffer ? value.slice(0) : value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
    this.objects.set(key, { value: copy, options });
    return { key, size: typeof copy === "string" ? copy.length : copy.byteLength, uploaded: new Date() };
  }

  async list(options: ProbeListOptions = {}): Promise<ProbeObjects> {
    this.calls.push({ op: "list", options: { ...options } });
    const keys = [...this.objects.keys()].filter((key) => key.startsWith(options.prefix ?? "")).sort();
    let start = 0;
    if (options.cursor !== undefined) start = Number(options.cursor);
    else if (options.startAfter !== undefined) {
      const after = options.startAfter;
      const at = keys.findIndex((key) => key > after);
      start = at === -1 ? keys.length : at;
    }
    const limit = Math.min(options.limit ?? 1000, this.pageLimit);
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    const withMetadata = !this.dropMetadata && (options.include ?? []).includes("customMetadata");
    const objects = page.map((key): ProbeObject => {
      const stored = this.objects.get(key)!;
      const size = typeof stored.value === "string" ? stored.value.length : stored.value.byteLength;
      const metadata = stored.options?.customMetadata;
      return withMetadata && metadata !== undefined ? { key, size, uploaded: new Date(), customMetadata: { ...metadata } } : { key, size, uploaded: new Date() };
    });
    return truncated ? { objects, truncated, cursor: String(start + limit) } : { objects, truncated };
  }

  text(key: string): string {
    const stored = this.objects.get(key);
    assert.ok(stored !== undefined, `${key} was written`);
    assert.equal(typeof stored.value, "string");
    return stored.value as string;
  }

  puts(): string[] {
    return this.calls.filter((call) => call.op === "put").map((call) => call.key!);
  }
}

const envOf = (bucket: FakeBucket): Env => ({ PROBE: bucket });

// The ticks of `minutes` minutes from fromMs, each started lagMs late, written by the cron path itself.
async function runCrons(bucket: FakeBucket, fromMs: number, minutes: number, lagMs = 30): Promise<void> {
  for (let m = 0; m < minutes; m += 1) {
    const at = fromMs + m * MIN;
    await recordTick(bucket, { cron: M1.cron, scheduledTime: at }, at + lagMs);
    if (m % 5 === 0) await recordTick(bucket, { cron: M5.cron, scheduledTime: at }, at + lagMs);
  }
}

async function get(bucket: FakeBucket, path: string): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await handleFetch(new Request(`https://probe.test${path}`), envOf(bucket));
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers };
}

test("probe tick: a minute tick puts its record, then the heartbeat, and reads nothing", async () => {
  const bucket = new FakeBucket();
  const tick = await recordTick(bucket, { cron: M1.cron, scheduledTime: T0 }, T0 + 37);
  assert.deepEqual(bucket.puts(), [tickKey(M1, T0), HEARTBEAT_KEY]);
  assert.equal(bucket.calls.filter((call) => call.op === "put").length, OPS_PER_TICK.a);
  assert.equal(bucket.calls.filter((call) => call.op !== "put").length, OPS_PER_TICK.b);
  assert.deepEqual(JSON.parse(bucket.text(tickKey(M1, T0))), { v: 1, cron: "* * * * *", scheduledTime: "2026-10-01T12:00:00.000Z", startedAt: "2026-10-01T12:00:00.037Z", lag_ms: 37 });
  assert.deepEqual(bucket.objects.get(tickKey(M1, T0))!.options?.customMetadata, { v: "1", cron: "* * * * *", startedAt: "2026-10-01T12:00:00.037Z", lag_ms: "37" });
  assert.equal(tick.lagMs, 37);
  const beat = JSON.parse(bucket.text(HEARTBEAT_KEY));
  assert.equal(beat.cron, "* * * * *");
  assert.equal(beat.scheduledTime, "2026-10-01T12:00:00.000Z");
  assert.equal(beat.ok, true);
});

test("probe tick: a 5-minute tick puts 1 MiB of random bytes, then its record with put_ms, then the heartbeat", async () => {
  const bucket = new FakeBucket();
  await recordTick(bucket, { cron: M5.cron, scheduledTime: T0 }, T0 + 12);
  assert.deepEqual(bucket.puts(), [hotKey(T0), tickKey(M5, T0), HEARTBEAT_KEY]);
  assert.equal(bucket.calls.length, OPS_PER_TICK.a + OPS_PER_HOT_PUT.a + OPS_PER_TICK.b + OPS_PER_HOT_PUT.b);
  const hot = bucket.objects.get(hotKey(T0))!.value as Uint8Array;
  assert.equal(hot.byteLength, HOT_BYTES);
  // Random bytes: every byte value appears, and no 64 KiB chunk repeats the first.
  assert.equal(new Set(hot).size, 256);
  const first = Buffer.from(hot.subarray(0, 65_536));
  for (let at = 65_536; at < HOT_BYTES; at += 65_536) assert.notDeepEqual(Buffer.from(hot.subarray(at, at + 65_536)), first);
  const record = tickFromJson(JSON.parse(bucket.text(tickKey(M5, T0))), "hot");
  assert.ok(record.putMs !== null && record.putMs >= 0);
  assert.equal(record.putError, null);
});

test("probe tick: a failed hot put still writes the tick with put_error, then fails the invocation", async () => {
  const bucket = new FakeBucket();
  bucket.failPut = (key) => key.startsWith("hot/");
  await assert.rejects(recordTick(bucket, { cron: M5.cron, scheduledTime: T0 }, T0 + 5), (err: unknown) => err instanceof ProbeError && /hot put/.test(err.message));
  const record = tickFromJson(JSON.parse(bucket.text(tickKey(M5, T0))), "failed");
  assert.equal(record.putMs, null);
  assert.match(record.putError ?? "", /planted/);
  assert.equal(JSON.parse(bucket.text(HEARTBEAT_KEY)).ok, false);
});

test("probe tick: a cron with no row in CRONS is refused before anything is written", async () => {
  const bucket = new FakeBucket();
  await assert.rejects(recordTick(bucket, { cron: "0 * * * *", scheduledTime: T0 }, T0), ProbeError);
  assert.equal(bucket.calls.length, 0);
});

test("probe tick: the scheduled handler reads the clock itself and records the tick", async () => {
  const bucket = new FakeBucket();
  const scheduledTime = Date.now() - 50;
  await worker.scheduled({ cron: M1.cron, scheduledTime }, envOf(bucket));
  const record = tickFromJson(JSON.parse(bucket.text(tickKey(M1, scheduledTime))), "scheduled");
  assert.ok(record.lagMs >= 50 && record.lagMs < 60_000, `lag ${record.lagMs}`);
});

test("probe config: wrangler.toml holds the entry's settings and only crons that CRONS knows", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const setting = (name: string) => toml.match(new RegExp(`^${name} = (.+)$`, "m"))?.[1];
  assert.equal(setting("name"), '"domains-probe"');
  assert.equal(setting("main"), '"src/index.ts"');
  // The deploy runs under the date and the flags the harness tests the probe with.
  assert.equal(setting("compatibility_date"), `"${COMPATIBILITY_DATE}"`);
  const flags = setting("compatibility_flags");
  assert.ok(flags, "wrangler.toml has a compatibility_flags line");
  assert.deepEqual(
    [...flags.matchAll(/"([^"]*)"/g)].map((m) => m[1]),
    [...COMPATIBILITY_FLAGS],
  );
  assert.equal(setting("workers_dev"), "true");
  assert.equal(setting("preview_urls"), "false");
  assert.equal(setting("binding"), '"PROBE"');
  assert.equal(setting("bucket_name"), '"domains-probe"');
  assert.match(toml, /^\[observability\]\nenabled = true$/m);
  assert.doesNotMatch(toml, /^\s*account_id\s*=/m);
  assert.doesNotMatch(toml, /^\s*(\[\[routes\]\]|routes\s*=|route\s*=)/m);
  const crons = toml.match(/^crons = \[(.*)\]$/m);
  assert.ok(crons, "wrangler.toml has a crons line");
  const listed = [...crons[1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]!);
  for (const cron of listed)
    assert.ok(
      CRONS.some((spec) => spec.cron === cron),
      `${cron} has a row in CRONS`,
    );
});

test("probe routes: GET / lists the route table", async () => {
  const { status, body, headers } = await get(new FakeBucket(), "/");
  assert.equal(status, 200);
  assert.equal(headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(headers.get("cache-control"), "no-store");
  assert.deepEqual(
    (body.routes as { path: string }[]).map((route) => route.path),
    ROUTES.map((route) => route.path),
  );
  assert.deepEqual(
    ROUTES.map((route) => route.path),
    ["/", "/gaps", "/range", "/decode"],
  );
  assert.deepEqual(
    ROUTES.map((route) => [route.path, route.entry]),
    [
      ["/", "DOM-061"],
      ["/gaps", "DOM-061"],
      ["/range", "DOM-007"],
      ["/decode", "DOM-008"],
    ],
  );
  for (const route of ROUTES) assert.equal(route.method, "GET", `${route.path} answers GET`);
});

// DOM-005 closed on 2026-10-30 and took /kafka out of ROUTES: the probe does not
// serve it, so it is not a public route until DOM-056 deletes the probe.
test("probe routes: /kafka is not served after DOM-005 closed", async () => {
  assert.equal((await get(new FakeBucket(), "/kafka?topic=certstream_domains&offset=latest")).status, 404);
});

test("probe routes: an unknown path answers 404 and another method 405", async () => {
  assert.equal((await get(new FakeBucket(), "/nope")).status, 404);
  const response = await handleFetch(new Request("https://probe.test/gaps", { method: "POST" }), envOf(new FakeBucket()));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET");
});

test("probe routes: GET /gaps reads one window from a paged listing and answers DOM-002's numbers", async () => {
  const bucket = new FakeBucket();
  await runCrons(bucket, T0, 90);
  bucket.pageLimit = 7;
  bucket.calls.length = 0;
  const { status, body } = await get(bucket, "/gaps?hours=1&ticks=1");
  assert.equal(status, 200);
  assert.equal(body.from, "2026-10-01T12:00:00.000Z");
  assert.equal(body.runs, 60);
  assert.equal(body.expected, 60);
  assert.deepEqual(body.gaps_min, { median: 1, p90: 1, max: 1 });
  assert.equal(body.complete, true);
  assert.equal(body.verdict, "PASS");
  const beside = body.beside as { runs: number; expected: number }[];
  assert.equal(beside[0]!.runs, 12);
  assert.equal(beside[0]!.expected, 12);
  const ticks = (body.ticks as unknown[]).map((tick, i) => tickFromJson(tick, `#${i}`));
  // The window's 60 and 12, and each cron's first tick past it, which closes its last gap.
  assert.equal(ticks.length, 74);
  assert.deepEqual(
    ticks.filter((tick) => tick.scheduledMs >= T0 + 60 * MIN).map((tick) => tick.cron),
    [M1.cron, M5.cron],
  );
  // The answer is the arithmetic of gaps.ts over the ticks it carries.
  const again = gapsResult({ ticks, hours: 1, fromMs: Date.parse(body.from as string), nowMs: Date.parse(body.now as string) });
  for (const [key, value] of Object.entries(again)) assert.deepEqual(body[key], value, key);
  // Every listing that reads ticks asks for their metadata, and the calls are counted.
  const lists = bucket.calls.filter((call) => call.op === "list");
  assert.equal(body.list_calls, lists.length);
  assert.ok(lists.filter((call) => call.options?.limit !== 1).every((call) => call.options?.include?.includes("customMetadata")));
  assert.equal(bucket.calls.filter((call) => call.op === "put").length, 0);
});

test("probe routes: GET /gaps stops listing at the first tick past the window", async () => {
  const bucket = new FakeBucket();
  await runCrons(bucket, T0, 240);
  bucket.pageLimit = 10;
  bucket.calls.length = 0;
  const { status, body } = await get(bucket, "/gaps?hours=1");
  assert.equal(status, 200);
  assert.equal(body.from, "2026-10-01T12:00:00.000Z");
  assert.equal(body.to, "2026-10-01T13:00:00.000Z");
  assert.equal(body.runs, 60);
  assert.equal(body.ticks, undefined);
  // The first-tick read (limit 1), then 60 ticks at 10 a page and the page that holds
  // the first tick past the window: 7 pages, not the 24 of the whole prefix.
  const minuteLists = bucket.calls.filter((call) => call.op === "list" && call.options?.prefix === "ticks/m1/" && call.options.limit !== 1);
  assert.equal(minuteLists.length, 7);
  assert.equal(minuteLists[0]!.options?.startAfter, "ticks/m1/2026-10-01T11:59:59.999Z.json");
});

test("probe routes: GET /gaps with no tick yet answers runs 0 and no window", async () => {
  const { status, body } = await get(new FakeBucket(), "/gaps");
  assert.equal(status, 200);
  assert.equal(body.from, null);
  assert.equal(body.hours, 48);
  assert.equal(body.runs, 0);
  assert.equal(body.expected, 2880);
  assert.equal(body.complete, false);
  assert.equal(body.verdict, "INCOMPLETE");
});

test("probe routes: GET /gaps refuses bad query values with 400", async () => {
  for (const query of ["hours=0", "hours=337", "hours=1.5", "hours=abc", "ticks=2", "from=2026-10-01T12:00:00Z"]) {
    const { status, body } = await get(new FakeBucket(), `/gaps?${query}`);
    assert.equal(status, 400, query);
    assert.equal(typeof body.error, "string");
  }
});

test("probe routes: a tick listed without its metadata answers 500 naming the key", async () => {
  const bucket = new FakeBucket();
  await runCrons(bucket, T0, 3);
  bucket.dropMetadata = true;
  const { status, body } = await get(bucket, "/gaps?hours=1");
  assert.equal(status, 500);
  assert.match(body.error as string, /ticks\/m\d\/2026-10-01T12:00:00\.000Z\.json: listed without its custom metadata/);
});

// /gaps with a clock: the probe's own clock is Date.now, a test fixes it.
async function getAt(bucket: FakeBucket, path: string, nowMs: number): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const response = await handleFetch(new Request(`https://probe.test${path}`), envOf(bucket), () => nowMs);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, headers: response.headers };
}

test("probe routes: GET /gaps while the window is still open answers INCOMPLETE with the ticks so far", async () => {
  // 30 minutes of ticks, read 5 s after the last: the 48 hour window has barely begun.
  const bucket = new FakeBucket();
  await runCrons(bucket, T0, 30);
  for (const pageLimit of [1000, 7]) {
    bucket.pageLimit = pageLimit;
    const { status, body, headers } = await getAt(bucket, "/gaps?hours=48&ticks=1", T0 + 29 * MIN + 5_000);
    assert.equal(status, 200, `page limit ${pageLimit}: ${JSON.stringify(body)}`);
    assert.equal(body.verdict, "INCOMPLETE");
    assert.equal(body.complete, false);
    assert.equal(body.runs, 30);
    assert.equal(body.hours_seen, 0.48);
    assert.deepEqual(body.slots, { expected: 2880, hit: 30, missed: 0 });
    const ticks = (body.ticks as unknown[]).map((tick, i) => tickFromJson(tick, `#${i}`));
    assert.equal(ticks.length, 36);
    assert.ok(ticks.every((tick) => tick.scheduledMs < T0 + 48 * 60 * MIN));
    assert.equal(headers.get("cache-control"), "public, max-age=60");
  }
});

test("probe routes: a truncated listing with no cursor answers 502, and a listing past the page bound 500", async () => {
  const bucket = new FakeBucket();
  await runCrons(bucket, T0, 3);
  const listing = bucket.list.bind(bucket);
  bucket.list = async (options: ProbeListOptions = {}) => {
    const page = await listing(options);
    return options.limit === 1 ? page : { objects: page.objects, truncated: true };
  };
  const cut = await getAt(bucket, "/gaps?hours=1", T0 + 2 * 60 * MIN);
  assert.equal(cut.status, 502);
  assert.match(cut.body.error as string, /truncated listing of ticks\/m\d\/ with no cursor/);
  let pages = 0;
  bucket.list = async (options: ProbeListOptions = {}) => {
    if (options.limit === 1) return listing(options);
    pages += 1;
    return { objects: [], truncated: true, cursor: `page-${pages}` };
  };
  const endless = await getAt(bucket, "/gaps?hours=1", T0 + 2 * 60 * MIN);
  assert.equal(endless.status, 500);
  assert.match(endless.body.error as string, /passed 400 pages/);
});

class FakeCache {
  readonly entries = new Map<string, Response>();
  async put(key: Request, response: Response): Promise<void> {
    this.entries.set(key.url, response);
  }
  async match(key: Request): Promise<Response | undefined> {
    return this.entries.get(key.url)?.clone();
  }
}

test("probe routes: GET /gaps is kept 60 s in the Cache API, keyed on the normalised query, and an error is not kept", async (t) => {
  const cache = new FakeCache();
  const holder = globalThis as unknown as { caches?: unknown };
  const before = holder.caches;
  holder.caches = { default: cache };
  t.after(() => {
    if (before === undefined) delete holder.caches;
    else holder.caches = before;
  });
  const bucket = new FakeBucket();
  await runCrons(bucket, T0, 90);
  bucket.calls.length = 0;
  const first = await getAt(bucket, "/gaps?hours=1", T0 + 3 * 60 * MIN);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "public, max-age=60");
  assert.deepEqual([...cache.entries.keys()], ["https://probe.test/gaps?hours=1&ticks=0"]);
  const listed = bucket.calls.length;
  assert.ok(listed > 0);
  // More ticks arrive; the same question, spelled another way, is answered from the cache.
  await runCrons(bucket, T0 + 90 * MIN, 10);
  bucket.calls.length = 0;
  const again = await getAt(bucket, "/gaps?ticks=0&hours=1", T0 + 4 * 60 * MIN);
  assert.equal(bucket.calls.length, 0, "no R2 call for a cached answer");
  assert.deepEqual(again.body, first.body);
  // Another window or ticks=1 is another key.
  await getAt(bucket, "/gaps?hours=1&ticks=1", T0 + 4 * 60 * MIN);
  await getAt(bucket, "/gaps", T0 + 4 * 60 * MIN);
  assert.deepEqual([...cache.entries.keys()].sort(), ["https://probe.test/gaps?hours=1&ticks=0", "https://probe.test/gaps?hours=1&ticks=1", "https://probe.test/gaps?hours=48&ticks=0"]);
  assert.equal((await getAt(bucket, "/gaps?hours=0", T0)).status, 400);
  bucket.dropMetadata = true;
  assert.equal((await getAt(bucket, "/gaps?hours=2", T0 + 4 * 60 * MIN)).status, 500);
  assert.equal(cache.entries.size, 3);
});

test("probe routes: a 5xx answer logs one JSON line, and a 4xx logs nothing", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => lines.push(line));
  const bucket = new FakeBucket();
  await runCrons(bucket, T0, 3);
  assert.equal((await get(bucket, "/gaps?hours=abc")).status, 400);
  assert.equal((await get(bucket, "/nope")).status, 404);
  assert.deepEqual(lines, []);
  bucket.dropMetadata = true;
  const failed = await get(bucket, "/gaps?hours=1");
  assert.equal(failed.status, 500);
  assert.equal(lines.length, 1);
  const logged = JSON.parse(lines[0]!) as Record<string, unknown>;
  assert.equal(logged.level, "error");
  assert.equal(logged.worker, "domains-probe");
  assert.equal(logged.op, "/gaps");
  assert.equal(logged.id, failed.body.id);
  assert.match(logged.error as string, /listed without its custom metadata/);
});

test("probe tick: every 64 KiB of a hot object is random, and each put names its content type", async () => {
  const bucket = new FakeBucket();
  await recordTick(bucket, { cron: M5.cron, scheduledTime: T0 }, T0 + 12);
  const hot = bucket.objects.get(hotKey(T0))!;
  const bytes = hot.value as Uint8Array;
  for (let at = 0; at < HOT_BYTES; at += 65_536) assert.ok(new Set(bytes.subarray(at, at + 65_536)).size > 250, `the chunk at ${at} is random`);
  assert.equal(hot.options?.httpMetadata?.contentType, "application/octet-stream");
  assert.equal(bucket.objects.get(tickKey(M5, T0))!.options?.httpMetadata?.contentType, "application/json; charset=utf-8");
  assert.equal(bucket.objects.get(HEARTBEAT_KEY)!.options?.httpMetadata?.contentType, "application/json; charset=utf-8");
});

// DOM-002 set crons = [] after its 48 hours (2026-10-30): the probe stays for
// DOM-005, DOM-007 and DOM-008 with no cron, and CRONS keeps the two rows that
// /gaps reads the recorded ticks by.
test("probe config: wrangler.toml lists no cron since DOM-002 closed, every invocation is logged, and it binds the bucket and nothing else", () => {
  const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
  const crons = toml.match(/^crons = \[(.*)\]$/m);
  assert.ok(crons, "wrangler.toml has a crons line");
  assert.equal(crons[1]!.trim(), "");
  assert.deepEqual(CRONS.map((spec) => spec.cron).sort(), ["* * * * *", "*/5 * * * *"]);
  // DOM-008 reads the CPU time of every invocation.
  assert.match(toml, /^head_sampling_rate = 1$/m);
  const tables = [...toml.matchAll(/^\s*(\[\[?[^\]]+\]\]?)\s*$/gm)].map((m) => m[1]);
  assert.deepEqual(tables, ["[triggers]", "[[r2_buckets]]", "[observability]"]);
  assert.doesNotMatch(toml, /durable_objects|containers|\[vars\]|^\s*vars\s*=/m);
});
