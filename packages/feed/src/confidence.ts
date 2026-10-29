// packages/feed/src/confidence.ts — how strongly the corpus says a domain is
// new, and whether something refutes it (design B section 4, docs/architecture.md
// sections 2 and 3.3, TODO/RULES.md section 5 ruling 19).
//
//   const c = confidenceOf(record.sources, record.evidence, { table, window, facts });
//   c.level   "registered-confirmed" | "corroborated" | "single"
//   c.suspect true when a fact refutes newness
//   c.suspectCert, c.suspectRdap   its reasons: a certificate older than 7 days, an RDAP date before 2026
//   c.basis, c.oiLevel, c.feedFlags   what the feed row stores
//   c.why     every input that decided, so the builder's caller can see why;
//             a stored row keeps none of it but its bits (see below)
//
// The rules:
//   registered-confirmed  an `nrd-ct+rdap` evidence entry of OpenINTEL level 1
//                         to 5 (level 1 is the closest to the RDAP date, 0 is
//                         none: docs/format.md section 5.6), or a `zone` entry,
//                         or an `rdap` entry whose creation time overlaps the
//                         window of the row
//   corroborated          two sources of different families whose first
//                         sightings are surely within 48 h of each other
//   single                neither
//   suspect               an event whose certificate is older than 7 days (an
//                         `oi-nrd` event: timestamp minus submission_timestamp),
//                         or an RDAP creation date before 2026-01-01 (ruling 19:
//                         no evidence entry; the flag, and its reason in `why`)
//
// What a stored row keeps. The row stores the basis bits, the confidence byte
// and feed_flags (docs/format.md section 5.4), not `why`. feed_flags holds the
// suspect flag and each of its reasons: bit 4 suspect-cert (a certificate older
// than 7 days) and bit 5 suspect-rdap (an RDAP creation date before 2026), and
// bit 1 suspect is set exactly when one of them is. So a stored suspect row
// says which rule made it suspect, though not the certificate age or the date,
// which `why` holds at build time only. A reader shows the class, the flags and
// the reasons (describeRow of filter.ts).
//
// "Surely within 48 h": a day value stands for its whole day, so two sightings
// are within 48 h when the two farthest instants of their intervals are. Days D
// and D+1 are; day D and a second 49 h after its start are not. Claiming a
// corroboration the data does not show is the error this rule avoids.
//
// The level is classOf of the row the builder writes (basis bits, confidence
// byte, flags), the same function a reader runs on a stored row, so the level
// a reader shows is the level the builder computed. An `rdap` entry outside the
// window is listed in `why` and adds no basis bit: it does not support newness
// in this window, and a row cannot show the class without the bit.
import { DAY_SECONDS, EPOCH_MS } from "@domains/ledger";
import { BASIS, type Evidence, FEED_CORROBORATED, FEED_SUSPECT, FEED_SUSPECT_CERT, FEED_SUSPECT_RDAP, type Seen, strongerConfidence } from "@domains/pack";
import { FeedError } from "./errors.ts";
import type { SourceTable } from "./sources.ts";
import { checkWindow, overlaps, type Window } from "./time.ts";

export const SUSPECT_CERT_AGE_SECONDS = 7 * DAY_SECONDS;
export const CORROBORATION_SECONDS = 48 * 3600;
export const REGISTERED_MAX_LEVEL = 5;
// The epoch of DPK1 time: an RDAP creation date before it is a refutation, not
// evidence (ruling 19).
export const RDAP_EVIDENCE_FROM = "2026-01-01";
// The basis a source of kind `ct_name` implies: a CT name source writes no
// evidence entry (packages/ledger aggregate.ts), and its basis is `ct-first`.
const CT_NAME_KIND = "ct_name";

export type ConfidenceLevel = "registered-confirmed" | "corroborated" | "single";

// One event's certificate age: `timestamp` minus `submission_timestamp` of an
// OpenINTEL newly-registered event, in seconds.
export interface CertAge {
  readonly bit: number;
  readonly seconds: number;
}

// An RDAP creation date before 2026-01-01, `YYYY-MM-DD`. A later date is an
// `rdap` evidence entry instead.
export interface RdapCreated {
  readonly bit: number;
  readonly date: string;
}

// What a domain record does not hold and the rules need.
export interface EventFacts {
  readonly certAges?: readonly CertAge[];
  readonly rdapCreated?: readonly RdapCreated[];
}

export type Why =
  | { readonly rule: "nrd-ct+rdap"; readonly bit: number; readonly level: number }
  | { readonly rule: "zone"; readonly bit: number; readonly at: number }
  | { readonly rule: "rdap"; readonly bit: number; readonly at: number }
  | { readonly rule: "rdap-outside-window"; readonly bit: number; readonly at: number }
  | { readonly rule: "corroborated"; readonly bits: readonly [number, number]; readonly families: readonly [string, string] }
  | { readonly rule: "cert-age"; readonly bit: number; readonly seconds: number }
  | { readonly rule: "rdap-before-2026"; readonly bit: number; readonly date: string };

export interface Confidence {
  readonly level: ConfidenceLevel;
  // suspectCert or suspectRdap.
  readonly suspect: boolean;
  // A certificate older than SUSPECT_CERT_AGE_SECONDS: feed_flags bit 4.
  readonly suspectCert: boolean;
  // An RDAP creation date before 2026-01-01: feed_flags bit 5.
  readonly suspectRdap: boolean;
  readonly corroborated: boolean;
  // The feed_flags this confidence sets: corroborated, suspect and its
  // reasons. The builder adds provisional.
  readonly feedFlags: number;
  // The basis bits the row stores: bit n for basis n of docs/format.md section 5.3.
  readonly basis: number;
  // The confidence byte the row stores: the strongest `nrd-ct+rdap` level, 0 for none.
  readonly oiLevel: number;
  readonly why: readonly Why[];
}

export interface ConfidenceContext {
  readonly table: SourceTable;
  // The span of the row: the day of a day pack, the hour of an hour pack.
  readonly window: Window;
  readonly facts?: EventFacts;
}

const bitOf = (basis: number): number => 2 ** basis;
const has = (bits: number, basis: number): boolean => Math.floor(bits / bitOf(basis)) % 2 === 1;

// The class of a stored row: what a reader shows, from the row alone.
export function classOf(row: { readonly basis: number; readonly confidence: number; readonly feedFlags: number }): ConfidenceLevel {
  const level = row.confidence;
  if (has(row.basis, BASIS.zone) || has(row.basis, BASIS.rdap)) return "registered-confirmed";
  if (has(row.basis, BASIS["nrd-ct+rdap"]) && level >= 1 && level <= REGISTERED_MAX_LEVEL) return "registered-confirmed";
  return (row.feedFlags & FEED_CORROBORATED) !== 0 ? "corroborated" : "single";
}

// The interval of one value in the unit of its source.
function spanOf(value: number, bit: number, table: SourceTable): Window {
  return table.precision(bit) === "day" ? { t0: value * DAY_SECONDS, t1: (value + 1) * DAY_SECONDS } : { t0: value, t1: value + 1 };
}

// The farthest two instants of two intervals are at most `limit` apart.
const surelyWithin = (a: Window, b: Window, limit: number): boolean => Math.max(a.t1, b.t1) - 1 - Math.min(a.t0, b.t0) <= limit;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function checkRdapDate(fact: RdapCreated): void {
  const m = typeof fact.date === "string" ? ISO_DATE.exec(fact.date) : null;
  const ms = m === null ? Number.NaN : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (m === null || new Date(ms).toISOString().slice(0, 10) !== fact.date) throw new FeedError("facts", `the RDAP creation date ${JSON.stringify(fact.date)} is not a YYYY-MM-DD date`);
  if (ms >= EPOCH_MS) throw new FeedError("facts", `the RDAP creation date ${fact.date} is on or after ${RDAP_EVIDENCE_FROM}: it is an rdap evidence entry, not a refutation (ruling 19)`);
}

const checkBit = (bit: unknown, what: string): void => {
  if (typeof bit !== "number" || !Number.isInteger(bit) || bit < 0 || bit > 63) throw new FeedError("facts", `${what} names source bit ${String(bit)}, not 0 to 63`);
};

export function confidenceOf(sourcesSeen: readonly Seen[], evidence: readonly Evidence[], context: ConfidenceContext): Confidence {
  const { table } = context;
  const window = checkWindow(context.window, "the window of the row");
  const why: Why[] = [];
  let basis = 0;
  let oiLevel = 0;
  for (const s of sourcesSeen) if (table.kind(s.bit) === CT_NAME_KIND) basis |= bitOf(BASIS["ct-first"]);
  for (const e of evidence) {
    if (!Number.isInteger(e.basis) || e.basis < 0 || e.basis > BASIS["ct-first"])
      throw new FeedError("facts", `an evidence entry of source bit ${e.source} has basis ${e.basis}, which this builder does not know`);
    if (e.basis === BASIS.rdap) {
      const at = spanOf(e.at, e.source, table);
      if (!overlaps(at, window)) {
        why.push({ rule: "rdap-outside-window", bit: e.source, at: at.t0 });
        continue;
      }
      why.push({ rule: "rdap", bit: e.source, at: at.t0 });
    } else if (e.basis === BASIS.zone) {
      why.push({ rule: "zone", bit: e.source, at: spanOf(e.at, e.source, table).t0 });
    } else if (e.basis === BASIS["nrd-ct+rdap"]) {
      oiLevel = strongerConfidence(oiLevel, e.confidence);
      if (e.confidence >= 1 && e.confidence <= REGISTERED_MAX_LEVEL) why.push({ rule: "nrd-ct+rdap", bit: e.source, level: e.confidence });
    }
    basis |= bitOf(e.basis);
  }

  // Corroboration: the first pair of different families, in bit order.
  let corroborated = false;
  for (let i = 0; i < sourcesSeen.length && !corroborated; i += 1) {
    for (let j = i + 1; j < sourcesSeen.length && !corroborated; j += 1) {
      const a = sourcesSeen[i];
      const b = sourcesSeen[j];
      const fa = table.family(a.bit);
      const fb = table.family(b.bit);
      if (fa === fb) continue;
      if (surelyWithin(spanOf(a.first, a.bit, table), spanOf(b.first, b.bit, table), CORROBORATION_SECONDS)) {
        corroborated = true;
        why.push({ rule: "corroborated", bits: [a.bit, b.bit], families: [fa, fb] });
      }
    }
  }

  let suspectCert = false;
  let suspectRdap = false;
  const bits = new Set(sourcesSeen.map((s) => s.bit));
  for (const fact of context.facts?.certAges ?? []) {
    checkBit(fact.bit, "a certificate age");
    if (!bits.has(fact.bit)) throw new FeedError("facts", `a certificate age names source bit ${fact.bit}, which the record does not hold`);
    if (typeof fact.seconds !== "number" || !Number.isFinite(fact.seconds)) throw new FeedError("facts", `a certificate age of source bit ${fact.bit} is ${String(fact.seconds)} seconds`);
    if (fact.seconds > SUSPECT_CERT_AGE_SECONDS) {
      suspectCert = true;
      why.push({ rule: "cert-age", bit: fact.bit, seconds: fact.seconds });
    }
  }
  for (const fact of context.facts?.rdapCreated ?? []) {
    checkBit(fact.bit, "an RDAP creation date");
    checkRdapDate(fact);
    suspectRdap = true;
    why.push({ rule: "rdap-before-2026", bit: fact.bit, date: fact.date });
  }

  const suspect = suspectCert || suspectRdap;
  const feedFlags = (corroborated ? FEED_CORROBORATED : 0) | (suspect ? FEED_SUSPECT : 0) | (suspectCert ? FEED_SUSPECT_CERT : 0) | (suspectRdap ? FEED_SUSPECT_RDAP : 0);
  return { level: classOf({ basis, confidence: oiLevel, feedFlags }), suspect, suspectCert, suspectRdap, corroborated, feedFlags, basis, oiLevel, why };
}
