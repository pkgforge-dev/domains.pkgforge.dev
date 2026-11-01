// adapters/oi-nrd/src/events.ts, one message at a time: the guards of a value,
// the basis of a confirmed row (settled S3), and the certificate age, each
// held at its edge (the guard mutation of DOM-026's review found them unheld).
//
//   node scripts/test.mjs adapters/oi-nrd --name "oi-nrd events"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { loadPsl } from "@domains/names";
import { eventOf, NRD_CT_RDAP, NRD_LIST, OLD_CERT_S, type Parsed, WindowEvents } from "../src/events.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const PSL = await loadPsl(readFileSync(join(ROOT, "packages", "names", "test", "fixtures", "psl-2026-10-27.dat")));
const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const of = (kind: "domain" | "fqdn" | "confirmed", value: unknown): Parsed => eventOf(kind, bytes(JSON.stringify(value)), PSL);
const event = (p: Parsed) => {
  assert.ok("event" in p, JSON.stringify(p));
  return p.event;
};
const T = 1_793_416_204;

test("oi-nrd events: a certificate age is timestamp minus submission_timestamp, floored; a negative one is 0, and an unsafe or non-number time gives none", () => {
  const age = (timestamp: unknown, submission_timestamp: unknown) => event(of("domain", { domain: "a.com.", timestamp, submission_timestamp })).certAge;
  assert.equal(age(T, T - 30.75), 30);
  // The confirmed topic's JSON time steps back: a submission after the timestamp reads as 0.
  assert.equal(age(T, T + 50), 0);
  assert.equal(age(1e30, 1), null);
  assert.equal(age(T, String(T - 5)), null);
  assert.equal(age(String(T), T - 5), null);
  assert.equal(age(T, undefined), null);
  // A clamped age is a fact of 0, which the writer takes.
  const w = new WindowEvents("domain", 1);
  w.add(event(of("domain", { domain: "a.com.", timestamp: T, submission_timestamp: T + 50 })), T);
  assert.deepEqual(w.build().facts, [{ key: "com.a", cert_age: 0 }]);
});

test("oi-nrd events: the suspect age is over 7 days: OLD_CERT_S is 604,800 s", () => {
  assert.equal(OLD_CERT_S, 7 * 86_400);
  assert.ok(event(of("domain", { domain: "a.com.", timestamp: T, submission_timestamp: T - 6 * 86_400 })).certAge! <= OLD_CERT_S);
  assert.ok(event(of("domain", { domain: "a.com.", timestamp: T, submission_timestamp: T - 8 * 86_400 })).certAge! > OLD_CERT_S);
});

test("oi-nrd events: a confirmed row is nrd-ct+rdap only with a certificate, a whole cert_index from 0 and no zone_data; else nrd-list", () => {
  const basis = (row: Record<string, unknown>) => event(of("confirmed", { domain: "a.com.", timestamp: T, confidence: 3, ct_name: "Log", ...row })).basis;
  assert.equal(basis({ cert_index: 0 }), NRD_CT_RDAP);
  assert.equal(basis({ cert_index: 11 }), NRD_CT_RDAP);
  assert.equal(basis({ cert_index: -1 }), NRD_LIST);
  assert.equal(basis({ cert_index: 1.5 }), NRD_LIST);
  assert.equal(basis({ cert_index: "5" }), NRD_LIST);
  assert.equal(basis({ cert_index: undefined }), NRD_LIST);
  // A zone row is nrd-list whatever cert_index it carries.
  assert.equal(basis({ ct_name: "zone_data", cert_index: 5 }), NRD_LIST);
  assert.equal(event(of("confirmed", { domain: "a.com.", timestamp: T, confidence: 9, ct_name: "zone_data", cert_index: 5 })).confidence, 9);
  // A domain topic's row is nrd-list, certificate or not.
  assert.equal(event(of("domain", { domain: "a.com.", timestamp: T, ct_name: "Log", cert_index: 4 })).basis, NRD_LIST);
});

test("oi-nrd events: a confirmed confidence is a whole number from 1 to 10, else the row is malformed", () => {
  const row = (confidence: unknown) => of("confirmed", { domain: "a.com.", timestamp: T, ct_name: "Log", cert_index: 1, confidence });
  assert.equal(event(row(1)).confidence, 1);
  assert.equal(event(row(10)).confidence, 10);
  for (const bad of [0, 11, 5.5, -1, "5", null, undefined]) assert.match((row(bad) as { malformed: string }).malformed, /^a confidence .* that is not a whole number from 1 to 10$/, String(bad));
});

test("oi-nrd events: a value with a BOM, of invalid UTF-8, or a JSON array, null or string is malformed", () => {
  const malformed = (value: Uint8Array | null): string => (eventOf("domain", value, PSL) as { malformed: string }).malformed;
  const json = bytes(JSON.stringify({ domain: "a.com.", timestamp: T }));
  assert.ok("event" in eventOf("domain", json, PSL));
  assert.equal(malformed(new Uint8Array([0xef, 0xbb, 0xbf, ...json])), "a value that is not UTF-8 JSON");
  assert.equal(malformed(new Uint8Array([...json.subarray(0, 12), 0xff, ...json.subarray(12)])), "a value that is not UTF-8 JSON");
  assert.equal(malformed(bytes('["a.com."]')), "a value that is not a JSON object");
  assert.equal(malformed(bytes("null")), "a value that is not a JSON object");
  assert.equal(malformed(bytes('"a.com."')), "a value that is not a JSON object");
  assert.equal(malformed(null), "a record with no value");
  assert.equal(malformed(bytes(JSON.stringify({ fqdn: "a.com", timestamp: T }))), "a value whose domain is not a string");
});
