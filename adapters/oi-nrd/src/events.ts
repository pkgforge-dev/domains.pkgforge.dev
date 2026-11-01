// adapters/oi-nrd/src/events.ts — one message of an OpenINTEL NRD topic to an
// event, and the records and facts of one window's events (DOM-026, design
// 5.4, settled S3 and C15).
//
// A message value is one JSON object (design 1.2): a domain topic's name ends
// in a dot, and newly_registered_fqdn's in none:
//   newly_registered_domain            {"domain":"x.com.","timestamp":..,"submission_timestamp":..,"ct_name":..,"cert_index":..}
//   newly_registered_fqdn              {"fqdn":"a.x.com", ...the same fields}
//   confirmed_newly_registered_domain  {"domain":"x.com.","timestamp":..,"ct_name":..,"cert_index":..,"confidence":1..10}
// A value that is not UTF-8 JSON of an object, whose name is not a string, or
// (confirmed) whose confidence is not a whole number from 1 to 10 is
// malformed. The name goes through normalise of @domains/names under ctx.psl,
// which removes the trailing dot and a leading `*.`; a refusal writes nothing.
//
// The key of a domain topic is its name's ICANN registrable domain, reversed;
// of newly_registered_fqdn the name itself, reversed, flagged exact (1) or
// wildcard (2), the flags of a key the OR of its events'.
//
// Evidence (docs/format.md section 5.3), every entry T2, since each is
// OpenINTEL's claim, never a zone diff this project read (settled S3; T1
// `zone` is the zone adapters'). A zone row (`ct_name` zone_data, no
// registration date) is nrd-list in both domain topics, and in the confirmed
// topic it keeps the confidence it states, which the format passes through. A
// confirmed row with a certificate (cert_index at or above 0) is nrd-ct+rdap.
// Per key and basis: `at` the earliest event time, `confidence` the strongest
// (strongerConfidence of @domains/pack, the format's merge rule).
//
// The certificate age of an event is `timestamp` minus `submission_timestamp`
// in whole seconds, floored, a negative value read as 0, known only when both
// are numbers and the age is a safe whole number. A key's fact is the minimum
// over its events (a fresh event clears an old certificate), and only oi-nrd
// writes facts (facts.json, docs/format.md section 19).
import type { FactRow, SegmentRecord } from "@domains/adapter";
import { key as keyOf, normalise, type Psl, type Refusal, split } from "@domains/names";
import { BASIS, BASIS_TIER, strongerConfidence } from "@domains/pack";
import { EPOCH_2026_S } from "./window.ts";

// How a topic's messages read: a registrable domain, a name, or a confirmed domain with a confidence.
export type TopicKind = "domain" | "fqdn" | "confirmed";

export const NRD_LIST = BASIS["nrd-list"];
export const NRD_CT_RDAP = BASIS["nrd-ct+rdap"];
const EXACT = 1;
const WILDCARD = 2;
const ZONE_DATA = "zone_data";
// The age above which feed rows are suspect (docs/format.md section 5.4, bit 4).
export const OLD_CERT_S = 7 * 86_400;

export interface Event {
  readonly key: string;
  // A name's flags, 1 exact or 2 wildcard; 0 for a domain, whose claim is no sighting of the name.
  readonly flags: number;
  // NRD_LIST or NRD_CT_RDAP; a domain topic's.
  readonly basis: number;
  // 0 when the topic states none.
  readonly confidence: number;
  readonly certAge: number | null;
  readonly zone: boolean;
  // A domain topic's name that is not its own registrable domain.
  readonly regDiffers: boolean;
}

export type Parsed = { readonly event: Event } | { readonly malformed: string } | { readonly refused: Refusal };

// A BOM is kept, so JSON.parse refuses it: a value is JSON text and no more.
const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function ageOf(timestamp: unknown, submitted: unknown): number | null {
  if (typeof timestamp !== "number" || typeof submitted !== "number") return null;
  const age = Math.floor(timestamp - submitted);
  return Number.isSafeInteger(age) ? Math.max(0, age) : null;
}

export function eventOf(kind: TopicKind, value: Uint8Array | null, psl: Psl): Parsed {
  if (value === null) return { malformed: "a record with no value" };
  let json: unknown;
  try {
    json = JSON.parse(utf8.decode(value));
  } catch {
    return { malformed: "a value that is not UTF-8 JSON" };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return { malformed: "a value that is not a JSON object" };
  const m = json as Readonly<Record<string, unknown>>;
  const field = kind === "fqdn" ? "fqdn" : "domain";
  const name = m[field];
  if (typeof name !== "string") return { malformed: `a value whose ${field} is not a string` };
  let confidence = 0;
  if (kind === "confirmed") {
    const c = m.confidence;
    if (typeof c !== "number" || !Number.isInteger(c) || c < 1 || c > 10) return { malformed: `a confidence ${JSON.stringify(c ?? null)} that is not a whole number from 1 to 10` };
    confidence = c;
  }
  const n = normalise(name, psl);
  if ("refused" in n) return { refused: n.refused };
  const zone = m.ct_name === ZONE_DATA;
  const certAge = ageOf(m.timestamp, m.submission_timestamp);
  if (kind === "fqdn") return { event: { key: keyOf(n.name), flags: n.wild ? WILDCARD : EXACT, basis: NRD_LIST, confidence: 0, certAge, zone, regDiffers: false } };
  // normalise refuses a name that is itself an ICANN suffix, so a name it takes has a registrable domain.
  const reg = split(n.name, psl).reg;
  if (reg === null) return { refused: "public-suffix" };
  const certified = kind === "confirmed" && !zone && Number.isSafeInteger(m.cert_index) && (m.cert_index as number) >= 0;
  return { event: { key: keyOf(reg), flags: 0, basis: certified ? NRD_CT_RDAP : NRD_LIST, confidence, certAge, zone, regDiffers: reg !== n.name } };
}

interface Claim {
  at: number;
  confidence: number;
}

interface KeyEvents {
  first: number;
  last: number;
  flags: number;
  readonly claims: Map<number, Claim>;
  certAge: number | null;
}

// The events of one window, by key. Times are seconds since the Unix epoch.
export class WindowEvents {
  readonly kind: TopicKind;
  readonly bit: number;
  private readonly byKey = new Map<string, KeyEvents>();

  constructor(kind: TopicKind, bit: number) {
    this.kind = kind;
    this.bit = bit;
  }

  add(e: Event, t: number): void {
    const was = this.byKey.get(e.key);
    if (was === undefined) {
      this.byKey.set(e.key, { first: t, last: t, flags: e.flags, claims: new Map([[e.basis, { at: t, confidence: e.confidence }]]), certAge: e.certAge });
      return;
    }
    was.first = Math.min(was.first, t);
    was.last = Math.max(was.last, t);
    was.flags |= e.flags;
    const claim = was.claims.get(e.basis);
    if (claim === undefined) was.claims.set(e.basis, { at: t, confidence: e.confidence });
    else {
      claim.at = Math.min(claim.at, t);
      claim.confidence = strongerConfidence(claim.confidence, e.confidence);
    }
    if (e.certAge !== null) was.certAge = was.certAge === null ? e.certAge : Math.min(was.certAge, e.certAge);
  }

  get keys(): number {
    return this.byKey.size;
  }

  // The window's records in key order, a names record of newly_registered_fqdn
  // and a domains record of the two domain topics, times in the format's
  // seconds; and the minimum certificate age of each key that has one known,
  // in the same order.
  build(): { records: SegmentRecord[]; facts: FactRow[] } {
    // Keys are ASCII ([a-z0-9_.-]), where code-unit order is byte order.
    const sorted = [...this.byKey].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const records = sorted.map(([key, k]): SegmentRecord => {
      const sources = [{ bit: this.bit, first: k.first - EPOCH_2026_S, last: k.last - EPOCH_2026_S }];
      if (this.kind === "fqdn") return { key, flags: k.flags, sources };
      const evidence = [...k.claims].sort(([a], [b]) => a - b).map(([basis, c]) => ({ tier: BASIS_TIER[basis]!, basis, source: this.bit, at: c.at - EPOCH_2026_S, confidence: c.confidence }));
      return { key, flags: 0, sources, evidence };
    });
    const facts = sorted.flatMap(([key, k]) => (k.certAge === null ? [] : [{ key, cert_age: k.certAge }]));
    return { records, facts };
  }
}
