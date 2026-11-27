import { ContractError, type Cursor } from "@domains/adapter";
import { isDay, MAX_GZIP_BYTES, type Validators } from "./http.ts";
import { DPK1_EPOCH_DAY } from "./snapshot.ts";

export const WATCH_DAYS = 3;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;
const LAST_SECOND = 253_402_300_799;
// Keep the worst JSON escaping of three watched tags and one alias tag under
// the writer's 1,024-character cursor annotation. Longer tags use the date.
const MAX_ETAG_CHARS = 36;
const ETAG = /^(?:W\/)?"[!#-~]*"$/;
const SHA256 = /^[0-9a-f]{64}$/;

export const isSnapshotDigest = (v: unknown): v is string => typeof v === "string" && SHA256.test(v);

export type Mark = { etag: string | null; modified: number | null; bytes: number | null };
export type Alias = { hour: number; since: number | null; mark: Mark | null };
export type Watch = { day: string; digest: string; mark: Mark; changed: boolean };
type Review = { hour: number; day: string };
export type RunCursor = { next: string; alias: Alias | null; watch: Watch[]; review: Review | null; blockedHour: number | null };

type Obj = { readonly [key: string]: Cursor };
const object = (v: Cursor | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fields = (v: Obj, expected: string): boolean => Object.keys(v).sort().join(",") === expected;
const integer = (v: Cursor | undefined, max: number): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= max;
const etag = (v: Cursor | undefined): v is string => typeof v === "string" && v.length <= MAX_ETAG_CHARS && ETAG.test(v);
const hour = (v: Cursor | undefined): v is number => integer(v, Math.floor(LAST_SECOND / 3600));

function mark(v: Cursor | undefined): v is Mark {
  return (
    object(v) &&
    fields(v, "bytes,etag,modified") &&
    (v.bytes === null || integer(v.bytes, MAX_GZIP_BYTES)) &&
    (v.etag === null || etag(v.etag)) &&
    (v.modified === null || integer(v.modified, LAST_SECOND))
  );
}

function alias(v: Cursor | undefined): v is Alias {
  return object(v) && fields(v, "hour,mark,since") && hour(v.hour) && (v.mark === null || mark(v.mark)) && (v.since === null || (hour(v.since) && v.since <= v.hour));
}

function watch(v: Cursor | undefined, next: string): v is Watch {
  return object(v) && fields(v, "changed,day,digest,mark") && isDay(v.day) && v.day >= DPK1_EPOCH_DAY && v.day < next && isSnapshotDigest(v.digest) && mark(v.mark) && typeof v.changed === "boolean";
}

function review(v: Cursor | undefined, next: string): v is Review {
  return object(v) && fields(v, "day,hour") && hour(v.hour) && isDay(v.day) && v.day >= DPK1_EPOCH_DAY && v.day < next;
}

export function parseCursor(cursor: Cursor): RunCursor {
  if (cursor === null) return { next: DPK1_EPOCH_DAY, alias: null, watch: [], review: null, blockedHour: null };
  const bad = (part: string): ContractError => new ContractError("cursor", `isc-new: ${part}`);
  if (!object(cursor) || !fields(cursor, "alias,blockedHour,next,review,watch")) throw bad("the cursor has unexpected fields");
  const { next, alias: a, watch: w, review: r, blockedHour } = cursor;
  if (!isDay(next) || next < DPK1_EPOCH_DAY) throw bad("next must be an indexed UTC day");
  if (a !== null && !alias(a)) throw bad("alias HEAD state has invalid fields");
  if (!Array.isArray(w) || w.length > WATCH_DAYS) throw bad(`watch needs at most ${WATCH_DAYS} indexed days`);
  const checked: Watch[] = [];
  for (const item of w as readonly Cursor[]) {
    const previous = checked.at(-1)?.day;
    if (!watch(item, next) || (previous !== undefined && previous >= item.day)) throw bad("watch dates must be valid, distinct, sorted and earlier than next");
    checked.push(item);
  }
  if (r !== null && !review(r, next)) throw bad("review must name an earlier indexed day and a UTC hour");
  if (blockedHour !== null && !hour(blockedHour)) throw bad("blockedHour must be a UTC hour");
  return { next, alias: a, watch: checked, review: r, blockedHour };
}

export function markOf(validators: Validators, bytes: number | null): Mark {
  const modified = validators.lastModified === undefined ? Number.NaN : Date.parse(validators.lastModified) / 1000;
  return { etag: etag(validators.etag) ? validators.etag : null, modified: integer(modified, LAST_SECOND) ? modified : null, bytes };
}

export function validatorsOf(value: Mark | null): Validators {
  if (value === null) return {};
  const { etag, modified } = value;
  return { ...(etag === null ? {} : { etag }), ...(modified === null ? {} : { lastModified: new Date(modified * 1000).toUTCString() }) };
}

export function differs(a: Mark, b: Mark): boolean {
  return a.etag !== b.etag || a.modified !== b.modified || a.bytes !== b.bytes;
}
