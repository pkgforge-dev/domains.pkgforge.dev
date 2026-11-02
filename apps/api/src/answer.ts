// apps/api/src/answer.ts — the shapes of an answer (docs/architecture.md
// section 7.1): JSON in the envelope `{data, meta}`, plain text, the problem of
// packages/core for every error, and the headers every answer carries.
//
// Every answer carries `access-control-allow-origin: *` and no credential is
// ever allowed. `finish` adds the CORS headers to whatever a route answered,
// and gives HEAD the answer of GET with no body. A JSON answer's provenance
// comes only from provenanceHeaders of packages/core, which refuses a claim
// its reads do not support (AGENTS.md absolute 11).
import { cacheOf, type PackRead, problem, provenanceHeaders } from "@domains/core";
import type { Reason } from "./guide.ts";

export const ALLOW = "GET, HEAD, OPTIONS";
// The headers a page in a browser may read beside the safelisted ones.
const EXPOSE = [
  "x-domains-root",
  "x-domains-as-of",
  "x-domains-tiers-read",
  "x-domains-sources-used",
  "x-domains-sources-failed",
  "x-domains-cache",
  "x-domains-body",
  "x-domains-degraded",
  "retry-after",
  "allow",
].join(", ");

export const CORS: Readonly<Record<string, string>> = Object.freeze({
  "access-control-allow-origin": "*",
  "access-control-expose-headers": EXPOSE,
});

// A preflight: any method this Worker answers, any request header, for a day.
export function preflight(): Response {
  return new Response(null, {
    status: 204,
    headers: { allow: ALLOW, "access-control-allow-methods": ALLOW, "access-control-allow-headers": "*", "access-control-max-age": "86400" },
  });
}

// The answer as it leaves the Worker: CORS on every answer, and no body for HEAD.
export function finish(method: string, res: Response): Response {
  const headers = new Headers(res.headers);
  for (const [name, value] of Object.entries(CORS)) headers.set(name, value);
  const body = method === "HEAD" || res.status === 204 ? null : res.body;
  return new Response(body, { status: res.status, statusText: res.statusText, headers });
}

export function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff" },
  });
}

export function text(body: string, cacheControl: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": cacheControl },
  });
}

// An error answer. A reason outside the list of guide.ts does not type-check,
// so every `see` names a marker the stub at /llms-full.txt holds.
export function fail(status: number, reason: Reason, detail: string, headers: Record<string, string> = {}): Response {
  return problem(status, reason, detail, {}, { "cache-control": "no-store", ...headers });
}

// What an answer from the root alone read, for its provenance and its meta.
export interface Answered {
  readonly root: string;
  readonly asOf: string | null;
  readonly reads: readonly PackRead[];
  readonly stale: boolean;
}

// The provenance of an answer from the root alone: the tiers its root reads
// used in `x-domains-cache` (none on a stale answer, whose request read
// nothing that served it), no pack, so `x-domains-tiers-read: 0`, no source, a
// derived body, and degraded when the root is stale.
export function rootProvenance(a: Answered): Record<string, string> {
  return provenanceHeaders({ root: a.root, asOf: a.asOf, reads: a.reads, cache: cacheOf(a.reads), sourcesUsed: [], body: "derived", stale: a.stale });
}

// The envelope of section 7.1 for an answer that reads the root alone: no
// source and no pack tier answered, so `sources_used` and `tiers_read` are
// empty, as `x-domains-tiers-read` is 0, and the answer is whole. It carries no
// `corpus_since` and no `confidence`: section 7.1 gives them to an answer
// that reads a dataset, and a route that reads one adds them.
export function envelope(data: unknown, a: Answered): { data: unknown; meta: Record<string, unknown> } {
  return {
    data,
    meta: { as_of: a.asOf, root: a.root, sources_used: [], sources_failed: [], tiers_read: [], partial: false, next_cursor: null },
  };
}
