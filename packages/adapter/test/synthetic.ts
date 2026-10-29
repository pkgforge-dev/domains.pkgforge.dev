// packages/adapter/test/synthetic.ts — synthetic adapters for the harness tests:
// no real source, no real host (feed.example.test is a reserved name). They live
// beside the tests, not in fixtures/, so the linter reads them. Each takes a
// `plant`, which puts one fault into an otherwise correct adapter, so a test of
// a refusal plants exactly the fault its own check catches.
//
// dayAdapter: one file a day, https://feed.example.test/YYYY-MM-DD.txt, one name
// a line. The cursor is { last_day }. A run reads each day after last_day and
// before the day of ctx.now, and stops at the first 404 (not yet published).
// fileAdapter: one file read with a conditional GET. The cursor is { etag }.
// https://feed.example.test/latest.txt redirects to the dated file; a request
// that sends If-None-Match with the stored ETag gets 304 and writes nothing.
import type { AdapterContext, AdapterFault, AdapterModule, Cursor, RunResult, Segment, SegmentRecord } from "../src/types.ts";

export const BASE = "https://feed.example.test/";
export const DAY_SOURCE = "example-day";
export const FILE_SOURCE = "example-file";

export type DayPlant =
  | "none"
  | "extra-url"
  | "extra-url-caught"
  | "nondeterministic"
  | "global-fetch"
  | "no-user-agent"
  | "own-user-agent"
  | "stuck-cursor"
  | "rewind-cursor"
  | "unreported"
  | "other-source"
  | "throws"
  | "big-cursor"
  | "cursor-differs"
  | "network-globals"
  | "mutate-cursor"
  | "assign-ctx"
  | "bad-stats"
  | "nan-stats"
  | "infinite-stats"
  | "bad-errors";

// What the "network-globals" plant opens, each in its own try: the globals the
// harness traps beside fetch. XMLHttpRequest takes its URL in open(), not here.
export const NETWORK_OPENS: readonly (readonly [string, string | undefined])[] = [
  ["WebSocket", "wss://feed.example.test/ws"],
  ["XMLHttpRequest", undefined],
  ["EventSource", "https://feed.example.test/events"],
];

const DAY_MS = 86_400_000;
const dayAfter = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const reversed = (name: string): string => name.split(".").reverse().join(".");

// One key a distinct name, sorted.
function keysOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split("\n")
        .filter((l) => l !== "")
        .map(reversed),
    ),
  ].sort();
}

export function dayAdapter(plant: DayPlant = "none"): AdapterModule {
  let calls = 0;
  return {
    async run(cursor: Cursor, ctx: AdapterContext) {
      calls += 1;
      const start = (cursor as { last_day: string }).last_day;
      const headers: Record<string, string> = plant === "no-user-agent" ? {} : { "user-agent": plant === "own-user-agent" ? "domains.pkgforge.dev/1.0 (a constant of its own)" : ctx.userAgent };
      const get = (url: string): Promise<Response> => (plant === "global-fetch" ? globalThis.fetch(url, { headers }) : ctx.fetch(url, { headers }));
      const errors: AdapterFault[] = [];
      if (plant === "throws") throw new Error("planted: the adapter throws");
      if (plant === "assign-ctx") {
        // A frozen ctx refuses this in strict code, as every module is.
        const own = ctx.fetch;
        (ctx as { fetch: AdapterContext["fetch"] }).fetch = (input, init) => own(input, init);
      }
      if (plant === "network-globals") {
        const g = globalThis as unknown as Record<string, new (url?: string) => unknown>;
        for (const [name, url] of NETWORK_OPENS) {
          try {
            new g[name]!(url);
          } catch (err) {
            errors.push({ source: DAY_SOURCE, code: "socket", detail: (err as Error).message });
          }
        }
      }
      if (plant === "extra-url") await get(`${BASE}robots.txt`);
      if (plant === "extra-url-caught") {
        try {
          await get(`${BASE}robots.txt`);
        } catch (err) {
          errors.push({ source: DAY_SOURCE, code: "fetch", detail: (err as Error).message });
        }
      }
      const segments: Segment[] = [];
      const today = ctx.now.slice(0, 10);
      let last = start;
      while (dayAfter(last) < today) {
        const day = dayAfter(last);
        const res = await get(`${BASE}${day}.txt`);
        if (res.status === 404) {
          await res.body?.cancel();
          break;
        }
        const text = await res.text();
        const records = keysOf(text).map((key): SegmentRecord => (plant === "nondeterministic" ? { key, run: calls } : { key }));
        const after = plant === "stuck-cursor" ? { last_day: start } : { last_day: day };
        const seg = await ctx.writer.write(
          {
            source: plant === "other-source" ? "example-other" : DAY_SOURCE,
            dataset: "names",
            window: { start: `${day}T00:00:00Z`, end: `${dayAfter(day)}T00:00:00Z` },
            cursorBefore: { last_day: last },
            cursorAfter: after,
            precision: "day",
          },
          records,
          new TextEncoder().encode(text),
        );
        segments.push(seg);
        last = day;
      }
      let next: Cursor = { last_day: last };
      if (plant === "stuck-cursor") next = { last_day: start };
      // Moves past the first day written, but not past the last.
      if (plant === "rewind-cursor" && segments.length > 0) next = segments.at(-1)!.cursorBefore;
      if (plant === "big-cursor") next = { last_day: last, pad: "x".repeat(5000) };
      if (plant === "cursor-differs") next = { last_day: last, run: calls };
      // Moves the cursor it was given; the harness hands each run its own copy.
      if (plant === "mutate-cursor") (cursor as { last_day: string }).last_day = last;
      if (plant === "bad-errors") errors.push({} as AdapterFault);
      const stats =
        plant === "bad-stats"
          ? ({ days: "two" } as unknown as Record<string, number>)
          : plant === "nan-stats"
            ? { days: Number.NaN }
            : plant === "infinite-stats"
              ? { days: Number.POSITIVE_INFINITY }
              : { days: segments.length };
      return { segments: plant === "unreported" ? [] : segments, cursor: next, stats, errors };
    },
  };
}

export function fileAdapter(): AdapterModule {
  return {
    async run(cursor: Cursor, ctx: AdapterContext): Promise<RunResult> {
      const etag = (cursor as { etag: string | null }).etag;
      const headers: Record<string, string> = { "user-agent": ctx.userAgent };
      if (etag !== null) headers["if-none-match"] = etag;
      const res = await ctx.fetch(`${BASE}latest.txt`, { headers });
      if (res.status === 304) return { segments: [], cursor, stats: { unchanged: 1 }, errors: [] };
      const text = await res.text();
      // The dated file the redirect named: .../files/YYYY-MM-DD.txt.
      const day = new URL(res.url).pathname.slice(-14, -4);
      const seg = await ctx.writer.write(
        {
          source: FILE_SOURCE,
          dataset: "names",
          window: { start: `${day}T00:00:00Z`, end: `${dayAfter(day)}T00:00:00Z` },
          cursorBefore: cursor,
          cursorAfter: { etag: res.headers.get("etag") },
          precision: "day",
        },
        keysOf(text).map((key) => ({ key })),
      );
      return { segments: [seg], cursor: { etag: res.headers.get("etag") }, stats: { redirected: res.redirected ? 1 : 0 }, errors: [] };
    },
  };
}
