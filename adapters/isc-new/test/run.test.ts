import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { gzipSync } from "node:zlib";
import { type AdapterContext, canonicalJson, checkResult, type Cursor, type Fetch, memoryWriter, sha256Hex } from "@domains/adapter";
import { loadPsl } from "@domains/names";
import { markOf, parseCursor } from "../src/cursor.ts";
import { datedUrl, DPK1_EPOCH_DAY, inspectIndexedRevision, ISC_FEEDS, MAX_DAYS_PER_RUN, MAX_GZIP_BYTES, run } from "../src/index.ts";

const ALIAS = `${ISC_FEEDS}domaindata.json.gz`;
const psl = await loadPsl(readFileSync(new URL("../../../packages/names/test/fixtures/psl-2026-10-27.dat", import.meta.url)));
const modified = "Mon, 05 Jan 2026 23:41:00 GMT";
const raw = (firstseen: string): Uint8Array<ArrayBuffer> => Uint8Array.from(gzipSync(JSON.stringify([{ domainname: "isc.example.com", firstseen }])));
const etag = (day: string): string => `"${day}"`;

function body(day: string): Response {
  const gzip = raw(day);
  return new Response(gzip, { headers: { etag: etag(day), "last-modified": modified, "content-length": String(gzip.byteLength) } });
}

type Ask = { method: string; url: string; etag: string | null };
type Responder = (ask: Ask) => Response;

const ordinary: Responder = ({ method, url }) => {
  if (method === "HEAD") {
    assert.equal(url, ALIAS);
    return new Response(null, { headers: { etag: '"alias-0"', "last-modified": modified } });
  }
  const day = /\.(\d{4}-\d{2}-\d{2})\.json\.gz$/.exec(url)?.[1];
  assert.ok(day);
  return body(day);
};

async function drive(cursor: Cursor, now: string, respond: Responder = ordinary) {
  const requests: Ask[] = [];
  const fetch: Fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("user-agent"), "isc-new candidate test");
    assert.equal(headers.get("accept-encoding"), "identity");
    const ask = { method: init?.method ?? "GET", url: String(input), etag: headers.get("if-none-match") };
    requests.push(ask);
    return respond(ask);
  };
  const writer = memoryWriter();
  const ctx: AdapterContext = { writer, psl, now, fetch, userAgent: "isc-new candidate test", connect: () => assert.fail("ISC uses HTTP") };
  const result = checkResult(await run(cursor, ctx), "isc-new scratch run");
  assert.equal(result.segments.length, writer.written.length);
  return { requests, result, state: parseCursor(result.cursor), written: writer.written };
}

test("ISC run: a date is eligible only at the chosen D+5 UTC grace instant", async () => {
  const early = await drive(null, "2026-01-05T23:59:59Z");
  assert.deepEqual(early.requests, [{ method: "HEAD", url: ALIAS, etag: null }]);
  assert.equal(early.state.next, DPK1_EPOCH_DAY);
  assert.deepEqual(early.written, []);
  const later = await drive(early.result.cursor, "2026-01-06T00:00:00Z");
  assert.deepEqual(later.requests, [
    { method: "HEAD", url: ALIAS, etag: '"alias-0"' },
    { method: "GET", url: datedUrl("2026-01-01"), etag: null },
  ]);
  assert.equal(later.state.next, "2026-01-02");
  assert.equal(later.written[0]?.url, datedUrl("2026-01-01"));
  assert.equal(later.written[0]?.segment.window.start, "2026-01-01T00:00:00Z");
  assert.equal(later.state.watch[0]?.digest, await sha256Hex(raw("2026-01-01")));
});

test("ISC run: bootstrap works oldest-first and stops at four eligible dated GETs", async () => {
  const r = await drive(null, "2026-02-15T04:00:00Z");
  const expected = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"];
  assert.equal(r.result.stats.dated_gets, MAX_DAYS_PER_RUN);
  assert.equal(r.result.stats.indexed_days, 4);
  assert.equal(r.state.next, "2026-01-05");
  assert.deepEqual(
    r.requests.filter((q) => q.method === "GET").map((q) => q.url),
    expected.map(datedUrl),
  );
  assert.deepEqual(
    r.written.map((item) => item.url),
    expected.map(datedUrl),
  );
  assert.deepEqual(r.state.watch, []);
});

test("ISC run: an unavailable oldest day keeps completed writes and resumes from the failed day next hour", async () => {
  for (const fault of [404, 503, 200]) {
    const first = await drive(null, "2026-02-15T04:00:00Z", (q) => {
      if (q.url === datedUrl("2026-01-02")) return fault === 200 ? new Response(gzipSync("[]")) : new Response(null, { status: fault });
      return ordinary(q);
    });
    assert.equal(first.state.next, "2026-01-02");
    assert.equal(first.written.length, 1);
    assert.deepEqual(
      first.result.errors.map((e) => e.code),
      [fault === 503 ? "dated-read" : "dated-pending"],
    );
    assert.equal(first.result.gaps, undefined);
    const sameHour = await drive(first.result.cursor, "2026-02-15T04:30:00Z", () => assert.fail("same hour retry should make no HTTP request"));
    assert.deepEqual(sameHour.requests, []);
    assert.deepEqual(sameHour.result.cursor, first.result.cursor);
    const nextHour = await drive(sameHour.result.cursor, "2026-02-15T05:00:00Z");
    assert.equal(nextHour.requests[1]?.url, datedUrl("2026-01-02"));
    assert.equal(nextHour.state.next, "2026-01-06");
  }
});

test("ISC run: repeated failures renew the hourly retry marker without declaring a gap", async () => {
  const fail = (q: Ask): Response => (q.method === "GET" ? new Response(null, { status: 404 }) : ordinary(q));
  const first = await drive(null, "2026-02-15T04:00:00Z", fail);
  const second = await drive(first.result.cursor, "2026-02-15T05:00:00Z", fail);
  assert.equal(second.state.blockedHour, first.state.blockedHour! + 1);
  assert.equal(second.state.next, DPK1_EPOCH_DAY);
  assert.equal(second.result.gaps, undefined);
  assert.deepEqual(second.written, []);
  const quiet = await drive(second.result.cursor, "2026-02-15T05:30:00Z", () => assert.fail("same hour retry should make no HTTP request"));
  assert.deepEqual(quiet.requests, []);
  assert.deepEqual(quiet.result.cursor, second.result.cursor);
});

test("ISC run: alias failure is independent of dated publication", async () => {
  const result = await drive(null, "2026-01-06T00:00:00Z", (q) => (q.method === "HEAD" ? new Response(null, { status: 503 }) : ordinary(q)));
  assert.deepEqual(
    result.result.errors.map((e) => e.code),
    ["alias-read"],
  );
  assert.equal(result.written.length, 1);
  assert.equal(result.written[0]?.url, datedUrl(DPK1_EPOCH_DAY));
  assert.equal(result.result.stats.alias_last_modified_age_s, undefined);
});

test("ISC run: post-grace metadata revisions preserve the indexed digest, and HEAD cannot cause overlapping writes", async () => {
  const first = await drive(null, "2026-01-06T00:00:00Z");
  const observed = await drive(first.result.cursor, "2026-01-06T01:00:00Z", ({ method, url, etag: sent }) => {
    assert.equal(method, "HEAD");
    if (url === ALIAS) {
      assert.equal(sent, '"alias-0"');
      return new Response(null, { status: 304 });
    }
    assert.equal(url, datedUrl("2026-01-01"));
    assert.equal(sent, etag("2026-01-01"));
    return new Response(null, { headers: { etag: '"revised-head"' } });
  });
  assert.equal(observed.result.stats.dated_header_changes_pending, 1);
  assert.equal(observed.result.stats.alias_metadata_idle_h, 1);
  assert.deepEqual(
    observed.result.errors.map((e) => e.code),
    ["dated-review"],
  );
  assert.equal(observed.state.watch[0]?.digest, first.state.watch[0]?.digest);
  assert.equal(observed.state.watch[0]?.mark.etag, '"revised-head"');
  assert.equal(observed.state.watch[0]?.changed, true);
  assert.equal(observed.state.next, "2026-01-02");
  assert.deepEqual(observed.written, []);
  const next = await drive(observed.result.cursor, "2026-01-06T01:30:00Z", () => assert.fail("same hour review should make no HTTP request"));
  assert.deepEqual(next.requests, []);
  assert.deepEqual(next.written, []);
  assert.equal(next.result.stats.dated_header_changes_pending, 1);
});

test("ISC run: review advances through distinct watched days even when runs are three hours apart", async () => {
  const start = await drive(null, "2026-01-08T00:00:00Z");
  assert.equal(start.state.watch.length, 3);
  let cursor = start.result.cursor;
  const seen: string[] = [];
  for (const hour of ["03", "06", "09"]) {
    const later = await drive(cursor, `2026-01-08T${hour}:00:00Z`, (q) => {
      assert.equal(q.method, "HEAD");
      if (q.url !== ALIAS) seen.push(q.url);
      return new Response(null, { status: 304 });
    });
    assert.deepEqual(later.result.errors, []);
    assert.deepEqual(later.written, []);
    cursor = later.result.cursor;
  }
  assert.deepEqual(seen, ["2026-01-02", "2026-01-03", "2026-01-01"].map(datedUrl));
});

test("ISC run: the largest validator state fits the OCI cursor and invalid dates are refused before fetch", async () => {
  const largeTag = `"${"\\".repeat(34)}"`;
  const mark = markOf({ etag: largeTag, lastModified: "Fri, 31 Dec 9999 23:59:59 GMT" }, MAX_GZIP_BYTES);
  assert.equal(mark.etag, largeTag);
  const watch = ["2026-01-01", "2026-01-02", "2026-01-03"].map((day) => ({ day, mark, digest: "0".repeat(64), changed: true }));
  const cursor = { next: "2026-01-04", alias: { mark, since: 70389527, hour: 70389527 }, watch, review: { hour: 70389527, day: "2026-01-03" }, blockedHour: 70389527 };
  assert.deepEqual(parseCursor(cursor), cursor);
  assert.ok(Buffer.byteLength(canonicalJson(cursor)) <= 1024);
  await assert.rejects(
    drive({ ...cursor, next: "2025-12-31" }, "2026-02-15T04:00:00Z", () => assert.fail("invalid cursor should make no request")),
    {
      name: "ContractError",
      message: /cursor: isc-new: next must be an indexed UTC day/,
    },
  );
});

test("ISC revision: unconditional raw review proves change independently of ETag and does not write any segment", async () => {
  const day = DPK1_EPOCH_DAY;
  const previousBody = Uint8Array.from(gzipSync(JSON.stringify([{ domainname: "a.example.com", firstseen: day }]), { level: 0 }));
  const revisedBody = Uint8Array.from(gzipSync(JSON.stringify([{ domainname: "b.example.com", firstseen: day }]), { level: 0 }));
  assert.equal(previousBody.byteLength, revisedBody.byteLength);
  const digest = await sha256Hex(previousBody);
  const context = (data: Uint8Array<ArrayBuffer>, etag: string) => ({
    userAgent: "isc-new archive inspection test",
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(input), datedUrl(day));
      assert.equal(init?.method, "GET");
      const headers = new Headers(init.headers);
      assert.equal(headers.has("if-none-match"), false);
      assert.equal(headers.has("if-modified-since"), false);
      return new Response(data, { headers: { etag } });
    },
  });
  const relabel = await inspectIndexedRevision(context(previousBody, '"different"'), day, digest);
  assert.equal(relabel.kind, "same");
  assert.equal(relabel.file.sha256, digest);
  const changed = await inspectIndexedRevision(context(revisedBody, '"original"'), day, digest);
  assert.equal(changed.kind, "changed");
  assert.deepEqual([changed.day, changed.rows, changed.previousDigest], [day, 1, digest]);
  assert.notEqual(changed.file.sha256, digest);
  assert.deepEqual(changed.file.raw, revisedBody);
  const otherDay = raw("2026-01-02");
  const unverified = await inspectIndexedRevision(context(otherDay, '"original"'), day, digest);
  assert.equal(unverified.kind, "unverified");
  assert.equal(unverified.fault.code, "date");
  assert.deepEqual(unverified.file.raw, otherDay);
});
