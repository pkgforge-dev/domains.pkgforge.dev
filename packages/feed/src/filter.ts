// packages/feed/src/filter.ts — the row filters of GET /v1/new
// (docs/architecture.md section 7.3), and what a stored row says about itself.
//
//   const filter = checkFilter({ basis: "registered", suspect: "include" });
//   rowMatches(row, filter)        true when the row passes every filter
//   describeRow(row, table)        the class, the bases, the flags, the suspect reasons and the sources of a row, by name
//
// The meaning of each value, on a row of the feed (docs/format.md section 5.4):
//   basis       any         every row
//               seen        every row: each row of the feed is newly seen, its
//                           global first_seen inside the span of its pack
//               claimed     a basis of tier 1 or 2 (zone, rdap, nrd-list,
//                           nrd-ct+rdap): a source claims the domain is new
//               registered  a basis of a registry claim: zone, rdap or
//                           nrd-ct+rdap (docs/architecture.md section 2)
//               zone, rdap, nrd-list   that basis bit
//               ct          the basis bit ct-first (tier 3)
//   sources     the row holds at least one of the source bits given
//   minConfidence N (1 to 10)   a registered row strong enough: a tier 1 basis
//               (zone or rdap), which outranks every OpenINTEL level, or an
//               nrd-ct+rdap basis with a stored level of 1 to N (level 1 is the
//               strongest, 0 is none: docs/format.md section 5.6)
//   suspect     exclude (the default) the rows without the flag, include every
//               row, only the rows with it
//   provisional include (the default) every row, exclude the rows with the flag
// A basis bit this code does not know (a newer writer's) is kept in the row and
// matches no named basis.
import { BASIS, FEED_CENSORED, FEED_CORROBORATED, FEED_PROVISIONAL, FEED_SUSPECT, FEED_SUSPECT_CERT, FEED_SUSPECT_RDAP, type FeedRecord } from "@domains/pack";
import { type ConfidenceLevel, classOf } from "./confidence.ts";
import { FeedError } from "./errors.ts";
import type { SourceTable } from "./sources.ts";

export const BASIS_FILTERS = Object.freeze(["any", "seen", "claimed", "registered", "zone", "rdap", "nrd-list", "ct"] as const);
export type BasisFilter = (typeof BASIS_FILTERS)[number];
export const SUSPECT_FILTERS = Object.freeze(["exclude", "include", "only"] as const);
export type SuspectFilter = (typeof SUSPECT_FILTERS)[number];
export const PROVISIONAL_FILTERS = Object.freeze(["include", "exclude"] as const);
export type ProvisionalFilter = (typeof PROVISIONAL_FILTERS)[number];

export interface FeedFilter {
  readonly basis?: BasisFilter;
  readonly sources?: readonly number[];
  readonly minConfidence?: number;
  readonly suspect?: SuspectFilter;
  readonly provisional?: ProvisionalFilter;
}

const bitOf = (basis: number): number => 2 ** basis;
const mask = (...bases: number[]): number => bases.reduce((m, b) => m + bitOf(b), 0);
// Bases are bits 0 to 4 (BASIS), so the AND of two masks fits 32 bits.
const any = (bits: number, m: number): boolean => (bits & m) !== 0;

const REGISTERED = mask(BASIS.zone, BASIS.rdap, BASIS["nrd-ct+rdap"]);
const CLAIMED = mask(BASIS.zone, BASIS.rdap, BASIS["nrd-list"], BASIS["nrd-ct+rdap"]);
const TIER_ONE = mask(BASIS.zone, BASIS.rdap);
const NAMED: Readonly<Record<BasisFilter, number | null>> = Object.freeze({
  any: null,
  seen: null,
  claimed: CLAIMED,
  registered: REGISTERED,
  zone: mask(BASIS.zone),
  rdap: mask(BASIS.rdap),
  "nrd-list": mask(BASIS["nrd-list"]),
  ct: mask(BASIS["ct-first"]),
});

const oneOf = <T extends string>(list: readonly T[], v: unknown, what: string): T => {
  if (!(list as readonly unknown[]).includes(v)) throw new FeedError("usage", `${what} ${JSON.stringify(v)} is not one of ${list.join(", ")}`);
  return v as T;
};

// The filter with its defaults, every value checked.
export function checkFilter(filter: FeedFilter = {}): Required<Omit<FeedFilter, "sources" | "minConfidence">> & Pick<FeedFilter, "sources" | "minConfidence"> {
  const basis = oneOf(BASIS_FILTERS, filter.basis ?? "any", "basis");
  const suspect = oneOf(SUSPECT_FILTERS, filter.suspect ?? "exclude", "suspect");
  const provisional = oneOf(PROVISIONAL_FILTERS, filter.provisional ?? "include", "provisional");
  const { sources, minConfidence } = filter;
  if (sources !== undefined && (!Array.isArray(sources) || sources.length === 0 || !sources.every((b) => Number.isInteger(b) && b >= 0 && b <= 63)))
    throw new FeedError("usage", "sources must be one or more source bits of 0 to 63");
  if (minConfidence !== undefined && (!Number.isInteger(minConfidence) || minConfidence < 1 || minConfidence > 10)) throw new FeedError("usage", `min_confidence ${minConfidence} is not 1 to 10`);
  return { basis, suspect, provisional, sources, minConfidence };
}

export function rowMatches(row: FeedRecord, filter: FeedFilter): boolean {
  const suspect = (row.feedFlags & FEED_SUSPECT) !== 0;
  const s = filter.suspect ?? "exclude";
  if ((s === "exclude" && suspect) || (s === "only" && !suspect)) return false;
  if ((filter.provisional ?? "include") === "exclude" && (row.feedFlags & FEED_PROVISIONAL) !== 0) return false;
  const named = NAMED[filter.basis ?? "any"];
  if (named !== null && !any(row.basis, named)) return false;
  if (filter.sources !== undefined && !filter.sources.some((b) => row.sources.includes(b))) return false;
  if (filter.minConfidence !== undefined) {
    const tierOne = any(row.basis, TIER_ONE);
    const level = any(row.basis, mask(BASIS["nrd-ct+rdap"])) ? row.confidence : 0;
    if (!tierOne && !(level >= 1 && level <= filter.minConfidence)) return false;
  }
  return true;
}

// The reasons of a suspect row, by the name of the rule of confidenceOf that
// set each (`why` of confidence.ts).
export type SuspectReason = "cert-age" | "rdap-before-2026";

export interface RowDescription {
  readonly class: ConfidenceLevel;
  readonly basis: readonly string[];
  // The stored OpenINTEL level, 0 for none.
  readonly level: number;
  // The flags of bits 0 to 3 by name: provisional, suspect, corroborated, censored.
  readonly flags: readonly string[];
  // Why the row is suspect, from bits 4 and 5; empty for a row that is not.
  readonly reasons: readonly SuspectReason[];
  readonly sources: readonly string[];
}

const BASIS_NAMES = Object.entries(BASIS) as [string, number][];
const FLAG_NAMES: readonly [number, string][] = [
  [FEED_PROVISIONAL, "provisional"],
  [FEED_SUSPECT, "suspect"],
  [FEED_CORROBORATED, "corroborated"],
  [FEED_CENSORED, "censored"],
];
const REASON_NAMES: readonly [number, SuspectReason][] = [
  [FEED_SUSPECT_CERT, "cert-age"],
  [FEED_SUSPECT_RDAP, "rdap-before-2026"],
];

// What a stored row says about itself, by name: the stored inputs of its class
// (its bases, its OpenINTEL level, its flags and its sources), and why it is
// suspect: feed_flags holds each reason in its own bit (docs/format.md section
// 5.4). The certificate age and the RDAP date themselves are in `why` of
// confidenceOf at build time only (confidence.ts).
export function describeRow(row: FeedRecord, table: SourceTable): RowDescription {
  return {
    class: classOf(row),
    basis: BASIS_NAMES.filter(([, id]) => any(row.basis, bitOf(id))).map(([name]) => name),
    level: row.confidence,
    flags: FLAG_NAMES.filter(([bit]) => (row.feedFlags & bit) !== 0).map(([, name]) => name),
    reasons: REASON_NAMES.filter(([bit]) => (row.feedFlags & bit) !== 0).map(([, name]) => name),
    sources: row.sources.map((bit) => table.id(bit)),
  };
}
