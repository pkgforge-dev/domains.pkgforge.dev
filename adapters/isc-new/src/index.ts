// A snapshot of domains newly seen by ISC. The publisher's firstseen is T2
// list evidence and carries no statement about registration time.
import { type Segment, type SegmentRecord, type SegmentWriter, type Window, isIsoUtc } from "@domains/adapter";
import { key, normalise, type Psl, split } from "@domains/names";
import { BASIS, BASIS_TIER } from "@domains/pack";
import { jsonRows } from "./array.ts";
import { isDay, IscFault, type SnapshotFile } from "./http.ts";

export { datedUrl, fetchSnapshot, ISC_FEEDS, IscFault, isDay, MAX_GZIP_BYTES, type Snapshot, type SnapshotFile, type SnapshotRequest, type Validators } from "./http.ts";

export const SOURCE = "isc-new";
export const BIT = 8;
export const PARSER = "isc-new/1";
export const DPK1_EPOCH_DAY = "2026-01-01";
const DAY_MS = 86_400_000;
const EPOCH_MS = Date.parse(`${DPK1_EPOCH_DAY}T00:00:00Z`);
const NRD_LIST = BASIS["nrd-list"];
const MAX_ROWS = 4_000_000;

export interface SnapshotIndex {
  readonly window: Window;
  readonly count: number;
  readonly refused: number;
  readonly records: Iterable<SegmentRecord>;
}

export interface ParsedSnapshot {
  readonly file: SnapshotFile;
  readonly day: string | null;
  readonly rows: number;
  // Null for an empty file, a pre-epoch day or validation without a PSL.
  readonly index: SnapshotIndex | null;
}

interface FeedRow {
  readonly domainname: string;
  readonly firstseen: string;
}

function rowOf(text: string, url: string, position: number): FeedRow {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    // JSON.parse's message can quote upstream content.
    throw new IscFault("format", `${url}: row ${position} is not a JSON object`);
  }
  const row = input as { domainname?: unknown; firstseen?: unknown };
  if (typeof row.domainname !== "string" || row.domainname.length === 0) throw new IscFault("format", `${url}: row ${position} needs a nonempty domainname`);
  if (!isDay(row.firstseen)) throw new IscFault("date", `${url}: row ${position} needs a real firstseen day in YYYY-MM-DD form`);
  return { domainname: row.domainname, firstseen: row.firstseen };
}

function indexOf(day: string, keys: ReadonlySet<string>, refused: number): SnapshotIndex {
  const start = `${day}T00:00:00Z`;
  const ms = Date.parse(start);
  const end = new Date(ms + DAY_MS).toISOString().replace(".000Z", "Z");
  if (!isIsoUtc(end)) throw new IscFault("date", `ISC day ${day} cannot be represented by a DPK1 day window`);
  const seenAt = (ms - EPOCH_MS) / DAY_MS;
  const sources = Object.freeze([Object.freeze({ bit: BIT, first: seenAt, last: seenAt })]);
  const evidence = Object.freeze([Object.freeze({ tier: BASIS_TIER[NRD_LIST]!, basis: NRD_LIST, source: BIT, at: seenAt, confidence: 0 })]);
  const sorted = [...keys].sort();
  const records: Iterable<SegmentRecord> = {
    *[Symbol.iterator]() {
      for (const k of sorted) yield { key: k, flags: 0, sources, evidence };
    },
  };
  return { window: { start, end }, count: sorted.length, refused, records };
}

export async function parseSnapshot(file: SnapshotFile, psl?: Psl): Promise<ParsedSnapshot> {
  let day: string | null = null;
  let keys: Set<string> | null = null;
  let rows = 0;
  let refused = 0;
  for await (const text of jsonRows(file.raw, file.url)) {
    rows += 1;
    if (rows > MAX_ROWS) throw new IscFault("size", `${file.url}: the feed exceeds ${MAX_ROWS} rows`);
    const row = rowOf(text, file.url, rows);
    if (day === null) {
      day = row.firstseen;
      if (file.pathDay !== null && day !== file.pathDay) throw new IscFault("date", `${file.url}: firstseen ${day} disagrees with the archive path day ${file.pathDay}`);
      if (psl !== undefined && day >= DPK1_EPOCH_DAY) keys = new Set();
    } else if (row.firstseen !== day) throw new IscFault("date", `${file.url}: row ${rows} firstseen ${row.firstseen} disagrees with ${day}`);
    if (psl !== undefined && keys !== null) {
      const name = normalise(row.domainname, psl);
      const registrable = "refused" in name ? null : split(name.name, psl).reg;
      if (registrable === null) refused += 1;
      else keys.add(key(registrable));
    }
  }
  return { file, day, rows, index: day === null || keys === null ? null : indexOf(day, keys, refused) };
}

export async function writeIndexedSnapshot(snapshot: ParsedSnapshot, writer: SegmentWriter): Promise<Segment> {
  const { day, file, index } = snapshot;
  if (day === null || index === null) throw new IscFault("date", `${file.url}: no DPK1 day was prepared for this snapshot`);
  if (index.count === 0) throw new IscFault("format", `${file.url}: none of the ${snapshot.rows} rows has a registrable domain`);
  return writer.write(
    { source: SOURCE, dataset: "domains", precision: "day", window: index.window, cursorBefore: { day }, cursorAfter: { day: index.window.end.slice(0, 10) }, url: file.url },
    index.records,
    file.raw,
  );
}
