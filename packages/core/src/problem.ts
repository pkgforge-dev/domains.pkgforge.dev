// packages/core/src/problem.ts — the one error answer: an
// `application/problem+json` Response (docs/architecture.md section 7.1) whose
// body holds `status`, `title`, `detail`, `reason` and `see`, with
// `x-content-type-options: nosniff` so no browser reads a name inside it as
// markup (SECURITY.md).
//
//   problem(404, "not-found", "No route answers /v2/x.")
//   problem(501, "unsupported-by-source", "No mirrored source holds CNAME targets.", { sources_checked: ["thc-rdns"] })
//   problem(405, "method-not-allowed", "Use GET or HEAD.", {}, { allow: "GET, HEAD, OPTIONS" })
//
// A wrong call throws ProblemError instead of answering a malformed problem: a
// status with no title in TITLES, a reason that is not kebab-case, an empty
// detail, an extra member that would overwrite one of the five, a header that
// would replace the content type or `nosniff`, or an `x-domains-*` header
// passed as a plain header. Provenance reaches an error answer only as a
// ProvenanceRecord, through provenanceHeaders(), which refuses a claim the
// reads do not support (AGENTS.md absolute 11):
//
//   problem(502, "source-unavailable", "GHCR answered 500.", {}, {}, record)

import { type ProvenanceRecord, provenanceHeaders } from "./provenance.ts";

export const PROBLEM_TYPE = "application/problem+json";

// The error statuses this project answers, with their RFC 9110 titles. 401, 403,
// 407 and 429 are absent on purpose: no surface refuses a caller for a key, an
// account or a rate (AGENTS.md absolute 8), so the builder cannot produce one.
export const TITLES: Readonly<Record<number, string>> = Object.freeze({
  400: "Bad Request",
  404: "Not Found",
  405: "Method Not Allowed",
  406: "Not Acceptable",
  408: "Request Timeout",
  409: "Conflict",
  410: "Gone",
  411: "Length Required",
  412: "Precondition Failed",
  413: "Content Too Large",
  414: "URI Too Long",
  415: "Unsupported Media Type",
  416: "Range Not Satisfiable",
  422: "Unprocessable Content",
  431: "Request Header Fields Too Large",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
});

// The five members every problem carries. An extra member never replaces one.
export const RESERVED_MEMBERS = Object.freeze(["status", "title", "detail", "reason", "see"] as const);

// Where a caller reads what a reason means: a relative reference, resolved
// against the request URL, so no host is written here. The guide that DOM-059
// generates carries the marker `reason-<reason>` for each reason.
const SEE_BASE = "/llms-full.txt#reason-";

// A reason is the stable machine name of a failure: lowercase words joined by
// single hyphens, the grammar of the source ids.
const REASON = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Headers the builder owns: a caller cannot replace them. Every
// `x-domains-*` header is the provenance builder's alone.
const OWNED_HEADERS = new Set(["content-type", "x-content-type-options"]);
const PROVENANCE_PREFIX = "x-domains-";

export class ProblemError extends Error {
  override name = "ProblemError";
}

export function problem(
  status: number,
  reason: string,
  detail: string,
  extra: Readonly<Record<string, unknown>> = {},
  headers: Readonly<Record<string, string>> = {},
  provenance?: ProvenanceRecord,
): Response {
  const title = Number.isInteger(status) ? TITLES[status] : undefined;
  if (title === undefined) throw new ProblemError(`problem: status ${status} has no title in TITLES`);
  if (!REASON.test(reason)) throw new ProblemError(`problem: reason "${reason}" is not lowercase words joined by hyphens`);
  if (detail.trim() === "") throw new ProblemError(`problem: the detail of reason "${reason}" is empty`);
  for (const member of RESERVED_MEMBERS) {
    if (Object.hasOwn(extra, member)) throw new ProblemError(`problem: the extra member "${member}" would replace one of the five members`);
  }
  const out = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    if (OWNED_HEADERS.has(name.toLowerCase())) throw new ProblemError(`problem: the header "${name}" is set by the builder and cannot be replaced`);
    if (name.toLowerCase().startsWith(PROVENANCE_PREFIX)) throw new ProblemError(`problem: the header "${name}" is provenance, which comes only from a ProvenanceRecord`);
    out.set(name, value);
  }
  if (provenance !== undefined) for (const [name, value] of Object.entries(provenanceHeaders(provenance))) out.set(name, value);
  out.set("content-type", PROBLEM_TYPE);
  out.set("x-content-type-options", "nosniff");
  const body = { status, title, detail, reason, see: `${SEE_BASE}${reason}`, ...extra };
  return new Response(JSON.stringify(body), { status, headers: out });
}
