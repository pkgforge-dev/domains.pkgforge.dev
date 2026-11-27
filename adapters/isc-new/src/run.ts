// ISC's dated snapshots become eligible on D+5 00:00 UTC. DOM-012 saw headers
// change through D+4 23:41. This grace delays indexing and is not a guarantee
// of final publisher bytes. Subsequent HEAD changes are review signals.
import type { AdapterContext, AdapterFault, Cursor, RunResult, Segment } from "@domains/adapter";
import { type Alias, DAY_MS, differs, HOUR_MS, markOf, parseCursor, type RunCursor, validatorsOf, type Watch, WATCH_DAYS } from "./cursor.ts";
import { datedUrl, fetchSnapshot, headSnapshot, IscFault } from "./http.ts";
import { parseSnapshot, SOURCE, writeIndexedSnapshot } from "./snapshot.ts";

export const INDEX_GRACE_DAYS = 5;
export const MAX_DAYS_PER_RUN = 4;
const MAX_WATCH_AGE_DAYS = 14;

const atMidnight = (day: string): number => Date.parse(`${day}T00:00:00Z`);

function fault(errors: AdapterFault[], code: string, detail: string): void {
  errors.push({ source: SOURCE, code, detail });
}

function failure(errors: AdapterFault[], code: string, error: unknown): void {
  if (!(error instanceof IscFault)) throw error;
  fault(errors, code, `${error.code}: ${error.message}`);
}

async function watchAlias(ctx: AdapterContext, errors: AdapterFault[], alias: Alias | null, hour: number): Promise<Alias> {
  if (alias !== null && hour <= alias.hour) return alias;
  const previous = alias?.mark ?? null;
  const since = alias?.since ?? null;
  try {
    const result = await headSnapshot(ctx, { validators: validatorsOf(previous) });
    if (result.kind === "missing") fault(errors, "alias-missing", `${result.url}: HEAD answered 404`);
    else {
      const mark = markOf(result.validators, result.kind === "unchanged" ? (previous?.bytes ?? null) : result.bytes);
      if (mark.etag !== null || mark.modified !== null || mark.bytes !== null) return { hour, mark, since: previous === null || differs(previous, mark) ? hour : since };
    }
  } catch (error) {
    failure(errors, "alias-read", error);
  }
  return { hour, mark: previous, since };
}

async function reviewOne(ctx: AdapterContext, errors: AdapterFault[], state: RunCursor, hour: number): Promise<void> {
  if (state.watch.length === 0 || (state.review !== null && hour <= state.review.hour)) return;
  const last = state.review?.day;
  const entry = state.watch.find(({ day }) => last === undefined || day > last) ?? state.watch[0]!;
  state.review = { hour, day: entry.day };
  try {
    const result = await headSnapshot(ctx, { day: entry.day, validators: validatorsOf(entry.mark) });
    if (result.kind === "missing") fault(errors, "dated-review", `${result.url}: the published day now answers 404`);
    else {
      const mark = markOf(result.validators, result.kind === "unchanged" ? entry.mark.bytes : result.bytes);
      if (differs(entry.mark, mark)) {
        fault(errors, "dated-review", `${result.url}: metadata changed after the index grace; the indexed gzip remains sha256 ${entry.digest}`);
        entry.changed = true;
        entry.mark = mark;
      }
    }
  } catch (error) {
    failure(errors, "dated-review", error);
  }
}

export async function run(cursor: Cursor, ctx: AdapterContext): Promise<RunResult> {
  const original = parseCursor(cursor);
  const now = Date.parse(ctx.now);
  const hour = Math.floor(now / HOUR_MS);
  const errors: AdapterFault[] = [];
  const segments: Segment[] = [];
  const watchCutoff = now - MAX_WATCH_AGE_DAYS * DAY_MS;
  const state: RunCursor = {
    ...original,
    watch: original.watch.filter((entry) => atMidnight(entry.day) >= watchCutoff).map((entry) => ({ ...entry })),
    alias: await watchAlias(ctx, errors, original.alias, hour),
  };
  await reviewOne(ctx, errors, state, hour);

  let requested = 0;
  let rows = 0;
  let refused = 0;
  let blocked = state.blockedHour !== null && hour <= state.blockedHour;
  while (!blocked && requested < MAX_DAYS_PER_RUN && now >= atMidnight(state.next) + INDEX_GRACE_DAYS * DAY_MS) {
    const day = state.next;
    requested += 1;
    try {
      const result = await fetchSnapshot(ctx, { day });
      if (result.kind !== "file") {
        fault(errors, "dated-pending", `${datedUrl(day)}: the eligible day is missing; next stays ${day}`);
        blocked = true;
        break;
      }
      const parsed = await parseSnapshot(result, ctx.psl);
      if (parsed.index === null) {
        fault(errors, "dated-pending", `${result.url}: the eligible day is a valid empty array; next stays ${day}`);
        blocked = true;
        break;
      }
      segments.push(await writeIndexedSnapshot(parsed, ctx.writer));
      rows += parsed.rows;
      refused += parsed.index.refused;
      if (atMidnight(day) >= watchCutoff) {
        const entry: Watch = { day, digest: result.sha256, mark: markOf(result.validators, result.raw.byteLength), changed: false };
        state.watch = [...state.watch, entry].slice(-WATCH_DAYS);
        // A dated GET already checked a recent file this hour. On a same-hour
        // replay there is no need to start a HEAD immediately after the GET.
        if (state.review === null || state.review.hour < hour) state.review = { hour, day };
      }
      state.next = parsed.index.window.end.slice(0, 10);
    } catch (error) {
      failure(errors, "dated-read", error);
      blocked = true;
    }
  }
  state.blockedHour = blocked ? Math.max(state.blockedHour ?? hour, hour) : null;
  const stats: Record<string, number> = {
    dated_gets: requested,
    indexed_days: segments.length,
    indexed_rows: rows,
    refused_rows: refused,
    dated_header_changes_pending: state.watch.filter((entry) => entry.changed).length,
  };
  const mark = state.alias?.mark;
  const lastModified = mark?.modified;
  const since = state.alias?.since;
  if (lastModified !== null && lastModified !== undefined && now >= lastModified * 1000) stats.alias_last_modified_age_s = Math.floor(now / 1000) - lastModified;
  if (since !== null && since !== undefined && hour >= since) stats.alias_metadata_idle_h = hour - since;
  return { cursor: state, segments, stats, errors };
}
