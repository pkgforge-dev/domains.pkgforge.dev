// packages/core/src/problem.ts: a problem answer carries the five members, the
// problem+json type and nosniff, takes extra members and headers without
// letting them replace its own, and refuses a call it cannot answer correctly,
// including the statuses that would gate a caller.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROBLEM_TYPE, ProblemError, problem, RESERVED_MEMBERS, TITLES } from "../src/problem.ts";
import { type ProvenanceRecord, ProvenanceError } from "../src/provenance.ts";

test("problem: a 404 answers problem+json with status, title, detail, reason, see and nosniff", async () => {
  const res = problem(404, "not-found", "No route answers /v2/x.");
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("content-type"), PROBLEM_TYPE);
  assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(await res.json(), { status: 404, title: "Not Found", detail: "No route answers /v2/x.", reason: "not-found", see: "/llms-full.txt#reason-not-found" });
});

test("problem: see is a relative reference, so no host is written into an answer", async () => {
  const body = (await problem(502, "source-unavailable", "GHCR answered 500.").json()) as { see: string };
  assert.ok(body.see.startsWith("/"), body.see);
  assert.doesNotMatch(body.see, /^\/\//);
});

test("problem: extra members join the body after the five, and headers join the answer", async () => {
  const res = problem(501, "unsupported-by-source", "No mirrored source holds CNAME targets.", { sources_checked: ["thc-rdns"] }, { allow: "GET, HEAD, OPTIONS" });
  const body = (await res.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(body), [...RESERVED_MEMBERS, "sources_checked"]);
  assert.deepEqual(body.sources_checked, ["thc-rdns"]);
  assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
});

test("problem: no status that gates a caller has a title, so 401, 403, 407 and 429 are refused", () => {
  for (const status of [401, 403, 407, 429]) {
    assert.equal(TITLES[status], undefined, String(status));
    assert.throws(() => problem(status, "denied", "x"), ProblemError);
  }
});

test("problem: a status outside the table, a non-integer or a success status is refused", () => {
  for (const status of [200, 302, 399, 418, 600, 404.5, Number.NaN]) assert.throws(() => problem(status, "not-found", "x"), ProblemError, String(status));
});

test("problem: a reason that is not lowercase words joined by hyphens is refused", () => {
  for (const reason of ["", "Not-Found", "not_found", "not--found", "-x", "x-", "not found"]) assert.throws(() => problem(400, reason, "x"), ProblemError, reason);
});

test("problem: an empty detail is refused", () => {
  assert.throws(() => problem(400, "bad-parameter", "   "), /detail/);
});

test("problem: an extra member cannot replace one of the five", () => {
  for (const member of RESERVED_MEMBERS) assert.throws(() => problem(400, "bad-parameter", "x", { [member]: "forged" }), new RegExp(`"${member}"`));
});

test("problem: a header cannot replace the content type or nosniff, in any case", () => {
  for (const name of ["content-type", "Content-Type", "x-content-type-options", "X-Content-Type-Options"])
    assert.throws(() => problem(400, "bad-parameter", "x", {}, { [name]: "text/html" }), ProblemError, name);
});

test("problem: an x-domains-* header passed as a plain header is refused, in any case", () => {
  for (const name of ["x-domains-cache", "X-Domains-Sources-Used", "x-domains-body"])
    assert.throws(
      () => problem(404, "not-found", "x", {}, { [name]: "hit" }),
      (err: unknown) => err instanceof ProblemError && /is provenance, which comes only from a ProvenanceRecord/.test(err.message),
      name,
    );
});

test("problem: provenance reaches an error answer only through provenanceHeaders, which refuses a claim the reads do not support", () => {
  const record: ProvenanceRecord = {
    root: `sha256:${"b".repeat(64)}`,
    asOf: "2026-10-27T05:50:00Z",
    reads: [{ tier: "ghcr", pack: "names-d-20261026", sources: ["thc-ct"] }],
    cache: "ghcr",
    sourcesUsed: [],
    sourcesFailed: ["ct-geomys"],
    body: "derived",
  };
  const res = problem(502, "source-unavailable", "GHCR answered 500.", {}, {}, record);
  assert.equal(res.headers.get("x-domains-cache"), "ghcr");
  assert.equal(res.headers.get("x-domains-sources-failed"), "ct-geomys");
  assert.equal(res.headers.get("x-domains-degraded"), "1");
  assert.equal(res.headers.get("content-type"), PROBLEM_TYPE);
  assert.throws(() => problem(502, "source-unavailable", "x", {}, {}, { ...record, cache: "hit" }), ProvenanceError);
});
