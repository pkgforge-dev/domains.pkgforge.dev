// scripts/ingest/fixtures/adapters/fixture-stream/src/index.ts — a synthetic
// stream adapter for the tests of scripts/ingest/run.mjs (DOM-024). No real
// source and no real host: stream.example.test is a reserved name, and its
// answers are the synthetic recordings beside this directory. It borrows the
// id and bit of oi-cs (config/source-bits.json), a second-precision source of
// names and domains, so that the verifier's registry check passes; it is not
// the oi-cs adapter (DOM-036).
//
// The stream is cut into windows of ten minutes from FIRST_WINDOW: window N
// is https://stream.example.test/window/N.txt, one line a name, `SECONDS NAME`,
// SECONDS from the window's start. The cursor is { next: N }, the first window
// not yet read (null before the first run). A run reads each window that has
// ended by ctx.now, and stops at the first 404 (not yet published). Each window
// writes a names segment and a domains segment, the domain of a name being its
// last two labels (the fixture's names are all under com, net or org), and
// hands both writes the window's bytes as its raw input.
//
// backfill({ start, end }) writes the windows that lie inside [start, end)
// and moves no cursor (D17 of DOM-024).
import type { AdapterContext, Cursor, RunResult, Segment, SegmentRecord, Window } from "@domains/adapter";

export const SOURCE = "oi-cs";
export const BIT = 4;
export const BASE = "https://stream.example.test/window/";
export const FIRST_WINDOW = Date.parse("2026-10-30T08:00:00Z");
export const WINDOW_MS = 600_000;
const EPOCH_MS = Date.UTC(2026, 0, 1);

const iso = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const reversed = (name: string): string => name.split(".").reverse().join(".");

interface Seen {
  readonly key: string;
  readonly at: number;
}

// The names of one window's text, each with its time in seconds since
// 2026-01-01, as keys: the first sighting of each, sorted.
function sightings(text: string, startMs: number): Seen[] {
  const first = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const [offset, name] = line.split(" ");
    const at = (startMs - EPOCH_MS) / 1000 + Number(offset);
    const key = reversed(name as string);
    if (!first.has(key) || (first.get(key) as number) > at) first.set(key, at);
  }
  return [...first.entries()].map(([key, at]) => ({ key, at })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

function namesOf(seen: readonly Seen[]): SegmentRecord[] {
  return seen.map((s) => ({ key: s.key, flags: 1, sources: [{ bit: BIT, first: s.at, last: s.at }] }));
}

// The domains of the names: the first two labels of a key, its earliest and latest sighting.
function domainsOf(seen: readonly Seen[]): SegmentRecord[] {
  const span = new Map<string, { first: number; last: number }>();
  for (const s of seen) {
    const key = s.key.split(".").slice(0, 2).join(".");
    const was = span.get(key);
    span.set(key, was === undefined ? { first: s.at, last: s.at } : { first: Math.min(was.first, s.at), last: Math.max(was.last, s.at) });
  }
  return [...span.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, t]) => ({ key, flags: 0, sources: [{ bit: BIT, first: t.first, last: t.last }], evidence: [] }));
}

// The window N, read and written as two segments, or null when it is not published.
async function readWindow(n: number, before: Cursor, after: Cursor, ctx: AdapterContext): Promise<Segment[] | null> {
  const res = await ctx.fetch(`${BASE}${n}.txt`, { headers: { "user-agent": ctx.userAgent } });
  if (res.status === 404) {
    await res.body?.cancel();
    return null;
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const startMs = FIRST_WINDOW + n * WINDOW_MS;
  const window: Window = { start: iso(startMs), end: iso(startMs + WINDOW_MS) };
  const seen = sightings(new TextDecoder().decode(bytes), startMs);
  const draft = { source: SOURCE, window, cursorBefore: before, cursorAfter: after, precision: "second" as const };
  const names = await ctx.writer.write({ ...draft, dataset: "names" }, namesOf(seen), bytes);
  const domains = await ctx.writer.write({ ...draft, dataset: "domains" }, domainsOf(seen), bytes);
  return [names, domains];
}

export async function run(cursor: Cursor, ctx: AdapterContext): Promise<RunResult> {
  let next = cursor === null ? 0 : (cursor as { next: number }).next;
  const segments: Segment[] = [];
  const now = Date.parse(ctx.now);
  while (FIRST_WINDOW + (next + 1) * WINDOW_MS <= now) {
    const written = await readWindow(next, { next }, { next: next + 1 }, ctx);
    if (written === null) break;
    segments.push(...written);
    next += 1;
  }
  return { segments, cursor: { next }, stats: { windows: segments.length / 2 }, errors: [] };
}

export async function backfill(window: Window, ctx: AdapterContext): Promise<RunResult> {
  const segments: Segment[] = [];
  const from = Math.ceil((Date.parse(window.start) - FIRST_WINDOW) / WINDOW_MS);
  for (let n = Math.max(0, from); FIRST_WINDOW + (n + 1) * WINDOW_MS <= Date.parse(window.end); n++) {
    const written = await readWindow(n, { next: n }, { next: n + 1 }, ctx);
    if (written === null) break;
    segments.push(...written);
  }
  return { segments, cursor: null, stats: { windows: segments.length / 2 }, errors: [] };
}
