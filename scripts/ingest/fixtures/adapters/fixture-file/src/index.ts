// scripts/ingest/fixtures/adapters/fixture-file/src/index.ts — a synthetic
// day-file adapter for the tests of scripts/ingest/run.mjs (DOM-024). No real
// source and no real host: files.example.test is a reserved name, and its
// answers are the synthetic recordings beside this directory. It borrows the
// id and bit of isc-new (config/source-bits.json), a day source of domains,
// so that the verifier's registry check passes; it is not the isc-new adapter
// (DOM-027).
//
// One file a day, https://files.example.test/YYYY-MM-DD.txt, one domain a
// line. The cursor is { last_day } (null before the first run, which starts
// after FIRST_DAY's eve). A run reads each day after last_day and before the
// day of ctx.now, and stops at the first 404 (not yet published). Each day
// writes one domains segment, the file its raw bytes (a file source: its tag
// names the file's hash, and the file is the segment's own layer `raw`).
import type { AdapterContext, Cursor, RunResult, Segment, SegmentRecord } from "@domains/adapter";

export const SOURCE = "isc-new";
export const BIT = 8;
export const BASE = "https://files.example.test/";
export const FIRST_DAY = "2026-10-28";
const DAY_MS = 86_400_000;
const EPOCH_MS = Date.UTC(2026, 0, 1);

const dayAfter = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);
const dayBefore = (d: string): string => new Date(Date.parse(`${d}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
const reversed = (name: string): string => name.split(".").reverse().join(".");

// One record a distinct domain, sorted, seen on day number `dayNo` since 2026-01-01.
function recordsOf(text: string, dayNo: number): SegmentRecord[] {
  const keys = [
    ...new Set(
      text
        .split("\n")
        .filter((l) => l !== "")
        .map(reversed),
    ),
  ].sort();
  return keys.map((key) => ({ key, flags: 0, sources: [{ bit: BIT, first: dayNo, last: dayNo }], evidence: [] }));
}

export async function run(cursor: Cursor, ctx: AdapterContext): Promise<RunResult> {
  const start = cursor === null ? dayBefore(FIRST_DAY) : (cursor as { last_day: string }).last_day;
  const today = ctx.now.slice(0, 10);
  const segments: Segment[] = [];
  let last = start;
  while (dayAfter(last) < today) {
    const day = dayAfter(last);
    const res = await ctx.fetch(`${BASE}${day}.txt`, { headers: { "user-agent": ctx.userAgent } });
    if (res.status === 404) {
      await res.body?.cancel();
      break;
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    const dayNo = (Date.parse(`${day}T00:00:00Z`) - EPOCH_MS) / DAY_MS;
    const seg = await ctx.writer.write(
      {
        source: SOURCE,
        dataset: "domains",
        window: { start: `${day}T00:00:00Z`, end: `${dayAfter(day)}T00:00:00Z` },
        cursorBefore: cursor === null && last === start ? null : { last_day: last },
        cursorAfter: { last_day: day },
        precision: "day",
      },
      recordsOf(new TextDecoder().decode(bytes), dayNo),
      bytes,
    );
    segments.push(seg);
    last = day;
  }
  return { segments, cursor: last === start && cursor === null ? null : { last_day: last }, stats: { days: segments.length }, errors: [] };
}
