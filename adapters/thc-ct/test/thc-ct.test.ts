// adapters/thc-ct in process (design section 13.1): makeRun and makeBackfill
// with the memory writer, held to the adapter's source rows, over recorded and
// synthetic answers (replayFetch of @domains/adapter). The synthetic answers
// of fixtures/ carry the slice of 2026-10-31 (fixtures/recorded.json names its
// real lines); fixtures/recorded/ holds THC's own answers of 2026-11-02T04:29Z
// (record.mjs). Bodies a test needs beyond those (a carriage return, a CSV
// column, a fault) are built here from the slice. Each result is held to
// checkResult and checkSources, every request to a recording.
//
//   node scripts/test.mjs adapters/thc-ct --name "thc-ct:"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  type AdapterContext,
  base64Of,
  ContractError,
  type Cursor,
  checkResult,
  checkSources,
  type Fetch,
  memoryWriter,
  parseRecording,
  RECORDING_FORMAT,
  type Recording,
  type RequestLog,
  type RunResult,
  replayFetch,
  runAdapter,
  validateSourceFile,
  type Written,
} from "@domains/adapter";
import { readBits, readRecordings } from "@domains/adapter/node";
import { EXPECTED } from "@domains/compact";
import { key, loadPsl, normalise, split } from "@domains/names";
import { BASIS } from "@domains/pack";
import { FILE_RAW_BYTES } from "../../../scripts/ingest/writer.mjs";
import { dayIndex, parseCursor } from "../src/cursor.ts";
import { BIT, daysOf, HOSTS, LIMITS, type Limits, makeBackfill, makeRun, SOURCE } from "../src/index.ts";
import { cs2Index, Locator, nextLink, readListing } from "../src/locate.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FIX = join(import.meta.dirname, "..", "fixtures");
const PSL = await loadPsl(readFileSync(join(ROOT, "packages", "names", "test", "fixtures", "psl-2026-10-27.dat")));
const SOURCES = validateSourceFile(JSON.parse(readFileSync(join(import.meta.dirname, "..", "source.json"), "utf8")), readBits(ROOT)).sources;
const META = JSON.parse(readFileSync(join(FIX, "recorded.json"), "utf8")) as {
  day: string;
  absent: string;
  file: { bytes: number; listing_path: string; last_modified: string };
  slice: { synthetic_lines: string[]; gzip_bytes: number };
  listing: { days: number; bytes: number; first: string; last: string };
  index: { days: number; first: string; last: string };
};
const SYNTH = readRecordings(FIX);
const REAL = readRecordings(join(FIX, "recorded"));
const SLICE = readFileSync(join(FIX, "slice-2026-10-31.txt"), "utf8");
const LINES = SLICE.split("\n").filter((l) => l !== "");
const GZ = SYNTH.find((r) => r.name === "cs2-get-20261031.http.json")!.response.body;
const UA = "domains.pkgforge.dev thc-ct test (synthetic)";
const DAY = "2026-10-31";
const PATH = META.file.listing_path;
const fileUrl = (day: string): string => `${HOSTS.cs2}${day}.txt.gz`;
const resolveUrl = (path: string): string => `${HOSTS.resolve}${path}?download=true`;
const cdnUrl = (day: string): string => `https://us.aws.cdn.hf.co/synthetic/${day}.txt.gz`;

const noConnect = (): never => {
  throw new Error("thc-ct connected over TCP; it reads HTTP alone");
};

// ---------------------------------------------------------------- answers

const rec = (name: string, method: string, url: string, status: number, headers: Record<string, string> = {}, body: Uint8Array = new Uint8Array(0)): Recording =>
  parseRecording({ format: RECORDING_FORMAT, origin: "synthetic", request: { method, url }, response: { status, headers, body_base64: base64Of(body) } }, name);
const gz = (lines: readonly string[]): Uint8Array => new Uint8Array(gzipSync(Buffer.from(`${lines.join("\n")}\n`, "utf8")));
const lengthOf = (body: Uint8Array, length?: number): Record<string, string> => ({ "content-length": String(length ?? body.byteLength), "last-modified": META.file.last_modified });

// cs2's HEAD and GET of a day. `length` is the size the HEAD and the GET claim.
function cs2Day(day: string, body: Uint8Array, o: { length?: number; status?: number; headers?: Record<string, string> } = {}): Recording[] {
  return [
    rec(`cs2-head-${day}`, "HEAD", fileUrl(day), 200, lengthOf(body, o.length)),
    rec(`cs2-get-${day}`, "GET", fileUrl(day), o.status ?? 200, { ...lengthOf(body, o.length), ...o.headers }, o.status === undefined || o.status === 200 ? body : new Uint8Array(0)),
  ];
}
const cs2Absent = (day: string): Recording => rec(`cs2-head-${day}`, "HEAD", fileUrl(day), 404, { "content-type": "text/html" });
// The listing of `days`, each at the upload month's path of its day (F1's shape).
function listing(days: readonly { day: string; size: number }[]): Recording {
  const entries = days.map((d) => ({ type: "file", path: pathOf(d.day), size: d.size, mtime: "2026-11-01T00:05:02.000Z" }));
  return rec("hf-listing", "GET", HOSTS.listing, 200, { "content-type": "application/json" }, new TextEncoder().encode(JSON.stringify(entries)));
}
const pathOf = (day: string): string => (day === DAY ? PATH : `2026/${Number(day.slice(5, 7))}/${day}.txt.gz`);
// The bucket's resolve 302 and the CDN's answer of a day.
function hfDay(day: string, body: Uint8Array, o: { status?: number; headers?: Record<string, string> } = {}): Recording[] {
  return [
    rec(`hf-resolve-${day}`, "GET", resolveUrl(pathOf(day)), 302, { location: cdnUrl(day) }),
    rec(`hf-cdn-${day}`, "GET", cdnUrl(day), o.status ?? 200, { "content-length": String(body.byteLength), ...o.headers }, o.status === undefined || o.status === 200 ? body : new Uint8Array(0)),
  ];
}

// ---------------------------------------------------------------- runs

interface Read {
  readonly result: RunResult;
  readonly written: readonly Written[];
  readonly requests: readonly RequestLog[];
}

interface Options {
  readonly recordings: readonly Recording[];
  readonly cursor?: Cursor;
  readonly now?: string;
  readonly limits?: Partial<Limits>;
  // Wraps the replay (a fetch that never answers one URL, say).
  readonly wrap?: (fetch: Fetch) => Fetch;
}

function ctxOf(o: Options, replay: ReturnType<typeof replayFetch>, writer: ReturnType<typeof memoryWriter>): AdapterContext {
  return Object.freeze({ fetch: o.wrap?.(replay.fetch) ?? replay.fetch, connect: noConnect, psl: PSL, now: o.now ?? "2026-11-01T00:30:00Z", userAgent: UA, writer });
}

function hold(result: RunResult, writer: ReturnType<typeof memoryWriter>, replay: ReturnType<typeof replayFetch>, what: string): Read {
  const checked = checkResult(result, what);
  checkSources(checked.segments, SOURCES, what, checked.gaps ?? []);
  assert.deepEqual(
    checked.segments,
    writer.written.map((w) => w.segment),
    "the segments returned are the segments written",
  );
  assert.deepEqual(replay.misses, [], "every request is answered by a recording");
  assert.ok(
    replay.requests.every((r) => r.userAgent === UA),
    "every request sends ctx.userAgent",
  );
  return { result: checked, written: writer.written, requests: replay.requests };
}

async function live(o: Options): Promise<Read> {
  const replay = replayFetch(o.recordings);
  const writer = memoryWriter({ sources: SOURCES });
  const result = await makeRun({ ...LIMITS, ...o.limits }, HOSTS)(o.cursor === undefined ? { next: DAY, open: [] } : o.cursor, ctxOf(o, replay, writer));
  return hold(result, writer, replay, "thc-ct live test");
}

async function backfill(o: Options & { readonly from: string; readonly to: string }): Promise<Read> {
  const replay = replayFetch(o.recordings);
  const writer = memoryWriter({ sources: SOURCES });
  const result = await makeBackfill({ ...LIMITS, ...o.limits }, HOSTS)({ start: `${o.from}T00:00:00Z`, end: `${o.to}T00:00:00Z` }, ctxOf(o, replay, writer));
  return hold(result, writer, replay, "thc-ct backfill test");
}

const codes = (r: Read): string[] => r.result.errors.map((e) => e.code);
const asked = (r: Read): string[] => r.requests.map((q) => `${q.method} ${q.url}`);
const recordsOf = (r: Read, dataset: string): Written["records"] => r.written.find((w) => w.segment.dataset === dataset)!.records;

// The oracle of a body's lines: each kept name's key and flags, each refusal by code.
function oracle(lines: readonly string[]): { names: Map<string, number>; regs: Set<string>; refused: Map<string, number> } {
  const names = new Map<string, number>();
  const refused = new Map<string, number>();
  for (const line of lines) {
    const n = normalise(line, PSL);
    if ("refused" in n) refused.set(n.refused, (refused.get(n.refused) ?? 0) + 1);
    else names.set(key(n.name), (names.get(key(n.name)) ?? 0) | (n.wild ? 2 : 1));
  }
  const regs = new Set([...names.keys()].map((k) => key(split(k.split(".").reverse().join("."), PSL).reg!)));
  return { names, regs, refused };
}

// ---------------------------------------------------------------- the source

test("thc-ct: SOURCE, BIT and the hosts are source.json's; the limits are the writer's file bound and the compaction's wait", () => {
  assert.deepEqual(
    SOURCES.map((s) => [s.id, s.bit, s.precision, s.datasets]),
    [[SOURCE, BIT, "day", ["names", "domains"]]],
  );
  const urls = SOURCES[0]!.urls;
  assert.ok(HOSTS.cs2.startsWith(urls[0]!), HOSTS.cs2);
  assert.ok(HOSTS.resolve.startsWith(`${urls[1]!}/`), HOSTS.resolve);
  assert.equal(LIMITS.maxFileBytes, FILE_RAW_BYTES);
  // The day is late when the daily compaction stops waiting for it: D+1 06:00Z.
  const thc = EXPECTED.find((e) => e.source === SOURCE)!;
  assert.equal(thc.untilS, 86_400 + LIMITS.lateAfterS);
  assert.deepEqual([LIMITS.lateAfterS, LIMITS.gapAfterS, LIMITS.maxFilesPerRun, LIMITS.maxGetsPerRun, LIMITS.maxOpen, LIMITS.readDeadlineS, LIMITS.runKeys], [21_600, 129_600, 1, 2, 8, 900, 500_000]);
  assert.equal(dayIndex("2026-09-01"), 243);
  assert.equal(dayIndex(DAY), 303);
});

// ---------------------------------------------------------------- the slice (items 1 to 7)

test("thc-ct: the slice writes each distinct name once, its flags 1 for a plain line, 2 for a `*.` line and 3 for both, upper case folded into its twin", async () => {
  const r = await live({ recordings: SYNTH });
  assert.deepEqual(r.result.errors, []);
  const want = oracle(LINES);
  const names = recordsOf(r, "names");
  assert.deepEqual(
    names.map((x) => [x.key, x.flags]),
    [...want.names].sort(([a], [b]) => (a < b ? -1 : 1)),
  );
  assert.ok(names.every((x) => JSON.stringify(x.sources) === JSON.stringify([{ bit: 0, first: 303, last: 303 }])));
  // Each flag value occurs among the real lines alone.
  const real = oracle(LINES.filter((l) => !META.slice.synthetic_lines.includes(l)));
  for (const f of [1, 2, 3]) assert.ok([...real.names.values()].includes(f), `flags ${f}`);
  // The real upper-case line and its synthetic lower-case twin are one record, wildcard.
  const twin = META.slice.synthetic_lines[0]!;
  const upper = LINES.find((l) => /[A-Z]/.test(l) && l.toLowerCase() === twin)!;
  assert.ok(upper !== undefined && upper !== twin);
  const k = key(twin.slice(2));
  assert.deepEqual(
    names.filter((x) => x.key === k).map((x) => x.flags),
    [2],
  );
  assert.equal(r.result.stats.upper_lines, LINES.filter((l) => /[A-Z]/.test(l)).length);
  assert.equal(r.result.stats.wild_lines, LINES.filter((l) => l.startsWith("*.") && !("refused" in normalise(l, PSL))).length);
  assert.equal(r.result.stats.names, want.names.size);
});

test("thc-ct: a public suffix is refused as public-suffix, an address literal as numeric-tld, and the share of refused lines is a stat", async () => {
  const r = await live({ recordings: SYNTH });
  const want = oracle(LINES);
  assert.equal(r.result.stats["refused_public-suffix"], 1);
  assert.ok(LINES.includes("co.uk"));
  assert.equal(r.result.stats["refused_numeric-tld"], want.refused.get("numeric-tld"));
  assert.ok((want.refused.get("numeric-tld") ?? 0) > 0, "the slice holds an address literal");
  assert.equal(r.result.stats.refused_share, [...want.refused.values()].reduce((a, b) => a + b, 0) / LINES.length);
  assert.deepEqual(
    Object.keys(r.result.stats).filter((s) => s.startsWith("refused_") && s !== "refused_share"),
    [...want.refused.keys()].sort().map((c) => `refused_${c}`),
  );
});

test("thc-ct: an xn-- line keeps its key, a Unicode line takes its punycode key, and the trailing blank line is skipped and counted", async () => {
  const r = await live({ recordings: SYNTH });
  const keys = new Set(recordsOf(r, "names").map((x) => x.key));
  const xn = LINES.find((l) => /(^|\.)xn--/.test(l))!;
  assert.ok(keys.has(key(xn.toLowerCase().replace(/^\*\./, ""))), xn);
  assert.ok(LINES.includes("bücher.example"));
  assert.ok(keys.has("example.xn--bcher-kva"));
  assert.equal(r.result.stats.empty_lines, 1);
  assert.equal(r.result.stats.lines, LINES.length + 1);
  assert.equal(r.result.stats.crlf_lines, 0);
});

test("thc-ct: a CRLF line gives its name and counts crlf_lines; a carriage return inside a line is refused as charset", async () => {
  const body = gz(["crlf.example.com\r", "cr\rinside.example.com", "plain.example.com"]);
  const r = await live({ recordings: [...cs2Day(DAY, body), listing([])] });
  assert.deepEqual(r.result.errors, []);
  assert.deepEqual(
    recordsOf(r, "names").map((x) => x.key),
    ["com.example.crlf", "com.example.plain"],
  );
  assert.equal(r.result.stats.crlf_lines, 1);
  assert.equal(r.result.stats.refused_charset, 1);
  // A last line with no line feed after it is a line.
  const open = new Uint8Array(gzipSync(Buffer.from("a.example.com\nlast.example.com", "utf8")));
  const tail = await live({ recordings: [...cs2Day(DAY, open), listing([])] });
  assert.deepEqual(
    recordsOf(tail, "names").map((x) => x.key),
    ["com.example.a", "com.example.last"],
  );
  assert.equal(tail.result.stats.lines, 2);
});

test("thc-ct: a run writes one day: an open day that holds is written first, and next waits for the next run", async () => {
  const recordings = [...cs2Day("2026-10-30", GZ), ...SYNTH];
  const r = await live({ recordings, cursor: { next: DAY, open: ["2026-10-30"] }, now: "2026-11-01T00:30:00Z" });
  assert.deepEqual(r.result.errors, []);
  assert.deepEqual(
    r.written.map((w) => [w.segment.dataset, w.segment.window.start]),
    [
      ["names", "2026-10-30T00:00:00Z"],
      ["domains", "2026-10-30T00:00:00Z"],
    ],
  );
  assert.deepEqual(r.result.cursor, { next: DAY, open: [] });
  assert.ok(!asked(r).some((q) => q.includes(DAY)), "the next day is not asked");
  assert.deepEqual([r.result.stats.files, r.result.stats.gets, r.result.stats.late, r.result.stats.open], [1, 1, 0, 0]);
});

test("thc-ct: the domains segment holds each registrable domain once, with one ct-first evidence at the day's index", async () => {
  const r = await live({ recordings: SYNTH });
  const want = oracle(LINES);
  const domains = recordsOf(r, "domains");
  assert.deepEqual(
    domains.map((x) => x.key),
    [...want.regs].sort(),
  );
  for (const d of domains) {
    assert.equal(d.flags, 0);
    assert.deepEqual(d.sources, [{ bit: 0, first: 303, last: 303 }]);
    assert.deepEqual(d.evidence, [{ tier: 3, basis: BASIS["ct-first"], source: 0, at: 303, confidence: 0 }]);
  }
  assert.equal(r.result.stats.domains, want.regs.size);
});

test("thc-ct: the harness's three runs hold the contract: the same input writes the same bytes, and run 3 from run 1's cursor writes nothing", async () => {
  const h = await runAdapter({ run: makeRun(LIMITS, HOSTS) }, { recordings: SYNTH, psl: PSL, cursor: { next: DAY, open: [] }, now: "2026-11-01T00:30:00Z", userAgent: UA, sources: SOURCES });
  const bytesOf = (run: typeof h.first): string[] => run.written.map((w) => JSON.stringify([w.records, Buffer.from(w.raw!).toString("base64"), w.url]));
  assert.deepEqual(bytesOf(h.again), bytesOf(h.first));
  assert.deepEqual(h.first.result.cursor, { next: "2026-11-01", open: [] });
  assert.deepEqual(h.next.result.segments, []);
  assert.deepEqual(h.next.requests, [], "11-01 is ctx.now's own day: nothing is asked");
  // The two segments: the day's window, cursors { day } and { day + 1 }, the file as the raw layer of both.
  assert.deepEqual(
    h.first.result.segments.map((s) => [s.source, s.dataset, s.window.start, s.window.end, s.cursorBefore, s.cursorAfter, s.precision]),
    [
      [SOURCE, "names", `${DAY}T00:00:00Z`, "2026-11-01T00:00:00Z", { day: DAY }, { day: "2026-11-01" }, "day"],
      [SOURCE, "domains", `${DAY}T00:00:00Z`, "2026-11-01T00:00:00Z", { day: DAY }, { day: "2026-11-01" }, "day"],
    ],
  );
  for (const w of h.first.written) {
    assert.deepEqual(Buffer.from(w.raw!), Buffer.from(GZ));
    assert.equal(w.url, fileUrl(DAY));
  }
  assert.equal(gunzipSync(GZ).toString("utf8"), SLICE);
  assert.deepEqual(
    h.first.requests.map((q) => `${q.method} ${q.url}`),
    [`HEAD ${fileUrl(DAY)}`, `GET ${fileUrl(DAY)}`],
  );
  const st = h.first.result.stats;
  assert.deepEqual([st.files, st.bytes, st.from_cs2, st.from_hf, st.gets, st.late, st.open, st.host_faults], [1, META.slice.gzip_bytes, 1, 0, 1, 0, 0, 0]);
  // lag_s: now minus Last-Modified (Sun, 01 Nov 2026 00:05:02 GMT).
  assert.equal(st.lag_s, 25 * 60 - 2);
});

// ---------------------------------------------------------------- the hosts (items 8 and 9)

test("thc-ct: cs2's 404 reads the bucket at the listing's off-month path, through the resolve 302 to the CDN, and the url written is the resolve URL", async () => {
  const synth = SYNTH.filter((x) => !x.name.startsWith("cs2-"));
  const r = await live({ recordings: [cs2Absent(DAY), ...synth] });
  assert.deepEqual(r.result.errors, []);
  assert.equal(PATH, "2026/11/2026-10-31.txt.gz");
  assert.deepEqual(asked(r), [`HEAD ${fileUrl(DAY)}`, `GET ${HOSTS.listing}`, `GET ${resolveUrl(PATH)}`, `GET ${cdnUrl(DAY)}`]);
  assert.deepEqual(
    r.written.map((w) => w.url),
    [resolveUrl(PATH), resolveUrl(PATH)],
  );
  assert.deepEqual([r.result.stats.from_cs2, r.result.stats.from_hf], [0, 1]);
  assert.deepEqual(r.result.cursor, { next: "2026-11-01", open: [] });
});

// The bucket's answers of the slice, for the fallbacks below.
const BUCKET = [listing([{ day: DAY, size: GZ.byteLength }]), ...hfDay(DAY, GZ)];

test("thc-ct: a cs2 GET that answers 503, a body shorter than its length, a Content-Length other than the HEAD's or none, a corrupt gzip or no answer before the deadline each read the bucket in the same run, one write a dataset", async () => {
  const corrupt = Uint8Array.from(GZ);
  corrupt[Math.floor(corrupt.length / 2)]! ^= 0xff;
  const cases: [string, Options, string][] = [
    ["503", { recordings: [...cs2Day(DAY, GZ, { status: 503 }), ...BUCKET] }, "cs2"],
    ["short", { recordings: [...cs2Day(DAY, GZ.subarray(0, GZ.length - 100), { length: GZ.length }), ...BUCKET] }, "length"],
    // The GET's Content-Length is not the HEAD's size, though its body is: refused before the body is read.
    ["declared", { recordings: [cs2Day(DAY, GZ)[0]!, rec("cs2-get-declared", "GET", fileUrl(DAY), 200, { "content-length": String(GZ.byteLength + 1) }, GZ), ...BUCKET] }, "length"],
    // No Content-Length at all.
    ["undeclared", { recordings: [cs2Day(DAY, GZ)[0]!, rec("cs2-get-undeclared", "GET", fileUrl(DAY), 200, {}, GZ), ...BUCKET] }, "length"],
    ["corrupt", { recordings: [...cs2Day(DAY, corrupt), ...BUCKET] }, "gzip"],
    [
      "silent",
      {
        recordings: [...cs2Day(DAY, GZ), ...BUCKET],
        limits: { readDeadlineS: 0.05 },
        // cs2's GET never answers: only the deadline ends it.
        wrap: (f) => (input, init) =>
          (init?.method ?? "GET") === "GET" && String(input) === fileUrl(DAY)
            ? new Promise((_, reject) => init!.signal!.addEventListener("abort", () => reject(init!.signal!.reason)))
            : f(input, init),
      },
      "timeout",
    ],
  ];
  for (const [what, o, code] of cases) {
    const r = await live(o);
    assert.deepEqual(r.result.errors, [], `${what}: a day written from the second host is no fault`);
    assert.equal(r.written.length, 2, `${what}: one write a dataset`);
    assert.deepEqual(
      r.written.map((w) => w.url),
      [resolveUrl(PATH), resolveUrl(PATH)],
      what,
    );
    assert.deepEqual([r.result.stats.from_hf, r.result.stats.host_faults, r.result.stats.gets], [1, 1, 2], what);
    // The stats name why cs2 was passed over.
    assert.deepEqual(
      Object.entries(r.result.stats).filter(([k]) => k.startsWith("host_fault_")),
      [[`host_fault_${code}`, 1]],
      what,
    );
    assert.deepEqual(
      r.written.map((w) => Buffer.from(w.raw!).equals(Buffer.from(GZ))),
      [true, true],
      what,
    );
  }
});

test("thc-ct: both hosts failing give one fault a host, write nothing and keep the cursor; a listing that fails after cs2's 404 is a fault, never an absence", async () => {
  const both = await live({ recordings: [...cs2Day(DAY, GZ, { status: 503 }), listing([{ day: DAY, size: GZ.byteLength }]), ...hfDay(DAY, GZ, { status: 500 })] });
  assert.deepEqual(codes(both), ["cs2", "hf"]);
  assert.match(both.result.errors[0]!.detail, /^2026-10-31 cs2: GET https:\/\/cs2\.ip\.thc\.org\/2026-10-31\.txt\.gz answered 503$/);
  // The fault names the resolve URL the bytes were asked at, never the CDN URL it redirected to.
  assert.equal(both.result.errors[1]!.detail, `2026-10-31 hf: GET ${resolveUrl(PATH)} answered 500`);
  assert.deepEqual([both.result.segments, both.result.cursor, both.result.gaps], [[], { next: DAY, open: [] }, undefined]);
  // A listing of 503 after cs2's 404: hf faults, and the day is not absent.
  const down = await live({ recordings: [cs2Absent(DAY), rec("hf-listing", "GET", HOSTS.listing, 503)] });
  assert.deepEqual(codes(down), ["hf"]);
  assert.match(down.result.errors[0]!.detail, /answered 503/);
  assert.deepEqual(down.result.cursor, { next: DAY, open: [] });
  // Past the gap instant the faulted day is declared, with the listing's fault named.
  const gap = await live({ recordings: [cs2Absent(DAY), rec("hf-listing", "GET", HOSTS.listing, 503), cs2Absent("2026-11-01"), cs2Absent("2026-11-02")], now: "2026-11-02T12:00:00Z" });
  assert.deepEqual(codes(gap).slice(0, 2), ["hf", "gap"]);
  assert.match(gap.result.errors[1]!.detail, /hf faulted last with hf: GET .* answered 503; cs2 answered absent/);
});

// ---------------------------------------------------------------- lateness and gaps (items 10 and 11)

test("thc-ct: a day listed nowhere waits before D+1 06:00Z, goes to open at that second, and stays open until D+2 12:00Z, when it is a gap (THC's recorded answers of 2026-11-02)", async () => {
  const absent = META.absent;
  assert.equal(absent, "2026-11-02");
  assert.ok(REAL.every((x) => x.origin === "recorded"));
  const wait = await live({ recordings: REAL, cursor: { next: absent, open: [] }, now: "2026-11-03T05:59:59Z" });
  assert.deepEqual([wait.result.segments, wait.result.errors, wait.result.cursor, wait.result.gaps], [[], [], { next: absent, open: [] }, undefined]);
  assert.deepEqual(asked(wait), [`HEAD ${fileUrl(absent)}`, `GET ${HOSTS.listing}`]);
  assert.deepEqual([wait.result.stats.late, wait.result.stats.open, wait.result.stats.gets], [0, 0, 0]);
  const late = await live({ recordings: REAL, cursor: { next: absent, open: [] }, now: "2026-11-03T06:00:00Z" });
  assert.deepEqual([late.result.errors, late.result.cursor], [[], { next: "2026-11-03", open: [absent] }]);
  assert.deepEqual([late.result.stats.late, late.result.stats.open], [1, 1]);
  // A day later: 11-03 is late too (a synthetic 404 and the recorded listing, which lacks it).
  const more = [...REAL, cs2Absent("2026-11-03")];
  const open = await live({ recordings: more, cursor: { next: "2026-11-03", open: [absent] }, now: "2026-11-04T11:59:59Z" });
  assert.deepEqual([open.result.errors, open.result.cursor, open.result.gaps], [[], { next: "2026-11-04", open: [absent, "2026-11-03"] }, undefined]);
  const gap = await live({ recordings: more, cursor: { next: "2026-11-03", open: [absent] }, now: "2026-11-04T12:00:00Z" });
  assert.deepEqual(gap.result.gaps, [{ source: SOURCE, day: absent }]);
  assert.deepEqual(codes(gap), ["gap"]);
  assert.equal(
    gap.result.errors[0]!.detail,
    `2026-11-02: no file of the day was written by 2026-11-04T12:00:00Z, so the day is declared a gap: every host answered absent (HEAD ${fileUrl(absent)} answered 404; the bucket's listing (${META.listing.days} day files) does not name 2026-11-02)`,
  );
  assert.deepEqual(gap.result.cursor, { next: "2026-11-04", open: ["2026-11-03"] });
});

test("thc-ct: a day absent past its late instant goes to open and the next listed day is written in the same run; run 3 keeps the open day", async () => {
  const recordings = [cs2Absent("2026-10-30"), ...SYNTH];
  const r = await live({ recordings, cursor: { next: "2026-10-30", open: [] }, now: "2026-11-01T00:30:00Z" });
  assert.deepEqual(r.result.errors, []);
  assert.deepEqual(r.result.cursor, { next: "2026-11-01", open: ["2026-10-30"] });
  assert.equal(r.written.length, 2);
  // The harness's three runs: a declared-free run that moves the cursor, and run 3 writes nothing again.
  const h = await runAdapter({ run: makeRun(LIMITS, HOSTS) }, { recordings, psl: PSL, cursor: { next: "2026-10-30", open: [] }, now: "2026-11-01T00:30:00Z", userAgent: UA, sources: SOURCES });
  assert.deepEqual(h.next.result.cursor, { next: "2026-11-01", open: ["2026-10-30"] });
  assert.deepEqual(h.next.result.segments, []);
});

test("thc-ct: a day whose every host faults goes to open at D+1 06:00Z while the next day is written, and at D+2 12:00Z is a gap whose fault names both hosts", async () => {
  const corrupt = gz(["a.example.com"]).subarray(0, 12);
  const bad = [...cs2Day("2026-10-30", corrupt), ...hfDay("2026-10-30", corrupt)];
  const list = listing([
    { day: "2026-10-30", size: corrupt.byteLength },
    { day: DAY, size: GZ.byteLength },
  ]);
  const good = SYNTH.filter((x) => x.name.startsWith("cs2-"));
  const recordings = [...bad, list, ...good];
  // Two GETs for the faulted day and one for the next: a budget of 3.
  const open = await live({ recordings, cursor: { next: "2026-10-30", open: [] }, now: "2026-11-01T00:30:00Z", limits: { maxGetsPerRun: 3 } });
  assert.deepEqual(codes(open), ["gzip", "gzip"]);
  assert.deepEqual(
    open.result.errors.map((e) => e.detail.slice(0, 14)),
    ["2026-10-30 cs2", "2026-10-30 hf:"],
  );
  assert.deepEqual(open.result.cursor, { next: "2026-11-01", open: ["2026-10-30"] });
  assert.equal(open.written.length, 2);
  const gap = await live({ recordings, cursor: { next: DAY, open: ["2026-10-30"] }, now: "2026-11-01T12:00:00Z", limits: { maxGetsPerRun: 3 } });
  assert.deepEqual(codes(gap), ["gzip", "gzip", "gap"]);
  assert.deepEqual(gap.result.gaps, [{ source: SOURCE, day: "2026-10-30" }]);
  assert.match(gap.result.errors[2]!.detail, /declared a gap: cs2 faulted last with gzip: .*; hf faulted last with gzip: /);
  assert.deepEqual(gap.result.cursor, { next: "2026-11-01", open: [] });
  assert.equal(gap.written.length, 2);
});

// ---------------------------------------------------------------- the integrity faults (items 12 to 14)

test("thc-ct: a Content-Encoding, two gzip members and a located size over maxFileBytes on both hosts write nothing and keep the cursor", async () => {
  const two = new Uint8Array([...GZ, ...GZ]);
  for (const [what, recordings, limits, code] of [
    [
      "encoding",
      [...cs2Day(DAY, GZ, { headers: { "content-encoding": "gzip" } }), listing([{ day: DAY, size: GZ.byteLength }]), ...hfDay(DAY, GZ, { headers: { "content-encoding": "gzip" } })],
      {},
      "encoding",
    ],
    ["members", [...cs2Day(DAY, two), listing([{ day: DAY, size: two.byteLength }]), ...hfDay(DAY, two)], {}, "gzip"],
    ["size", [cs2Day(DAY, GZ)[0]!, listing([{ day: DAY, size: GZ.byteLength }])], { maxFileBytes: GZ.byteLength - 1 }, "size"],
  ] as [string, Recording[], Partial<Limits>, string][]) {
    const r = await live({ recordings, limits });
    assert.deepEqual(codes(r), [code, code], what);
    assert.deepEqual([r.result.segments, r.result.cursor], [[], { next: DAY, open: [] }], what);
    if (code === "size") assert.ok(!asked(r).some((q) => q.startsWith("GET https://cs2") || q.includes("resolve")), "a size over the bound reads no body");
  }
});

test("thc-ct: a valid empty gzip is empty, a CSV column is format, and 2% refused lines write the day with the share as a stat", async () => {
  const noBucket = listing([]);
  const empty = await live({ recordings: [...cs2Day(DAY, new Uint8Array(gzipSync(Buffer.alloc(0)))), noBucket] });
  assert.deepEqual(codes(empty), ["empty"]);
  assert.equal(gzipSync(Buffer.alloc(0)).length, 20);
  const csv = await live({ recordings: [...cs2Day(DAY, gz(LINES.slice(0, 200).map((l) => `${l},2026-10-31`))), noBucket] });
  assert.deepEqual(codes(csv), ["format"]);
  assert.match(csv.result.errors[0]!.detail, /200 of 200 non-empty lines are refused \(charset 200\), over 0\.5 of them/);
  const good = LINES.filter((l) => !("refused" in normalise(l, PSL))).slice(0, 980);
  const some = await live({ recordings: [...cs2Day(DAY, gz([...good, ...Array.from({ length: 20 }, (_, i) => `bad name${i}.example`)])), noBucket] });
  assert.deepEqual(some.result.errors, []);
  assert.equal(some.result.stats.refused_share, 0.02);
  assert.equal(some.result.stats.refused_charset, 20);
  assert.equal(some.written.length, 2);
});

test("thc-ct: an open day that faults on both hosts spends the run's two GETs, and next waits for the next run", async () => {
  const corrupt = gz(["a.example.com"]).subarray(0, 12);
  const recordings = [...cs2Day("2026-10-30", corrupt), listing([{ day: "2026-10-30", size: corrupt.byteLength }]), ...hfDay("2026-10-30", corrupt), ...SYNTH.filter((x) => x.name.startsWith("cs2-"))];
  const r = await live({ recordings, cursor: { next: DAY, open: ["2026-10-30"] }, now: "2026-11-01T00:30:00Z" });
  assert.deepEqual(codes(r), ["gzip", "gzip"]);
  assert.deepEqual(r.result.cursor, { next: DAY, open: ["2026-10-30"] });
  assert.ok(!asked(r).some((q) => q.includes(DAY)), "the next day is not asked");
  assert.deepEqual([r.result.stats.gets, r.result.stats.open, r.result.stats.late], [2, 1, 1]);
});

test("thc-ct: a candidate left untried for want of a GET stops the run with no late or gap decision", async () => {
  const corrupt = gz(["a.example.com"]).subarray(0, 12);
  const recordings = [...cs2Day("2026-10-30", corrupt), listing([{ day: "2026-10-30", size: corrupt.byteLength }]), ...hfDay("2026-10-30", corrupt)];
  const r = await live({ recordings, cursor: { next: "2026-10-30", open: [] }, now: "2026-11-02T00:30:00Z", limits: { maxGetsPerRun: 1 } });
  assert.deepEqual(codes(r), ["gzip"]);
  // Past its gap instant, and still no gap: the bucket holds a candidate the run could not read.
  assert.deepEqual([r.result.cursor, r.result.gaps], [{ next: "2026-10-30", open: [] }, undefined]);
  assert.ok(asked(r).includes(`GET ${HOSTS.listing}`), "the bucket is located");
  assert.ok(!asked(r).some((q) => q.includes("/resolve/")), "its body is not read: no GET is left for it");
});

test("thc-ct: a late next day while open holds maxOpen days is the fault open-full, and the cursor stays valid", async () => {
  const opens = ["2026-10-20", "2026-10-21"];
  const recordings = [...opens.map(cs2Absent), cs2Absent("2026-10-30"), listing([])];
  const r = await live({ recordings, cursor: { next: "2026-10-30", open: opens }, now: "2026-10-31T06:00:00Z", limits: { maxOpen: 2, gapAfterS: 10_000_000 } });
  assert.deepEqual(codes(r), ["open-full"]);
  assert.deepEqual(r.result.cursor, { next: "2026-10-30", open: opens });
});

// ---------------------------------------------------------------- the backfill (item 15)

test("thc-ct: a backfill of two days, one listed and one past its gap time, writes two segments from the bucket and one gap, and returns the cursor null", async () => {
  const recordings = [...SYNTH.filter((x) => !x.name.startsWith("cs2-")), cs2Absent("2026-10-30")];
  const r = await backfill({ recordings, from: "2026-10-30", to: "2026-11-01", now: "2026-11-01T12:00:00Z" });
  assert.deepEqual(r.result.gaps, [{ source: SOURCE, day: "2026-10-30" }]);
  assert.deepEqual(codes(r), ["gap"]);
  assert.equal(r.result.cursor, null);
  assert.deepEqual(
    r.written.map((w) => [w.segment.dataset, w.segment.window.start, w.url]),
    [
      ["names", `${DAY}T00:00:00Z`, resolveUrl(PATH)],
      ["domains", `${DAY}T00:00:00Z`, resolveUrl(PATH)],
    ],
  );
  // The bucket first: the listing is read before any HEAD.
  assert.equal(asked(r)[0], `GET ${HOSTS.listing}`);
  assert.deepEqual([r.result.stats.days, r.result.stats.from_hf, r.result.stats.gets], [2, 1, 1]);
  // Before its gap time, an unpublished day is the fault unpublished, and no gap.
  const early = await backfill({ recordings, from: "2026-10-30", to: "2026-10-31", now: "2026-11-01T11:59:59Z" });
  assert.deepEqual([codes(early), early.result.gaps], [["unpublished"], undefined]);
  // The same segments as the live run's: one identity a day, whichever run wrote it.
  const l = await live({ recordings: SYNTH });
  assert.deepEqual(
    r.result.segments.map((s) => s.sha256),
    l.result.segments.map((s) => s.sha256),
  );
});

test("thc-ct: a backfill window that is not whole days, or holds more than 366 days, is refused", () => {
  assert.deepEqual(daysOf({ start: "2026-10-30T00:00:00Z", end: "2026-11-01T00:00:00Z" }), ["2026-10-30", "2026-10-31"]);
  for (const w of [
    { start: "2026-10-30T06:00:00Z", end: "2026-10-31T00:00:00Z" },
    { start: "2026-10-30T00:00:00Z", end: "2026-10-30T00:00:00Z" },
    { start: "2026-10-31T00:00:00Z", end: "2026-10-30T00:00:00Z" },
    { start: "2025-12-31T00:00:00Z", end: "2026-01-02T00:00:00Z" },
    { start: "2026-01-01T00:00:00Z", end: "2027-01-03T00:00:00Z" },
  ])
    assert.throws(() => daysOf(w), RangeError, JSON.stringify(w));
});

// ---------------------------------------------------------------- the cursor (item 16)

test("thc-ct: the cursor null starts at the day before ctx.now's; a cursor of another shape, unsorted or over maxOpen days is ContractError cursor", () => {
  assert.deepEqual(parseCursor(null, "2026-11-01T00:30:00Z", LIMITS), { next: DAY, open: [] });
  assert.deepEqual(parseCursor({ next: DAY, open: ["2026-10-29", "2026-10-30"] }, "2026-11-01T00:30:00Z", LIMITS), { next: DAY, open: ["2026-10-29", "2026-10-30"] });
  for (const c of [
    {},
    { next: DAY },
    { next: DAY, open: [], x: 1 },
    { next: "2026-02-30", open: [] },
    { next: "2025-12-31", open: [] },
    { next: DAY, open: "2026-10-30" },
    { next: DAY, open: [DAY] },
    { next: DAY, open: ["2026-10-30", "2026-10-29"] },
    { next: DAY, open: ["2026-10-30", "2026-10-30"] },
    { next: DAY, open: Array.from({ length: 9 }, (_, i) => `2026-10-${String(10 + i).padStart(2, "0")}`) },
    [DAY],
    "2026-10-31",
  ] as Cursor[])
    assert.throws(
      () => parseCursor(c, "2026-11-01T00:30:00Z", LIMITS),
      (e) => e instanceof ContractError && e.check === "cursor",
      JSON.stringify(c),
    );
});

test("thc-ct: the limits and the hosts are held when the run is made", () => {
  for (const bad of [{ runKeys: 0 }, { maxGetsPerRun: 1.5 }, { readDeadlineS: 0 }, { refusedFault: 1.5 }, { gapAfterS: 21_600 }] as Partial<Limits>[])
    assert.throws(() => makeRun({ ...LIMITS, ...bad }, HOSTS), TypeError, JSON.stringify(bad));
  assert.throws(() => makeRun(LIMITS, { ...HOSTS, cs2: "https://cs2.ip.thc.org" }), /does not end in "\/"/);
  assert.throws(() => makeBackfill(LIMITS, { ...HOSTS, listing: "not a url" }), /is not a URL/);
});

// ---------------------------------------------------------------- the readers of THC's recorded answers

test("thc-ct: the recorded listing names 60 day files from 2026-09-01, 2026-10-31 at its upload month's path, and the recorded index 30 from 2026-10-01", async () => {
  const replay = replayFetch(REAL);
  const l = await readListing(replay.fetch, HOSTS.listing, UA, LIMITS);
  assert.deepEqual([l.size, [...l.keys()].sort()[0], [...l.keys()].sort().at(-1)], [META.listing.days, META.listing.first, META.listing.last]);
  assert.equal(
    [...l.values()].reduce((n, e) => n + e.size, 0),
    META.listing.bytes,
  );
  assert.deepEqual(l.get(DAY), { day: DAY, path: "2026/11/2026-10-31.txt.gz", size: 324_537_041, mtime: "2026-11-01T00:05:02Z" });
  assert.ok(!l.has("2026-10-04") && !l.has("2026-10-09"));
  const index = cs2Index(new TextDecoder().decode(REAL.find((x) => x.name === "cs2-index.http.json")!.response.body));
  assert.deepEqual([index.size, [...index.keys()].sort()[0]], [META.index.days, "2026-10-01"]);
  assert.deepEqual(index.get(DAY), { bytes: 324_537_041, listed: "2026-11-01T00:05:00Z" });
  // cs2's HEAD of the day: the candidate, its size and Last-Modified.
  const loc = new Locator({ fetch: replay.fetch, connect: noConnect, psl: PSL, now: "2026-11-02T04:30:00Z", userAgent: UA, writer: memoryWriter() }, HOSTS, LIMITS);
  assert.deepEqual(await loc.cs2(DAY), { found: { host: "cs2", url: fileUrl(DAY), bytes: 324_537_041, lastModified: "2026-11-01T00:05:02Z" } });
  assert.deepEqual(await loc.cs2(META.absent), { absent: "cs2", detail: `HEAD ${fileUrl(META.absent)} answered 404` });
});

test("thc-ct: the listing follows Link rel=next on its origin, and a page off it, past maxListingPages, not JSON, or naming a day twice is a fault", async () => {
  const page = (url: string, entries: unknown, link?: string): Recording =>
    rec(
      url,
      "GET",
      url,
      200,
      { "content-type": "application/json", ...(link === undefined ? {} : { link }) },
      new TextEncoder().encode(typeof entries === "string" ? entries : JSON.stringify(entries)),
    );
  const p2 = `${HOSTS.listing}&cursor=2`;
  const e = (day: string, size = 1): object => ({ type: "file", path: `2026/10/${day}.txt.gz`, size });
  const two = [page(HOSTS.listing, [e("2026-10-30"), { type: "directory", path: "2026/10" }, { type: "file", path: "README.md", size: 3 }], `<${p2}>; rel="next"`), page(p2, [e(DAY)])];
  const l = await readListing(replayFetch(two).fetch, HOSTS.listing, UA, LIMITS);
  assert.deepEqual([...l.keys()], ["2026-10-30", DAY]);
  const fault = async (recordings: Recording[], why: RegExp, limits = LIMITS): Promise<void> => {
    await assert.rejects(readListing(replayFetch(recordings).fetch, HOSTS.listing, UA, limits), (err: Error) => err.name === "HostFault" && why.test(err.message));
  };
  await fault(two, /has more than 1 pages/, { ...LIMITS, maxListingPages: 1 });
  await fault([page(HOSTS.listing, [], '<https://evil.example/next>; rel="next"')], /off the listing's origin https:\/\/huggingface\.co/);
  await fault([page(HOSTS.listing, "<html>")], /the page is not JSON/);
  await fault([page(HOSTS.listing, { files: [] })], /the page is not a JSON list/);
  await fault([page(HOSTS.listing, [e(DAY), { ...e(DAY), path: `2026/11/${DAY}.txt.gz` }])], /names 2026-10-31 twice, at 2026\/10\/2026-10-31\.txt\.gz and 2026\/11\/2026-10-31\.txt\.gz/);
  await fault([page(HOSTS.listing, [e(DAY, -1)])], /has the size -1, not a whole number/);
  await fault([page(HOSTS.listing, [e("2026-02-30")])], /names no calendar day/);
  assert.equal(nextLink('<https://a/x>; rel="prev", <https://a/y>; rel="next"'), "https://a/y");
  assert.equal(nextLink('<https://a/x>; rel="prev"'), null);
  assert.equal(nextLink(null), null);
});

test("thc-ct: cs2's index refuses a day file line it cannot read, a day listed twice and a date that does not exist", () => {
  const line = (day: string, when: string, size: string): string => `<a href="${day}.txt.gz">${day}.txt.gz</a>                                  ${when}           ${size}`;
  assert.deepEqual([...cs2Index([line(DAY, "01-Nov-2026 00:05", "7"), '<a href="RDNS/">RDNS/</a>   15-Mar-2026 07:53   -'].join("\n"))], [[DAY, { bytes: 7, listed: "2026-11-01T00:05:00Z" }]]);
  for (const [html, why] of [
    [line(DAY, "01-Nov-2026 00:05", "-"), /in a shape not read/],
    [[line(DAY, "01-Nov-2026 00:05", "7"), line(DAY, "01-Nov-2026 00:05", "7")].join("\n"), /lists 2026-10-31 twice/],
    [line(DAY, "31-Sep-2026 00:05", "7"), /not a calendar day and time/],
    [line(DAY, "01-Nov-2026 24:05", "7"), /not a calendar day and time/],
  ] as [string, RegExp][])
    assert.throws(() => cs2Index(html), why, html);
});

test("thc-ct: every request asks for the file's own bytes: HEAD and GET send Accept-Encoding identity", async () => {
  const seen: [string, string | null][] = [];
  await live({
    recordings: [cs2Absent(DAY), ...SYNTH.filter((x) => !x.name.startsWith("cs2-"))],
    wrap: (f) => (input, init) => {
      seen.push([`${init?.method ?? "GET"} ${String(input)}`, new Headers(init?.headers).get("accept-encoding")]);
      return f(input, init);
    },
  });
  assert.deepEqual(seen, [
    [`HEAD ${fileUrl(DAY)}`, "identity"],
    [`GET ${HOSTS.listing}`, null],
    [`GET ${resolveUrl(PATH)}`, "identity"],
  ]);
});
