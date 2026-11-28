import { type AdapterContext, ContractError, isIsoUtc, type RunResult, type Segment, type Window } from "@domains/adapter";
import { DAY_MS } from "./cursor.ts";
import { datedUrl, fetchSnapshot, IscFault } from "./http.ts";
import { INDEX_GRACE_DAYS } from "./run.ts";
import { DPK1_EPOCH_DAY, parseSnapshot, writeIndexedSnapshot } from "./snapshot.ts";

export const MAX_STAGE_DAYS = 7;

export function stageDays(window: Window, now: string): string[] {
  const { start, end } = window;
  const atMidnight = (value: string): boolean => isIsoUtc(value) && value.endsWith("T00:00:00Z");
  const first = Date.parse(start);
  const last = Date.parse(end);
  const clock = Date.parse(now);
  const count = (last - first) / DAY_MS;
  const bad = (detail: string): ContractError => new ContractError("options", `isc-new: ${detail}`);
  if (!atMidnight(start) || !atMidnight(end) || first >= last || start.slice(0, 10) < DPK1_EPOCH_DAY) {
    throw bad(`the staging window needs ordered UTC midnights from ${DPK1_EPOCH_DAY}`);
  }
  if (count > MAX_STAGE_DAYS) throw bad(`the staging window spans more than ${MAX_STAGE_DAYS} days`);
  if (!Number.isFinite(clock) || clock < last + (INDEX_GRACE_DAYS - 1) * DAY_MS) {
    throw bad(`the last staging day has yet to reach D+${INDEX_GRACE_DAYS} at 00:00 UTC`);
  }
  return Array.from({ length: count }, (_, i) => new Date(first + i * DAY_MS).toISOString().slice(0, 10));
}

export async function backfill(window: Window, ctx: AdapterContext): Promise<RunResult> {
  const days = stageDays(window, ctx.now);
  const segments: Segment[] = [];
  let rows = 0;
  let refused = 0;
  for (const day of days) {
    try {
      const file = await fetchSnapshot(ctx, { day });
      if (file.kind !== "file") throw new IscFault("date", `${datedUrl(day)}: the dated snapshot is ${file.kind}`);
      const parsed = await parseSnapshot(file, ctx.psl);
      if (parsed.index === null) throw new IscFault("format", `${file.url}: the dated snapshot has no indexed rows`);
      segments.push(await writeIndexedSnapshot(parsed, ctx.writer));
      rows += parsed.rows;
      refused += parsed.index.refused;
    } catch (error) {
      // A thrown backfill fails the whole batch before the CLI can write it to GHCR.
      if (!(error instanceof IscFault)) throw error;
      throw new ContractError("segment", `isc-new: ${day}: ${error.code}: ${error.message}`, { cause: error });
    }
  }
  return { cursor: null, segments, stats: { dated_gets: days.length, indexed_days: segments.length, indexed_rows: rows, refused_rows: refused }, errors: [] };
}
