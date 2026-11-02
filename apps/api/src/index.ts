// apps/api/src/index.ts — the Worker domains-pkgforge-dev on domains.pkgforge.dev
// (DOM-030, TODO/serve.md; docs/worker.md). One Worker serves every route: one
// deploy, one rollback, one GHCR reader and one root kept in the isolate.
//
// | path               | answers                                                        |
// | ------------------ | -------------------------------------------------------------- |
// | `/healthz`         | `{ok, version, root_age_s}`, 200, or 503 (health.ts)           |
// | `/v1/index/latest` | the root digest and its GHCR references, in the envelope       |
// | `/`                | a plain text stub that names no route (guide.ts)               |
// | `/llms-full.txt`   | the reasons of an error answer, a stub until DOM-059 (guide.ts)|
//
// Every other path answers 404 `not-found`, and every method but GET, HEAD and
// OPTIONS answers 405 `method-not-allowed` with `allow`, each as the problem of
// packages/core. OPTIONS answers 204 with the CORS headers. Every answer carries
// `access-control-allow-origin: *` (answer.ts). HEAD answers as GET does, with
// the same reads and no body. The query string is ignored.
//
// No route asks for a key, an account or a quota, or limits a caller's rate
// (AGENTS.md absolute 8).
import { REGISTRY_HOST } from "@domains/ghcr";
import { ALLOW, envelope, fail, finish, json, preflight, rootProvenance, text } from "./answer.ts";
import { ApiCache } from "./cache.ts";
import type { Env, RequestContext, WaitContext } from "./context.ts";
import { readerOf } from "./ghcr.ts";
import { GUIDE_STUB, INDEX_STUB } from "./guide.ts";
import { healthz } from "./health.ts";
import { ROOT_REPO, RootUnavailable, rootOf } from "./root.ts";

export type { Env } from "./context.ts";

// The documents are kept 300 s by a client, as DOM-059's documents will be.
const DOCUMENT_CACHE = "public, max-age=300";
// A new root:latest shows within 30 s (the `man` entry of cache.ts).
const ROOT_ANSWER_CACHE = "public, max-age=30";
const RETRY_AFTER_S = "30";

// GET /v1/index/latest: the root digest and the GHCR references, so a client
// can read the root and its packs with no Worker (docs/architecture.md section 11).
async function indexLatest(c: RequestContext): Promise<Response> {
  try {
    const r = await rootOf(c.g, c.cache, c.log);
    const a = { root: r.root.digest, asOf: r.root.head.as_of, reads: r.reads, stale: r.stale };
    const data = {
      format: r.root.head.format,
      root_seq: r.root.head.root_seq,
      as_of: r.root.head.as_of,
      root: r.root.digest,
      references: {
        root_latest: `${REGISTRY_HOST}/${ROOT_REPO}:latest`,
        root_digest: `${REGISTRY_HOST}/${ROOT_REPO}@${r.root.digest}`,
      },
    };
    return json(200, envelope(data, a), { ...rootProvenance(a), "cache-control": r.stale ? "no-store" : ROOT_ANSWER_CACHE });
  } catch (err) {
    if (!(err instanceof RootUnavailable)) throw err;
    c.log(`no root: ${err.message}`);
    return err.missing
      ? fail(503, "no-root", `${err.message}.`, { "retry-after": RETRY_AFTER_S })
      : fail(502, "source-unavailable", `The root could not be read from GHCR: ${err.message}.`, { "retry-after": RETRY_AFTER_S });
  }
}

type Handler = (c: RequestContext) => Promise<Response> | Response;

const ROUTES: Readonly<Record<string, Handler>> = Object.freeze({
  "/": () => text(INDEX_STUB, DOCUMENT_CACHE),
  "/llms-full.txt": () => text(GUIDE_STUB, DOCUMENT_CACHE),
  "/healthz": healthz,
  "/v1/index/latest": indexLatest,
});

export async function handle(request: Request, env: Env, ctx: WaitContext): Promise<Response> {
  const method = request.method;
  if (method === "OPTIONS") return preflight();
  const url = new URL(request.url);
  if (method !== "GET" && method !== "HEAD") return fail(405, "method-not-allowed", `This service answers ${ALLOW}, not ${method}.`, { allow: ALLOW });
  const route = Object.hasOwn(ROUTES, url.pathname) ? ROUTES[url.pathname] : undefined;
  if (route === undefined) return fail(404, "not-found", `No route answers ${url.pathname}.`);
  let ray = "-";
  const log = (message: string): void => console.error(`domains-pkgforge-dev ${ray}: ${message}`);
  // Everything a route needs is made inside the try, so a fault in any of it is
  // the 500 problem with CORS, never a platform error.
  try {
    ray = request.headers.get("cf-ray") ?? "-";
    const cache = new ApiCache({ host: url.host, ray, waitUntil: (p) => ctx.waitUntil(p) });
    const c: RequestContext = { env, g: readerOf(cache), cache, ray, now: () => Date.now(), log };
    return await route(c);
  } catch (err) {
    log(`internal error on ${url.pathname}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
    return fail(500, "internal-error", "The Worker failed while it made the answer.");
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: WaitContext): Promise<Response> {
    return finish(request.method, await handle(request, env, ctx));
  },
};
