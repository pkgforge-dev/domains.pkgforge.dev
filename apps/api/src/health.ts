// apps/api/src/health.ts — GET /healthz: `{ok, version, root_age_s}`
// (docs/architecture.md section 7.2).
//
// - `version` is the BUILD variable the deploy sets, the 12 hex digits of the
//   commit (`--var BUILD:$(git rev-parse --short=12 HEAD)`), or null when the
//   deploy set none or another value.
// - `root_age_s` is the whole seconds since the root's `created`, the time its
//   promotion built it, so it grows while no promotion moves the root. It is
//   null when no root can be read.
// - 200 with `ok: true` while the age is at most ROOT_AGE_MAX_S; 503 with
//   `ok: false` above it, and when no root can be read.
// The answer is never stored: `cache-control: no-store`.
import { rootProvenance } from "./answer.ts";
import type { RequestContext } from "./context.ts";
import { ageOf, RootUnavailable, rootOf } from "./root.ts";

export const ROOT_AGE_MAX_S = 6 * 60 * 60;
const BUILD = /^[0-9a-f]{12}$/;

export function versionOf(build: unknown): string | null {
  return typeof build === "string" && BUILD.test(build) ? build : null;
}

const answer = (status: number, body: { ok: boolean; version: string | null; root_age_s: number | null }, headers: Record<string, string> = {}): Response =>
  new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: { ...headers, "content-type": "application/json; charset=utf-8", "x-content-type-options": "nosniff", "cache-control": "no-store" },
  });

export async function healthz(c: RequestContext): Promise<Response> {
  const version = versionOf(c.env.BUILD);
  try {
    const r = await rootOf(c.g, c.cache, c.log);
    const age = ageOf(r.root, c.now());
    const ok = age <= ROOT_AGE_MAX_S;
    if (!ok) c.log(`the root ${r.root.digest} is ${age} s old, above ${ROOT_AGE_MAX_S} s`);
    const headers = rootProvenance({ root: r.root.digest, asOf: r.root.head.as_of, reads: r.reads, stale: r.stale });
    return answer(ok ? 200 : 503, { ok, version, root_age_s: age }, headers);
  } catch (err) {
    if (!(err instanceof RootUnavailable)) throw err;
    c.log(`no root: ${err.message}`);
    return answer(503, { ok: false, version, root_age_s: null }, { "retry-after": "30" });
  }
}
