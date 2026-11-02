// apps/api/src/guide.ts — the reasons of every error answer, and the two plain
// text stubs the Worker serves until DOM-059 generates the root documents from
// the route registry (docs/architecture.md section 7.7).
//
// Every error answer is the problem of packages/core, whose `see` member is
// /llms-full.txt#reason-<reason>. So the stub at /llms-full.txt holds, for each
// reason below, its marker `reason-<reason>` and one line on what it means and
// whether to retry. A browser does not move to a fragment of a plain text file,
// so a reader finds the line by a search for the marker.
//
// ⛔ Neither stub names a route. Ruling 26 (TODO/RULES.md section 5) keeps the
// documents of the routes until the project is ready, and by the agent's reading
// nothing documents a route before DOM-059 writes the guide in this one's place.
import { SOURCE_URL } from "@domains/ghcr";

// The reasons of DOM-059's list (TODO/serve.md), and internal-error, the
// answer to a fault of the Worker itself. Each line says what the reason means
// and whether to retry. It names no route, and no feature of a route that is
// not deployed yet, such as a bulk file or a cursor to follow.
export const REASONS = Object.freeze({
  "not-found": "No route answers the path. Do not retry the same path.",
  "method-not-allowed": "The path does not answer this method. The allow header names the methods it answers. Do not retry with the same method.",
  "bad-parameter": "A parameter is not one the route reads, or its value is out of range. Do not retry; correct the request.",
  "bad-window": "The time window cannot be read: a bound is not a time, or the start is after the end. Do not retry; correct the request.",
  "window-too-large": "The time window is longer than one request reads. Do not retry; ask for a shorter window.",
  "unknown-suffix": "The suffix is not a public suffix of the list in use. Do not retry; correct the suffix.",
  "bad-cursor": "The cursor is not one this service gave, or it was given for another root. Do not retry it; start the listing again.",
  "work-budget": "The answer needs more reads than one request makes. Retry with a narrower request.",
  "not-implemented": "The service does not answer this request yet. Do not retry.",
  "unsupported-by-source": "No source the service mirrors holds this kind of record. Do not retry.",
  "no-root": "GHCR holds no root the service can read. Retry after the seconds in retry-after.",
  "source-unavailable": "GHCR did not answer in time, or answered with something the service refuses. Retry after the seconds in retry-after, with backoff.",
  "internal-error": "The service failed while it made the answer. Retry with backoff.",
} as const);

export type Reason = keyof typeof REASONS;

// The marker of a reason in the stub, which the `see` member of its problem names.
export const marker = (reason: Reason): string => `reason-${reason}`;

// GET /llms-full.txt until DOM-059.
export const GUIDE_STUB = [
  "# domains.pkgforge.dev: the reasons of an error answer",
  "",
  "An error answer of domains.pkgforge.dev is application/problem+json with the members status, title, detail, reason and see.",
  "The member see names /llms-full.txt#reason-<reason>. Search this file for that marker.",
  "This file holds the reasons only. The full guide replaces it when the project is ready.",
  "",
  ...Object.entries(REASONS).map(([reason, line]) => `${marker(reason as Reason)}: ${line}`),
  "",
].join("\n");

// GET / until DOM-059.
export const INDEX_STUB = [
  "domains.pkgforge.dev",
  "",
  "Certificate-transparency names, and newly registered and newly seen domains, as open data.",
  "This service asks for no key and no account, and sets no rate limit.",
  "The documents of the routes are published when the project is ready.",
  `Source: ${SOURCE_URL}`,
  "",
].join("\n");
