// web.pkgforge.dev@40c120cb5d6b2cf4080baedd4de773cdca325fef apps/forge/src/ghcr.ts
// The source repository is private: no reader of this project can open it, and this copy is the record.
// A reference to start from, copied verbatim below this header. It does not build here: its imports (@web/store, @web/providers and the sibling files answer.ts, cache.ts, limits.ts) are in the other repository.
// The parts to take are the token flow (send, bearerRealm, tokenKept, tokenNew, ghcr) and the tag paging (nextTagPage, readTags). DOM-019 in TODO/storage.md ports them.
// `/ghcr/<repository path>` (WEB-112): the GitHub Container Registry's public packages, read with
// the registry's anonymous pull. The client ports mirror-archlinux's (`send`, `bearerRealm`,
// `tokenKept`, `tokenNew` and `ghcr`, `archmirror@02debbe:worker/src/index.js:212-376`), with the
// repository the caller's path, not one fixed namespace:
// - every request sends the dummy token `Bearer QQ==` first, which GHCR accepts for a public
//   package; a `401` or `403` reads the Bearer challenge, accepts its realm only as https on
//   ghcr.io, asks it for a pull token of `repository:<path>:pull`, and asks again once with it. The
//   token is kept in the isolate for its lifetime less 30 s, at most 300 s, and sent first after;
//   it is never stored, since it is a credential however anonymous.
// - the grammar of api.ghcr (`apighcr@e444965:worker.js:44-381`), with its four measured defects
//   fixed (the report's §3.4): `?tags` reads every page, following `Link` to the end, at most
//   TAG_PAGES_MAX pages of TAG_PAGE; `?tag` is the last listed tag read across every page, and
//   `?tag&query=P` the last listed match (the operator's ruling 4 of 2026-10-22); `?manifest` and
//   `?download=F` take `tag=T`, `query=P` or neither (the latest); a download's range answer carries
//   `Content-Range`, `Accept-Ranges`, `ETag` and `Content-Length`.
// - `/ghcr/v2/<path>`: any other `GET` or `HEAD` of the registry API, with the same token flow;
//   its redirect (a blob's signed URL) is handed back, its `Link` names this host.
// - a file is streamed, never redirected to its signed URL: an `<img>` of an `.svg` needs
//   `image/svg+xml`, which the blob host does not send (the report's §3.2). The body is the
//   runtime's own, so it costs no CPU per MB (WEB-011).
// - stored (cache.ts): a tag list GHCR_TTL_S.tags; a manifest by tag GHCR_TTL_S.manifestByTag, by
//   digest GHCR_TTL_S.manifestByDigest. A file is not stored.
import type { StoreEnv } from "@web/store";
import { readBytesCapped, readTextCapped } from "@web/providers";
import { baseOf, bodyFor, type ForgeOutcome, headerToken, problem, provenance, rewriteLink, sha256Hex } from "./answer.ts";
import { CACHE_PREFIX, readText, writeText } from "./cache.ts";
import { GHCR_REQUEST_MS, GHCR_TTL_S, MANIFEST_BYTES, PATH_CHARS, TAG_PAGE, TAG_PAGES_MAX, TOKEN_BYTES, TOKEN_TTL_S } from "./limits.ts";

export const REGISTRY_HOST = "ghcr.io";
export const REGISTRY = `https://${REGISTRY_HOST}`;
/** The dummy token GHCR accepts for a public package (`apighcr@e444965:worker.js:62`). */
export const DUMMY = "Bearer QQ==";
/** The manifest types asked for, api.ghcr's list (`apighcr@e444965:worker.js:155-158`). */
export const MANIFEST_ACCEPT =
  "application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.oci.artifact.manifest.v1+json";
/** The annotation a layer is found by. */
export const TITLE = "org.opencontainers.image.title";
/** The hosts GHCR's blob redirect lands on; a file is fetched from no other. */
export const BLOB_HOST_SUFFIX = ".githubusercontent.com";
/** The provider and account an answer names: the registry, keyless. */
export const PROVIDER = "ghcr";
export const ACCOUNT = "keyless";
/** The prefix of this leg on this service. */
export const PREFIX = "/ghcr";

/**
 * A repository path as the OCI distribution spec names one: lowercase components of letters and
 * digits joined by `.`, `_`, `__` or dashes, at least two (owner and name), at most 255 characters.
 */
export const NAME = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)+$/;
/** A tag (the spec's grammar) or a digest. */
const REF = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]{0,127}|sha256:[0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** The content type a file is answered with, by its name, as api.ghcr sets it (`apighcr@e444965:worker.js:205-220`). */
export function contentTypeOf(file: string): string {
  const f = file.toLowerCase();
  if (f.endsWith(".json")) return "application/json; charset=utf-8";
  if (f.endsWith(".log")) return "text/plain; charset=utf-8";
  if (f.endsWith(".png")) return "image/png";
  if (f.endsWith(".svg")) return "image/svg+xml";
  if (f.endsWith(".xml")) return "application/xml; charset=utf-8";
  return "application/octet-stream";
}

// ---------------------------------------------------------------- the client

/** A registry request that could not be answered: the dial failed or timed out, or GHCR refused the pull. */
export class GhcrFault extends Error {
  readonly kind: "timeout" | "unreachable" | "refused";
  readonly status: number | null;
  constructor(kind: "timeout" | "unreachable" | "refused", message: string, status: number | null = null) {
    super(message);
    this.name = "GhcrFault";
    this.kind = kind;
    this.status = status;
  }
}

/** What one isolate keeps between its requests: repository -> pull token. A shortcut, never the only copy. */
const tokens = new Map<string, { token: string; expires: number }>();
const TOKENS_MAX = 256;

/** The state of a new isolate; the tests call it before each test. */
export function resetTokens(): void {
  tokens.clear();
}

/** The dial of one request, counting each, so the answer's event says how many GHCR requests it made. */
export interface Dialer {
  fetcher: typeof fetch;
  count: number;
}

/**
 * One request: `authorization` (none when null), no redirect followed, the head bounded by
 * GHCR_REQUEST_MS. The bound ends when the head arrives, so a file's body streams on.
 */
export async function send(d: Dialer, url: string, authorization: string | null, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET"): Promise<Response> {
  const h: Record<string, string> = { ...headers };
  if (authorization !== null) h.authorization = authorization;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), GHCR_REQUEST_MS);
  d.count += 1;
  try {
    return await d.fetcher(url, { method, headers: h, redirect: "manual", signal: stop.signal });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (stop.signal.aborted || name === "AbortError" || name === "TimeoutError") throw new GhcrFault("timeout", `GHCR did not answer within ${GHCR_REQUEST_MS / 1000} s`);
    throw new GhcrFault("unreachable", "GHCR could not be reached");
  } finally {
    clearTimeout(timer);
  }
}

/** The realm of a Bearer challenge, or null. */
export function bearerRealm(www: string | null): string | null {
  if (typeof www !== "string" || !/^\s*bearer\s/i.test(www)) return null;
  return /\brealm="([^"]*)"/i.exec(www)?.[1] ?? null;
}

/** A pull token for `repo` this isolate holds, or null. */
export function tokenKept(repo: string, now = Date.now()): string | null {
  const t = tokens.get(repo);
  if (t && t.expires > now) return t.token;
  tokens.delete(repo);
  return null;
}

async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => undefined);
}

/**
 * A new pull token for `repo` from the realm of GHCR's Bearer challenge. `refused` is the status that
 * refused the token sent, and `www` its challenge. A realm that is not https on ghcr.io is refused.
 */
export async function tokenNew(d: Dialer, repo: string, url: string, refused: number, www: string | null): Promise<string> {
  const why = `GHCR answered ${refused} for an anonymous pull of ${repo}`;
  let realm = bearerRealm(www);
  if (realm === null && refused === 403) {
    // GHCR answers 403 with no challenge; a request with no authorization gets 401 with one.
    const bare = await send(d, url, null);
    realm = bearerRealm(bare.headers.get("www-authenticate"));
    await discard(bare);
  }
  if (realm === null) throw new GhcrFault("refused", `${why}, and sent no Bearer challenge`, refused);
  let u: URL;
  try {
    u = new URL(realm);
  } catch {
    throw new GhcrFault("refused", `${why}, and its Bearer challenge names a realm that is not a URL`, refused);
  }
  if (u.protocol !== "https:" || u.hostname !== REGISTRY_HOST) throw new GhcrFault("refused", `${why}, and its Bearer challenge names a realm that is not https on ${REGISTRY_HOST}`, refused);
  u.searchParams.set("service", REGISTRY_HOST);
  u.searchParams.set("scope", `repository:${repo}:pull`);
  const res = await send(d, u.href, null);
  if (res.status !== 200) {
    await discard(res);
    throw new GhcrFault("refused", `${why}, and its token request answered ${res.status}`, res.status === 401 || res.status === 403 ? refused : res.status);
  }
  const text = await readTextCapped(res.body, TOKEN_BYTES);
  type TokenAnswer = { token?: unknown; access_token?: unknown; expires_in?: unknown };
  let body: TokenAnswer | null = null;
  try {
    body = text === null ? null : (JSON.parse(text) as TokenAnswer);
  } catch {
    // Not JSON: no token.
  }
  const token = [body?.token, body?.access_token].find((t): t is string => typeof t === "string" && t !== "");
  if (token === undefined) throw new GhcrFault("refused", `${why}, and its token answer holds no token`, refused);
  const lifetime = typeof body?.expires_in === "number" && Number.isFinite(body.expires_in) ? Math.min(body.expires_in - TOKEN_TTL_S.margin, TOKEN_TTL_S.max) : TOKEN_TTL_S.none;
  if (lifetime >= 1) {
    if (tokens.size >= TOKENS_MAX) tokens.delete(tokens.keys().next().value as string);
    tokens.set(repo, { token, expires: Date.now() + lifetime * 1000 });
  }
  return token;
}

/**
 * One GHCR request for `repo`: the kept token first, else the dummy token; a `401` or `403` is asked
 * again once with a new pull token. A kept token GHCR refused is not used again.
 */
export async function ghcr(d: Dialer, repo: string, url: string, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET"): Promise<Response> {
  const kept = tokenKept(repo);
  const first = await send(d, url, kept === null ? DUMMY : `Bearer ${kept}`, headers, method);
  if (first.status !== 401 && first.status !== 403) return first;
  const www = first.headers.get("www-authenticate");
  await discard(first);
  if (kept !== null) tokens.delete(repo);
  const token = await tokenNew(d, repo, url, first.status, www);
  return send(d, url, `Bearer ${token}`, headers, method);
}

// ---------------------------------------------------------------- the grammar

export type GhcrCall =
  | { kind: "tags"; repo: string }
  | { kind: "tag"; repo: string; query: string | null }
  | { kind: "manifest"; repo: string; tag: string | null; query: string | null }
  | { kind: "download"; repo: string; file: string; tag: string | null; query: string | null }
  | { kind: "api"; path: string; query: string; repo: string | null };

export type Parsed = { ok: true; call: GhcrCall } | { ok: false; detail: string };

const fail = (detail: string): Parsed => ({ ok: false, detail });
const KNOWN = ["tags", "tag", "query", "manifest", "download"];
const FORMS = "?tags, ?tag, ?tag&query=P, ?manifest with tag=T, query=P or neither, ?download=F with tag=T, query=P or neither, or /ghcr/v2/<registry API path>";

/** The registry API path of `/ghcr/v2/...`: the repository it names (for the token's scope), when it names one. */
export function repoOfApiPath(path: string): string | null {
  const m = /^\/v2\/(.+?)\/(?:tags\/list|manifests\/[^/]+|blobs\/[^/]+)$/.exec(path);
  return m?.[1] && NAME.test(m[1]) ? m[1] : null;
}

/** One request's call: `rest` is the path after `/ghcr/`, as the caller's URL spelt it. */
export function parseGhcr(url: URL, rest: string): Parsed {
  if (rest.length + url.search.length > PATH_CHARS) return fail(`the path and query are over ${PATH_CHARS} characters`);
  if (rest === "v2" || rest.startsWith("v2/")) {
    const path = `/${rest}`;
    if (!/^\/v2\/[A-Za-z0-9._/:@-]*$/.test(path) || path.split("/").includes("..")) return fail("a /ghcr/v2/ path is a registry API path: letters, digits and . _ / : @ - only");
    return { ok: true, call: { kind: "api", path, query: url.search, repo: repoOfApiPath(path) } };
  }
  const repo = rest.replace(/\/+$/, "");
  if (!repo) return fail(`name a repository: /ghcr/<owner>/<path>${"?"}tags; the forms are ${FORMS}`);
  if (repo.length > 255 || !NAME.test(repo))
    return fail("the repository path is lowercase components of letters and digits joined by . _ __ or -, at least two (owner and name), at most 255 characters");
  const v = new Map<string, string>();
  for (const [k, x] of url.searchParams) {
    if (!KNOWN.includes(k)) return fail(`unknown parameter "${k.slice(0, 40)}"; this route reads ${KNOWN.join(", ")}`);
    if (v.has(k)) return fail(`${k} is given more than once`);
    if (x.length > 256) return fail(`${k} is over 256 characters`);
    v.set(k, x);
  }
  const tag = v.get("tag");
  const query = v.get("query");
  if (tag !== undefined && tag !== "" && !REF.test(tag)) return fail("tag is a tag (letters, digits, . _ -, at most 128) or a sha256: digest");
  if (query !== undefined && query === "") return fail("query is the text a tag must hold");
  if (tag && query !== undefined) return fail("give tag=T or query=P, not both");
  const ref = { tag: tag ? tag : null, query: query ?? null };
  if (v.has("download")) {
    const file = v.get("download") ?? "";
    if (!file || /[\u0000-\u001f\u007f]/.test(file)) return fail("download is the title of the file to answer, e.g. download=head");
    if (v.has("tags") || v.has("manifest")) return fail("download takes tag or query, not tags or manifest");
    return { ok: true, call: { kind: "download", repo, file, ...ref } };
  }
  if (v.has("manifest")) {
    if (!["", "true"].includes(v.get("manifest") ?? "")) return fail("manifest takes no value (or true)");
    if (v.has("tags")) return fail("manifest takes tag or query, not tags");
    return { ok: true, call: { kind: "manifest", repo, ...ref } };
  }
  if (v.has("tags")) {
    if (!["", "all", "true"].includes(v.get("tags") ?? "")) return fail("tags takes no value (or all, or true)");
    if (v.has("tag") || v.has("query")) return fail("tags lists every tag; for the latest ask ?tag, with query=P for the latest match");
    return { ok: true, call: { kind: "tags", repo } };
  }
  if (v.has("tag")) {
    if (tag) return fail("tag=T names the tag of ?manifest or ?download; ?tag alone answers the latest tag, and ?tag&query=P the latest that holds P");
    return { ok: true, call: { kind: "tag", repo, query: ref.query } };
  }
  if (v.has("query")) return fail("query=P goes with ?tag, ?manifest or ?download");
  return fail(`ask one of ${FORMS}`);
}

// ---------------------------------------------------------------- the reads

/** A read the registry answered with something other than what was asked: its status, and what was asked. */
class Missing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "Missing";
  }
}
class Upstream extends Error {
  readonly status: number;
  readonly code: "upstream-failed" | "too-large";
  constructor(message: string, status: number, code: "upstream-failed" | "too-large" = "upstream-failed") {
    super(message);
    this.name = "Upstream";
    this.status = status;
    this.code = code;
  }
}

/** Every tag of `repo`, in GHCR's order, and how many pages were read. */
export interface TagList {
  tags: string[];
  pages: number;
  truncated: boolean;
}

/** The next page a `Link` names, when it is the same repository's tag list on ghcr.io; null at the end. */
export function nextTagPage(link: string | null, repo: string): string | null {
  const m = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(link ?? "");
  if (!m?.[1]) return null;
  try {
    const u = new URL(m[1], REGISTRY);
    return u.origin === REGISTRY && u.pathname === `/v2/${repo}/tags/list` ? u.href : null;
  } catch {
    // Not a URL: the list ends.
    return null;
  }
}

/** The JSON body of a registry answer, read under `max` bytes. */
async function jsonOf(res: Response, max: number, what: string): Promise<unknown> {
  const text = await readTextCapped(res.body, max);
  if (text === null) throw new Upstream(`${what} is over ${max} bytes`, res.status, "too-large");
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Upstream(`${what} is not JSON`, res.status);
  }
}

/** Reads every page of `repo`'s tag list, following `Link`, at most TAG_PAGES_MAX pages. */
export async function readTags(d: Dialer, repo: string): Promise<TagList> {
  const tags: string[] = [];
  let url: string | null = `${REGISTRY}/v2/${repo}/tags/list?n=${TAG_PAGE}`;
  let pages = 0;
  while (url && pages < TAG_PAGES_MAX) {
    const res = await ghcr(d, repo, url, { accept: "application/json" });
    if (res.status === 404) {
      await discard(res);
      throw new Missing(`GHCR holds no repository ${repo}`);
    }
    if (res.status !== 200) {
      await discard(res);
      throw new Upstream(`GHCR answered ${res.status} for the tag list of ${repo}`, res.status);
    }
    const body = (await jsonOf(res, 4 * 1024 * 1024, `a page of ${repo}'s tag list`)) as { tags?: unknown } | null;
    const page = Array.isArray(body?.tags) ? body.tags.filter((t): t is string => typeof t === "string") : [];
    tags.push(...page);
    pages += 1;
    url = nextTagPage(res.headers.get("link"), repo);
  }
  return { tags, pages, truncated: url !== null };
}

/** The last listed tag, or the last that holds `query` (case-insensitive), across the whole list. */
export function latestTag(tags: readonly string[], query: string | null): string | null {
  const q = query?.toLowerCase() ?? null;
  for (let i = tags.length - 1; i >= 0; i -= 1) {
    const t = tags[i] as string;
    if (q === null || t.toLowerCase().includes(q)) return t;
  }
  return null;
}

/** What a read was answered from: the store, or GHCR now. */
type From = "hit" | "miss";

/** `repo`'s tag list, from the store when it holds one, else read whole and stored. */
async function tagList(env: StoreEnv, ctx: Waits, d: Dialer, repo: string): Promise<TagList & { from: From }> {
  const key = `${CACHE_PREFIX}ghcr:tags:${await sha256Hex(repo)}`;
  const now = Date.now();
  const hit = await readText(env, key, now);
  if (hit) {
    try {
      const v = JSON.parse(hit.text) as { v?: number } & TagList;
      if (v.v === 1 && Array.isArray(v.tags)) return { tags: v.tags, pages: v.pages, truncated: v.truncated, from: "hit" };
    } catch {
      // Not a stored list: read again.
    }
  }
  const list = await readTags(d, repo);
  offPath(ctx, writeText(env, key, JSON.stringify({ v: 1, ...list }), PROVIDER, now, GHCR_TTL_S.tags));
  return { ...list, from: "miss" };
}

/** A manifest as GHCR answered it. */
interface Manifest {
  bytes: Uint8Array;
  contentType: string;
  digest: string | null;
  from: From;
}

/** The manifest `ref` names, from the store when it holds it, else read (at most MANIFEST_BYTES) and stored. A digest is checked against the bytes. */
async function manifestOf(env: StoreEnv, ctx: Waits, d: Dialer, repo: string, ref: string): Promise<Manifest> {
  const key = `${CACHE_PREFIX}ghcr:manifest:${await sha256Hex(`${repo}@${ref}`)}`;
  const now = Date.now();
  const hit = await readText(env, key, now);
  if (hit) {
    try {
      const v = JSON.parse(hit.text) as { v?: number; contentType?: string; digest?: string | null; body?: string };
      if (v.v === 1 && typeof v.body === "string" && typeof v.contentType === "string")
        return { bytes: new TextEncoder().encode(v.body), contentType: v.contentType, digest: v.digest ?? null, from: "hit" };
    } catch {
      // Not a stored manifest: read again.
    }
  }
  const res = await ghcr(d, repo, `${REGISTRY}/v2/${repo}/manifests/${ref}`, { accept: MANIFEST_ACCEPT });
  if (res.status === 404) {
    await discard(res);
    throw new Missing(`GHCR holds no manifest ${ref} of ${repo}`);
  }
  if (res.status !== 200) {
    await discard(res);
    throw new Upstream(`GHCR answered ${res.status} for the manifest ${ref} of ${repo}`, res.status);
  }
  const bytes = await readBytesCapped(res.body, MANIFEST_BYTES);
  if (bytes === null) throw new Upstream(`the manifest ${ref} of ${repo} is over ${MANIFEST_BYTES} bytes`, 200, "too-large");
  if (DIGEST.test(ref)) {
    // A digest names one manifest: bytes that hash to another are not it (archmirror's pin check).
    const got = `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
    if (got !== ref) throw new Upstream(`the manifest ${ref} of ${repo} hashes to ${got}`, 200);
  }
  const m: Manifest = { bytes, contentType: res.headers.get("content-type") ?? "application/json", digest: res.headers.get("docker-content-digest"), from: "miss" };
  const text = new TextDecoder().decode(bytes);
  offPath(
    ctx,
    writeText(env, key, JSON.stringify({ v: 1, contentType: m.contentType, digest: m.digest, body: text }), PROVIDER, now, DIGEST.test(ref) ? GHCR_TTL_S.manifestByDigest : GHCR_TTL_S.manifestByTag),
  );
  return m;
}

/** The tag a manifest or a download names: the one given, else the last listed (matching `query`) across the list. */
async function refOf(env: StoreEnv, ctx: Waits, d: Dialer, repo: string, tag: string | null, query: string | null): Promise<{ ref: string; notes: string[]; from: From }> {
  if (tag) return { ref: tag, notes: [], from: "hit" };
  const list = await tagList(env, ctx, d, repo);
  const ref = latestTag(list.tags, query);
  if (ref === null) throw new Missing(query === null ? `${repo} lists no tag` : `no tag of ${repo} holds "${query}"`);
  return { ref, notes: [`pages=${list.pages}`, `truncated=${list.truncated}`], from: list.from };
}

// ---------------------------------------------------------------- the answers

interface Waits {
  waitUntil(p: Promise<unknown>): void;
}

function offPath(ctx: Waits | undefined, p: Promise<unknown>): void {
  if (ctx) ctx.waitUntil(p);
  else void p;
}

export interface GhcrDeps {
  /** The dial; the global `fetch` in production, a stub in a test. */
  fetcher?: typeof fetch;
}

const TEXT = "text/plain; charset=utf-8";

/** A text answer of this service (a tag list, a tag), with its provenance. */
function textAnswer(request: Request, text: string, cache: From, notes: string[], extra: Record<string, string> = {}): Response {
  const h = provenance(new Headers({ "content-type": TEXT, "cache-control": `public, max-age=${GHCR_TTL_S.tags}`, "x-content-type-options": "nosniff", ...extra }), {
    provider: PROVIDER,
    account: ACCOUNT,
    cache,
    body: "listed",
  });
  if (notes.length) h.set("x-web-provider-notes", notes.join(" "));
  const bytes = new TextEncoder().encode(text);
  h.set("content-length", String(bytes.byteLength));
  return new Response(bodyFor(request, bytes), { status: 200, headers: h });
}

/**
 * A dialer over `fetcher`, or over the global fetch. The global is wrapped, never stored bare: called
 * as `d.fetcher(...)` it would run with `d` as its receiver, and the Workers runtime refuses that
 * ("Illegal invocation"). On 2026-10-22 every GHCR request failed as unreachable in production that
 * way, while the specs, which pass their own fetcher, passed.
 */
export function dialer(fetcher?: typeof fetch): Dialer {
  return { fetcher: fetcher ?? ((input, init) => fetch(input, init)), count: 0 };
}

/** The answer to one `/ghcr` request. */
export async function ghcrLeg(request: Request, env: StoreEnv, ctx: Waits | undefined, call: GhcrCall, deps: GhcrDeps = {}): Promise<ForgeOutcome> {
  const d = dialer(deps.fetcher);
  const waits: Waits = ctx ?? { waitUntil: (p) => void p };
  const event = (cache: "hit" | "miss", upstreamStatus?: number) => ({ provider: PROVIDER, account: ACCOUNT, attempts: d.count, cache, ...(upstreamStatus ? { upstreamStatus } : {}) });
  try {
    switch (call.kind) {
      case "tags": {
        const list = await tagList(env, waits, d, call.repo);
        const lines = list.tags.map((t) => `${t}\n`).join("");
        const tail = list.truncated ? `# truncated: ${list.pages} pages of ${TAG_PAGE} read; later tags are not listed\n` : "";
        const notes = [`tags=${list.tags.length}`, `pages=${list.pages}`, `truncated=${list.truncated}`];
        return { res: textAnswer(request, lines + tail, list.from, notes), event: event(list.from) };
      }
      case "tag": {
        const list = await tagList(env, waits, d, call.repo);
        const tag = latestTag(list.tags, call.query);
        if (tag === null) throw new Missing(call.query === null ? `${call.repo} lists no tag` : `no tag of ${call.repo} holds "${call.query}"`);
        const notes = [`tags=${list.tags.length}`, `pages=${list.pages}`, `truncated=${list.truncated}`];
        return { res: textAnswer(request, `${tag}\n`, list.from, notes, { "x-web-tag": headerToken(tag) }), event: event(list.from) };
      }
      case "manifest": {
        const r = await refOf(env, waits, d, call.repo, call.tag, call.query);
        const m = await manifestOf(env, waits, d, call.repo, r.ref);
        const from: From = r.from === "hit" && m.from === "hit" ? "hit" : "miss";
        const h = provenance(new Headers({ "content-type": m.contentType, "content-length": String(m.bytes.byteLength), "x-content-type-options": "nosniff" }), {
          provider: PROVIDER,
          account: ACCOUNT,
          cache: from,
        });
        h.set("cache-control", `public, max-age=${DIGEST.test(r.ref) ? GHCR_TTL_S.manifestByDigest : GHCR_TTL_S.manifestByTag}`);
        h.set("x-web-tag", headerToken(r.ref));
        if (m.digest) h.set("docker-content-digest", headerToken(m.digest));
        if (r.notes.length) h.set("x-web-provider-notes", r.notes.join(" "));
        return { res: new Response(bodyFor(request, m.bytes), { status: 200, headers: h }), event: event(from, 200) };
      }
      case "download":
        return await download(request, env, waits, d, call, event);
      case "api":
        return await api(request, d, call, event);
    }
  } catch (err) {
    return { res: faultAnswer(err), event: { provider: PROVIDER, account: ACCOUNT, attempts: d.count, cache: "none", fault: faultOf(err) } };
  }
}

/** `?download=F`: the layer titled F of the manifest the tag names, streamed from the blob host with the caller's `Range`. */
async function download(
  request: Request,
  env: StoreEnv,
  ctx: Waits,
  d: Dialer,
  call: Extract<GhcrCall, { kind: "download" }>,
  event: (cache: "hit" | "miss", upstreamStatus?: number) => ForgeOutcome["event"],
): Promise<ForgeOutcome> {
  const r = await refOf(env, ctx, d, call.repo, call.tag, call.query);
  const m = await manifestOf(env, ctx, d, call.repo, r.ref);
  type ManifestDoc = { layers?: unknown };
  let doc: ManifestDoc | null = null;
  try {
    doc = JSON.parse(new TextDecoder().decode(m.bytes)) as ManifestDoc;
  } catch {
    throw new Upstream(`the manifest ${r.ref} of ${call.repo} is not JSON`, 200);
  }
  if (!Array.isArray(doc?.layers)) throw new Missing(`the manifest ${r.ref} of ${call.repo} has no layers (an image index names its manifests by digest: ask one with tag=sha256:<digest>)`);
  const layer = (doc.layers as { digest?: unknown; annotations?: Record<string, unknown> }[]).find((l) => l?.annotations?.[TITLE] === call.file);
  if (!layer || typeof layer.digest !== "string" || !DIGEST.test(layer.digest)) throw new Missing(`no file titled ${call.file} in ${call.repo}:${r.ref}`);
  const range = request.headers.get("range");
  const ranged: Record<string, string> = range && range.length <= 512 ? { range } : {};
  // GHCR answers a blob with a redirect to its signed URL; one it serves itself takes the range as asked.
  const blob = await ghcr(d, call.repo, `${REGISTRY}/v2/${call.repo}/blobs/${layer.digest}`, ranged, request.method === "HEAD" ? "HEAD" : "GET");
  let res = blob;
  if (blob.status >= 300 && blob.status < 400) {
    await discard(blob);
    const location = blob.headers.get("location");
    let u: URL | null = null;
    try {
      u = location ? new URL(location, REGISTRY) : null;
    } catch {
      u = null;
    }
    if (!u || u.protocol !== "https:" || !u.hostname.endsWith(BLOB_HOST_SUFFIX))
      throw new Upstream(`GHCR redirected the file ${call.file} to ${u ? u.hostname : "no URL"}, not https on *${BLOB_HOST_SUFFIX}`, blob.status);
    // The signed URL carries its own authority: no Authorization goes there.
    res = await send(d, u.href, null, ranged, request.method === "HEAD" ? "HEAD" : "GET");
  }
  if (res.status === 404) {
    await discard(res);
    throw new Missing(`GHCR holds no blob ${layer.digest} for ${call.file}`);
  }
  if (res.status !== 200 && res.status !== 206 && res.status !== 416) {
    await discard(res);
    throw new Upstream(`the blob host answered ${res.status} for the file ${call.file}`, res.status);
  }
  const h = provenance(new Headers({ "content-type": contentTypeOf(call.file), "x-content-type-options": "nosniff" }), { provider: PROVIDER, account: ACCOUNT, cache: "miss" });
  for (const name of ["content-length", "content-range", "accept-ranges", "etag", "last-modified"]) {
    const v = res.headers.get(name);
    if (v !== null) h.set(name, v);
  }
  // A file is a package's artefact, never a page of this service: a browser that opens an .svg runs none of its script here.
  h.set("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  h.set("x-web-tag", headerToken(r.ref));
  h.set("x-web-digest", layer.digest);
  if (r.notes.length) h.set("x-web-provider-notes", r.notes.join(" "));
  return { res: new Response(bodyFor(request, res.body), { status: res.status, headers: h }), event: event("miss", res.status) };
}

/** `/ghcr/v2/<path>`: the registry API answered as it is, with the dummy token and the anonymous flow; a redirect handed back, `Link` on the host and prefix the caller used. */
async function api(request: Request, d: Dialer, call: Extract<GhcrCall, { kind: "api" }>, event: (cache: "hit" | "miss", upstreamStatus?: number) => ForgeOutcome["event"]): Promise<ForgeOutcome> {
  const headers: Record<string, string> = {};
  for (const name of ["accept", "range", "if-none-match"]) {
    const v = request.headers.get(name);
    if (v !== null && v.length <= 512) headers[name] = v;
  }
  const url = `${REGISTRY}${call.path}${call.query}`;
  const method = request.method === "HEAD" ? "HEAD" : "GET";
  const res = call.repo ? await ghcr(d, call.repo, url, headers, method) : await send(d, url, DUMMY, headers, method);
  const ours = baseOf(request, PREFIX);
  const h = new Headers();
  for (const [k, v] of res.headers) {
    const name = k.toLowerCase();
    if (name === "set-cookie" || name === "www-authenticate") continue;
    if (name === "link") h.append(k, rewriteLink(v, REGISTRY, ours));
    else h.append(k, v);
  }
  provenance(h, { provider: PROVIDER, account: ACCOUNT, cache: "miss" });
  const out = event("miss", res.status);
  return { res: new Response(bodyFor(request, res.body), { status: res.status, statusText: res.statusText, headers: h }), event: { ...out, passthrough: true } };
}

/** The analytics fault of a failed read. */
function faultOf(err: unknown): string {
  if (err instanceof Missing) return "404:not-found";
  if (err instanceof Upstream) return `502:${err.code}`;
  if (err instanceof GhcrFault) return err.kind === "timeout" ? "504:deadline" : err.kind === "refused" ? "403:refused" : "502:upstream";
  return "500";
}

/** The problem of a failed read; a defect is thrown on, for index.ts to answer 500. */
function faultAnswer(err: unknown): Response {
  if (err instanceof Missing) return problem(404, "not found", err.message, { reason: "not-found", provider: PROVIDER });
  if (err instanceof Upstream && err.code === "too-large") return problem(502, "too large", err.message, { reason: "too-large", provider: PROVIDER, upstream_status: err.status });
  if (err instanceof Upstream) return problem(502, "upstream failed", err.message, { reason: "upstream-failed", provider: PROVIDER, upstream_status: err.status });
  if (err instanceof GhcrFault && err.kind === "timeout") return problem(504, "deadline", err.message, { reason: "deadline", provider: PROVIDER });
  if (err instanceof GhcrFault && err.kind === "refused")
    return problem(403, "refused", `${err.message}: a package that is not public needs a credential this service does not hold`, {
      reason: "refused",
      provider: PROVIDER,
      ...(err.status ? { upstream_status: err.status } : {}),
    });
  if (err instanceof GhcrFault) return problem(502, "upstream failed", err.message, { reason: "upstream-failed", provider: PROVIDER });
  throw err;
}
