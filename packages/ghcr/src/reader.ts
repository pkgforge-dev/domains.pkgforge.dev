// packages/ghcr/src/reader.ts — the one anonymous reader of GHCR, for the
// Worker and for the Node scripts alike: manifests, tag lists, and byte ranges
// of blobs through their signed URL.
//
//   const g = ghcrReader({ userAgent: USER_AGENT });           // scripts/lib/user-agent.mjs
//   const m = await g.getManifest(repoOf("root"), "latest");    // bytes, digest, parsed JSON
//   const h = await g.headManifest(repoOf("ref"), "psl-0232f4df0831");
//   const t = await g.listTags(repoOf("obs"));                  // every page, by Link
//   const r = await g.readRange(repo, digest, 0, 65_536);       // [start, end): end EXCLUSIVE
//
// The token flow is mirror-archlinux's (worker/src/index.js lines 212 to 376),
// ported from docs/research/reference/ghcr.ts (send, bearerRealm, tokenKept,
// tokenNew, ghcr) with the imports of the other repository dropped:
// - every request sends the dummy token `Bearer QQ==` first, which GHCR accepts
//   for a public package (docs/architecture.md section 4.3);
// - a 401 or a 403 reads the Bearer challenge (a 403 carries none, so a bare
//   request fetches it), accepts its realm only as https://ghcr.io/token (no
//   other port, no other path), asks it for `repository:<repo>:pull`, and asks
//   again once with that token;
// - the token is kept in the isolate for its `expires_in` less 30 s, at most
//   300 s, and never stored anywhere else. GHCR's anonymous token answer holds
//   no `expires_in` (MEASURED 2026-10-29T00:40:25Z: its one key is `token`), so
//   the Docker token specification's default of 60 s applies, and it is kept 30 s.
//
// What it refuses before any request: a repository that is not an OCI path or
// is outside the reader's namespace (default NAMESPACE, so a Worker route that
// passes a caller's repository reads this project's packages and no other GHCR
// package), a request through ghcr(), which carries a GHCR token, to a URL
// that is not on https://ghcr.io, a reference over 128 characters (GHCR answers a 129-character one with a 303 to
// an HTML page, READ mirror-archlinux docs/measurements.md), an upper-case tag
// (tags resolve without regard to case and every tag here is lowercase), and a
// range that is empty, negative or over maxRangeBytes.
//
// What it checks of every answer: a manifest is at most 64 KiB, UTF-8 JSON of
// the OCI shape, and hashes to the digest asked for (and to GHCR's
// docker-content-digest); a tag list page is followed only to the same
// repository's list on ghcr.io, and a Link it cannot follow is an error, never
// the end of the list; a blob's 307 goes to an https URL on
// *.githubusercontent.com (another host only when the caller names it in
// allowBlobHosts, and a read from it is reported as `unexpected`), the same
// holds for a signed URL read back from the cache, its `se` sets how long the
// signed URL is kept (at most SIGNED_MAX_S), and a range answer is a 206 whose
// Content-Range and length are exactly the range asked for.
//
// Every answer body it does not return is read or cancelled, so a Worker
// leaves no connection open. Runs in Node and in workerd alike: fetch,
// AbortController, crypto.subtle and TextDecoder only.

import { NAMESPACE, REGISTRY_HOST } from "./layout.ts";

export const REGISTRY = `https://${REGISTRY_HOST}`;
// The dummy token GHCR accepts for a public package.
export const DUMMY = "Bearer QQ==";
// The manifest types asked for: reference/ghcr.ts's list (api.ghcr's).
export const MANIFEST_ACCEPT =
  "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.artifact.manifest.v1+json";
export const TITLE = "org.opencontainers.image.title";
// The hosts GHCR's blob redirect lands on (pkg-containers.githubusercontent.com,
// MEASURED 2026-10-29T00:38:32Z); another host is refused unless the caller
// allows it by name (ReaderOptions.allowBlobHosts).
export const BLOB_HOST_SUFFIX = ".githubusercontent.com";
// GHCR's token endpoint: the one realm a Bearer challenge may name.
export const TOKEN_REALM = `https://${REGISTRY_HOST}/token`;

// mirror-archlinux's Worker refuses a manifest over 64 KiB; a root of this
// project keeps its data in a layer, so its manifest is small (section 4.6).
// A caller that reads any manifest of the namespace raises it per call, up to
// MANIFEST_LIMIT_BYTES, GHCR's own: the probe's `layers-1000` manifest is over
// 64 KiB (MEASURED 2026-10-29T00:50:51Z, scripts/ghcr/check-public.mjs probe).
export const MANIFEST_MAX_BYTES = 64 * 1024;
export const MANIFEST_LIMIT_BYTES = 4 * 1024 * 1024;
export const TOKEN_MAX_BYTES = 16 * 1024;
// A page of 1,000 tags of 40 characters is about 45 KB; 4 MiB is far above it.
export const TAG_PAGE_MAX_BYTES = 4 * 1024 * 1024;
// GHCR caps `n` at 1,000 (READ mirror-archlinux docs/measurements.md).
export const TAG_PAGE = 1000;
export const TAG_PAGES_MAX = 10_000;
export const REQUEST_TIMEOUT_MS = 30_000;
// A range is buffered whole: the largest a caller may ask for.
export const RANGE_MAX_BYTES = 32 * 1024 * 1024;
export const TOKEN_TTL_S = Object.freeze({ margin: 30, max: 300, absent: 60 });
// A signed URL is kept until `se` less this margin (it lives about 6.5 to 8.7
// minutes: section 4.3, and se 00:45:00Z for a 307 at 00:38:32Z, MEASURED
// 2026-10-29).
export const SIGNED_MARGIN_S = 60;
// The longest a signed URL is kept, less the margin, whatever its `se` says: an
// `se` far ahead would keep a URL the host stopped honouring for as long as the
// cache allows. 15 minutes is above the lives measured (section 4.3).
export const SIGNED_MAX_S = 15 * 60;
// How long a manifest read by tag, and one read by digest, is kept by a cache.
export const MANIFEST_TTL_S = Object.freeze({ byTag: 60, byDigest: 86_400 });

const NAME = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)+$/;
// A namespace: one path component or more (an owner, or an owner and a name).
const NAMESPACE_PATH = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)*$/;
// A host name as URL gives it: lowercase labels joined by dots.
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const TAG = /^[a-z0-9_][a-z0-9._-]{0,127}$/;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;

export type GhcrErrorCode =
  // A call this module refuses before any request.
  | "usage"
  // GHCR did not answer within the time, or could not be reached.
  | "timeout"
  | "unreachable"
  // 401 or 403 after the anonymous flow, or a challenge it cannot follow: not public, or absent.
  | "refused"
  // 404: no such repository, tag, manifest or blob.
  | "missing"
  // 429: GHCR's rate limit. A script pauses and asks again (section 4.7 rule 5).
  | "rate-limited"
  // 416: a range past the end of the blob.
  | "range"
  // Any other status, a body that is not what was asked for, a Link that cannot be followed.
  | "upstream"
  | "too-large"
  // Bytes that are not the bytes asked for: another digest, a short or long range.
  | "integrity"
  // A blob redirect with no https Location, or to a host this reader does not allow.
  | "redirect";

export class GhcrError extends Error {
  readonly code: GhcrErrorCode;
  readonly status: number | null;
  constructor(code: GhcrErrorCode, message: string, status: number | null = null) {
    super(message);
    this.name = "GhcrError";
    this.code = code;
    this.status = status;
  }
}

export type Fetcher = (input: string, init: RequestInit) => Promise<Response>;

// One reader's dial: the fetch, its limits, and what it counted.
export interface Dialer {
  fetcher: Fetcher;
  userAgent: string;
  timeoutMs: number;
  // Every request sent, and the token requests among them.
  count: number;
  tokenRequests: number;
}

// The global fetch is wrapped, never stored bare: called as `d.fetcher(...)` it
// would run with `d` as its receiver, and workerd refuses that ("Illegal
// invocation"). The sibling project lost every GHCR request in production that
// way on 2026-10-22 while its tests, which passed their own fetcher, passed
// (READ docs/research/reference/ghcr.ts lines 463 to 468).
export function dialer(options: { userAgent: string; fetcher?: Fetcher; timeoutMs?: number }): Dialer {
  if (typeof options?.userAgent !== "string" || options.userAgent.trim() === "") throw new GhcrError("usage", "a reader needs the contact User-Agent (TODO/RULES.md section 5, ruling 11)");
  return {
    fetcher: options.fetcher ?? ((input, init) => fetch(input, init)),
    userAgent: options.userAgent,
    timeoutMs: options.timeoutMs ?? REQUEST_TIMEOUT_MS,
    count: 0,
    tokenRequests: 0,
  };
}

// What one isolate keeps between its requests: repository -> pull token. A
// shortcut, never the only copy, and never written anywhere.
const tokens = new Map<string, { token: string; expires: number }>();
const TOKENS_MAX = 256;

// The state of a new isolate; the tests call it before each test.
export function resetTokens(): void {
  tokens.clear();
}

async function discard(res: Response): Promise<void> {
  // A body that is already gone, or broke off, needs no cancelling.
  await res.body?.cancel().catch(() => undefined);
}

// One request: `authorization` (none when null), the User-Agent, no redirect
// followed, and the answer's head within the dial's time. The time ends when
// the head arrives; a body is bounded by readCapped.
export async function send(d: Dialer, url: string, authorization: string | null, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET"): Promise<Response> {
  const h: Record<string, string> = { ...headers, "user-agent": d.userAgent };
  if (authorization !== null) h.authorization = authorization;
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), d.timeoutMs);
  d.count += 1;
  try {
    return await d.fetcher(url, { method, headers: h, redirect: "manual", signal: stop.signal });
  } catch (err) {
    const name = (err as { name?: string } | null)?.name;
    if (stop.signal.aborted || name === "AbortError" || name === "TimeoutError") throw new GhcrError("timeout", `${new URL(url).host} did not answer within ${d.timeoutMs / 1000} s`);
    throw new GhcrError("unreachable", `${new URL(url).host} could not be reached: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// A body read whole, or null when it is over `max` bytes (the rest cancelled).
// The read must end within `timeoutMs`, or GhcrError timeout.
export async function readCapped(res: Response, max: number, timeoutMs = REQUEST_TIMEOUT_MS): Promise<Uint8Array | null> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new GhcrError("timeout", `a body did not arrive within ${timeoutMs / 1000} s`)), timeoutMs);
  });
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), late]);
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    if (err instanceof GhcrError) throw err;
    throw new GhcrError("unreachable", `a body broke off after ${total} bytes: ${(err as Error)?.message ?? String(err)}`);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// The realm of a Bearer challenge, or null.
export function bearerRealm(www: string | null): string | null {
  if (typeof www !== "string" || !/^\s*bearer\s/i.test(www)) return null;
  return /\brealm="([^"]*)"/i.exec(www)?.[1] ?? null;
}

// A pull token for `repo` this isolate holds, or null.
export function tokenKept(repo: string, now = Date.now()): string | null {
  const t = tokens.get(repo);
  if (t && t.expires > now) return t.token;
  tokens.delete(repo);
  return null;
}

// A new pull token for `repo` from the realm of GHCR's Bearer challenge.
// `refused` is the status that refused the token sent and `www` its challenge.
// A realm that is not TOKEN_REALM (https, ghcr.io, the default port, the path
// /token) is refused, so no request goes elsewhere.
export async function tokenNew(d: Dialer, repo: string, url: string, refused: number, www: string | null): Promise<string> {
  const why = `GHCR answered ${refused} for an anonymous pull of ${repo}`;
  let realm = bearerRealm(www);
  if (realm === null && refused === 403) {
    // GHCR answers 403 with no challenge; a request with no authorization gets 401 with one.
    const bare = await send(d, url, null);
    realm = bearerRealm(bare.headers.get("www-authenticate"));
    await discard(bare);
  }
  if (realm === null) throw new GhcrError("refused", `${why}, and sent no Bearer challenge`, refused);
  let u: URL;
  try {
    u = new URL(realm);
  } catch {
    throw new GhcrError("refused", `${why}, and its Bearer challenge names a realm that is not a URL`, refused);
  }
  // The origin holds the scheme, the host and the port (443 reads as none).
  if (u.origin !== REGISTRY || u.pathname !== "/token") throw new GhcrError("refused", `${why}, and its Bearer challenge names a realm that is not ${TOKEN_REALM}`, refused);
  u.searchParams.set("service", REGISTRY_HOST);
  u.searchParams.set("scope", `repository:${repo}:pull`);
  d.tokenRequests += 1;
  const res = await send(d, u.href, null);
  if (res.status !== 200) {
    await discard(res);
    throw new GhcrError("refused", `${why}, and its token request answered ${res.status}`, res.status === 401 || res.status === 403 ? refused : res.status);
  }
  const bytes = await readCapped(res, TOKEN_MAX_BYTES, d.timeoutMs);
  type TokenAnswer = { token?: unknown; access_token?: unknown; expires_in?: unknown };
  let body: TokenAnswer | null = null;
  try {
    body = bytes === null ? null : (JSON.parse(new TextDecoder().decode(bytes)) as TokenAnswer);
  } catch {
    // Not JSON: it holds no token, and the next line says so.
  }
  const token = [body?.token, body?.access_token].find((t): t is string => typeof t === "string" && t !== "");
  if (token === undefined) throw new GhcrError("refused", `${why}, and its token answer holds no token`, refused);
  const expiresIn = typeof body?.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : TOKEN_TTL_S.absent;
  const lifetime = Math.min(expiresIn - TOKEN_TTL_S.margin, TOKEN_TTL_S.max);
  if (lifetime >= 1) {
    if (tokens.size >= TOKENS_MAX) tokens.delete(tokens.keys().next().value as string);
    tokens.set(repo, { token, expires: Date.now() + lifetime * 1000 });
  }
  return token;
}

// One GHCR request for `repo`: the kept token first, else the dummy token; a 401
// or a 403 is asked again once with a new pull token. A kept token GHCR refused
// is not used again. A URL that is not on REGISTRY is refused before any
// request: the token this sends goes to GHCR and nowhere else.
export async function ghcr(d: Dialer, repo: string, url: string, headers: Record<string, string> = {}, method: "GET" | "HEAD" = "GET"): Promise<Response> {
  let origin: string | null = null;
  try {
    origin = new URL(url).origin;
  } catch {
    // Not a URL: the refusal below names it.
  }
  if (origin !== REGISTRY) throw new GhcrError("usage", `${JSON.stringify(url)} is not a URL on ${REGISTRY}; a GHCR token goes nowhere else`);
  const kept = tokenKept(repo);
  const first = await send(d, url, kept === null ? DUMMY : `Bearer ${kept}`, headers, method);
  if (first.status !== 401 && first.status !== 403) return first;
  const www = first.headers.get("www-authenticate");
  await discard(first);
  if (kept !== null) tokens.delete(repo);
  const token = await tokenNew(d, repo, url, first.status, www);
  return send(d, url, `Bearer ${token}`, headers, method);
}

// ---------------------------------------------------------------- the checks

// A repository of `namespace`: `<namespace>/<package...>`, matched on a whole
// component, so `<namespace>-x/y` is outside it.
function checkRepo(repo: unknown, namespace: string): string {
  if (typeof repo !== "string" || repo.length > 255 || !NAME.test(repo)) {
    throw new GhcrError("usage", `${JSON.stringify(repo)} is not a repository path: lowercase components joined by / (owner and name at least), at most 255 characters`);
  }
  if (!repo.startsWith(`${namespace}/`)) throw new GhcrError("usage", `${repo} is outside the namespace ${namespace}; this reader reads ${namespace}/<package> only`);
  return repo;
}

// A reference: a lowercase tag of at most 128 characters, or a sha256 digest.
export function checkRef(ref: unknown): string {
  if (typeof ref !== "string" || ref === "") throw new GhcrError("usage", "a reference is a tag or a sha256: digest");
  if (DIGEST.test(ref)) return ref;
  if (ref.length > 128) throw new GhcrError("usage", `the reference is ${ref.length} characters; a tag is at most 128 (GHCR answers a longer one with a 303 to an HTML page)`);
  if (/[A-Z]/.test(ref)) throw new GhcrError("usage", `the tag ${JSON.stringify(ref)} holds upper case; every tag here is lowercase, and GHCR resolves tags without regard to case`);
  if (!TAG.test(ref)) throw new GhcrError("usage", `${JSON.stringify(ref)} is not a tag: letters, digits, _ . and -, not starting with . or -`);
  return ref;
}

function checkDigest(digest: unknown): string {
  if (typeof digest !== "string" || !DIGEST.test(digest)) throw new GhcrError("usage", `${JSON.stringify(digest)} is not a sha256: digest`);
  return digest;
}

export async function sha256Digest(bytes: Uint8Array): Promise<string> {
  // A copy, so a view into a larger buffer hashes its own bytes only.
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice()));
  return `sha256:${Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// The failure of an answer that is not the one asked for.
// `who` is the host that answered: GHCR, or the blob host of a signed URL.
async function statusError(res: Response, what: string, who = "GHCR"): Promise<GhcrError> {
  await discard(res);
  const s = res.status;
  if (s === 404) return new GhcrError("missing", `${who} holds no ${what}`, s);
  if (s === 401 || s === 403) return new GhcrError("refused", `${who} refused an anonymous read of ${what} (${s})`, s);
  if (s === 429) return new GhcrError("rate-limited", `${who} answered 429 for ${what}`, s);
  return new GhcrError("upstream", `${who} answered ${s} for ${what}`, s);
}

// ---------------------------------------------------------------- manifests

export interface Descriptor {
  mediaType: string;
  digest: string;
  size: number;
  artifactType?: string;
  annotations?: Record<string, string>;
  data?: string;
}

// The fields of an OCI image manifest or index this project reads.
export interface ManifestJson {
  schemaVersion: number;
  mediaType?: string;
  artifactType?: string;
  config?: Descriptor;
  layers?: Descriptor[];
  manifests?: Descriptor[];
  annotations?: Record<string, string>;
}

export interface Manifest {
  repo: string;
  ref: string;
  // The sha256 of `bytes`: the manifest's own digest.
  digest: string;
  bytes: Uint8Array;
  contentType: string;
  json: ManifestJson;
  from: "cache" | "registry";
}

export interface ManifestHead {
  repo: string;
  ref: string;
  digest: string;
  size: number;
  contentType: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function annotationsOf(v: unknown, at: string): Record<string, string> | undefined {
  if (v === undefined) return undefined;
  if (!isObj(v) || Object.values(v).some((x) => typeof x !== "string")) throw new GhcrError("upstream", `${at}: annotations is not a map of strings`);
  return v as Record<string, string>;
}

function descriptorOf(v: unknown, at: string): Descriptor {
  if (!isObj(v) || typeof v.mediaType !== "string" || typeof v.digest !== "string" || !DIGEST.test(v.digest) || !Number.isSafeInteger(v.size) || (v.size as number) < 0) {
    throw new GhcrError("upstream", `${at} is not a descriptor: mediaType, a sha256 digest and a size`);
  }
  if (v.artifactType !== undefined && typeof v.artifactType !== "string") throw new GhcrError("upstream", `${at}: artifactType is not a string`);
  annotationsOf(v.annotations, at);
  return v as unknown as Descriptor;
}

// The parsed manifest, its shape checked: section 11's rule that a reader
// refuses what it cannot read rather than reading it in part.
export function parseManifest(bytes: Uint8Array, what: string): ManifestJson {
  let json: unknown;
  try {
    // ignoreBOM keeps a BOM in the text, where JSON.parse refuses it: a manifest is plain JSON.
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch {
    throw new GhcrError("upstream", `${what} is not UTF-8 JSON`);
  }
  if (!isObj(json) || json.schemaVersion !== 2) throw new GhcrError("upstream", `${what} is not an OCI manifest (schemaVersion 2)`);
  for (const k of ["mediaType", "artifactType"] as const) if (json[k] !== undefined && typeof json[k] !== "string") throw new GhcrError("upstream", `${what}: ${k} is not a string`);
  if (json.config !== undefined) descriptorOf(json.config, `${what} config`);
  for (const k of ["layers", "manifests"] as const) {
    if (json[k] === undefined) continue;
    if (!Array.isArray(json[k])) throw new GhcrError("upstream", `${what}: ${k} is not a list`);
    for (const [i, x] of (json[k] as unknown[]).entries()) descriptorOf(x, `${what} ${k}[${i}]`);
  }
  annotationsOf(json.annotations, what);
  return json as unknown as ManifestJson;
}

// ---------------------------------------------------------------- tags

export interface TagList {
  tags: string[];
  pages: number;
  // The list was cut at maxPages: later tags are not in `tags`.
  truncated: boolean;
}

// The next page a `Link` names: null when there is no `rel="next"`. A next link
// that is not the same repository's tag list on ghcr.io throws: a list that
// ended there would under-count without a word.
export function nextTagPage(link: string | null, repo: string): string | null {
  if (link === null || link.trim() === "") return null;
  const m = /<([^>]*)>\s*;\s*rel="?next"?/i.exec(link);
  if (!m) return null;
  let u: URL;
  try {
    u = new URL(m[1] ?? "", REGISTRY);
  } catch {
    throw new GhcrError("upstream", `the tag list of ${repo} names a next page that is not a URL`);
  }
  if (u.origin !== REGISTRY || u.pathname !== `/v2/${repo}/tags/list`) throw new GhcrError("upstream", `the tag list of ${repo} names a next page outside it (${u.origin}${u.pathname})`);
  return u.href;
}

// ---------------------------------------------------------------- the cache

// What a cache holds is a string a key names, for at most `ttlSeconds`. The
// Worker backs it with the Cache API or R2; memoryCache backs it in Node. A
// cache that fails is a miss, never a failed read.
export interface GhcrCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, ttlSeconds: number): Promise<void>;
}

export function memoryCache(now: () => number = () => Date.now()): GhcrCache & { readonly entries: Map<string, { value: string; until: number }> } {
  const entries = new Map<string, { value: string; until: number }>();
  return {
    entries,
    async get(key) {
      const e = entries.get(key);
      if (!e) return null;
      if (e.until <= now()) {
        entries.delete(key);
        return null;
      }
      return e.value;
    },
    async put(key, value, ttlSeconds) {
      if (!(ttlSeconds > 0)) return;
      entries.set(key, { value, until: now() + ttlSeconds * 1000 });
    },
  };
}

// ---------------------------------------------------------------- ranges

export interface RangeRead {
  bytes: Uint8Array;
  // The size of the whole blob, from Content-Range; null when the host sent `*`.
  size: number | null;
  // The host that answered the range, and whether it is outside
  // *.githubusercontent.com (a host the caller named in allowBlobHosts).
  host: string;
  unexpected: boolean;
  // The expiry of the signed URL (ms since the epoch), from its `se`; null when it has none.
  se: number | null;
  // Where the signed URL came from: the cache, or a 307 of the registry now.
  signed: "cache" | "registry";
}

interface Signed {
  url: string;
  se: number | null;
}

// The expiry of a signed URL from its `se` parameter (ms), or null.
export function signedExpiry(url: URL): number | null {
  const se = url.searchParams.get("se");
  if (se === null) return null;
  const t = Date.parse(se);
  return Number.isFinite(t) ? t : null;
}

// `bytes S-E/TOTAL` of a 206 answer, as numbers; null when it is not that.
function contentRange(v: string | null): { start: number; end: number; total: number | null } | null {
  const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec((v ?? "").trim());
  if (!m) return null;
  return { start: Number(m[1]), end: Number(m[2]), total: m[3] === "*" ? null : Number(m[3]) };
}

// ---------------------------------------------------------------- the reader

export interface ReaderOptions {
  // TODO/RULES.md section 5, ruling 11: every reader of an outside host sends
  // the contact User-Agent. Required, so no caller can forget it.
  userAgent: string;
  // The dial: the global fetch (wrapped) when absent.
  fetcher?: Fetcher;
  cache?: GhcrCache;
  timeoutMs?: number;
  maxRangeBytes?: number;
  // The repositories this reader reads: `<namespace>/<package...>` only, any
  // other refused with `usage` before a request. Default NAMESPACE.
  namespace?: string;
  // Host names a blob's 307 may name beyond *.githubusercontent.com. Default
  // none: GHCR's signed URL is on pkg-containers.githubusercontent.com.
  allowBlobHosts?: readonly string[];
}

export interface GhcrReader {
  readonly dial: Dialer;
  // Cache reads and writes that failed and were taken as misses.
  readonly cacheErrors: number;
  // A manifest is at most maxBytes (default MANIFEST_MAX_BYTES, at most MANIFEST_LIMIT_BYTES).
  getManifest(repo: string, ref: string, options?: { maxBytes?: number }): Promise<Manifest>;
  headManifest(repo: string, ref: string): Promise<ManifestHead>;
  listTags(repo: string, options?: { maxPages?: number }): Promise<TagList>;
  // The bytes [start, end) of the blob `digest`: `end` is exclusive.
  readRange(repo: string, digest: string, start: number, end: number): Promise<RangeRead>;
}

export function ghcrReader(options: ReaderOptions): GhcrReader {
  const d = dialer(options);
  const cache = options.cache ?? null;
  const maxRange = options.maxRangeBytes ?? RANGE_MAX_BYTES;
  const namespace = options.namespace ?? NAMESPACE;
  if (typeof namespace !== "string" || !NAMESPACE_PATH.test(namespace)) throw new GhcrError("usage", `the namespace ${JSON.stringify(namespace)} is not lowercase path components joined by /`);
  const allowed = options.allowBlobHosts ?? [];
  if (!Array.isArray(allowed) || allowed.some((h) => typeof h !== "string" || !HOSTNAME.test(h))) throw new GhcrError("usage", "allowBlobHosts is not a list of lowercase host names");
  const allowedHosts = new Set<string>(allowed);
  // A signed URL's host this reader asks: *.githubusercontent.com, or one the caller allowed.
  const blobHostOk = (u: URL): boolean => u.hostname.endsWith(BLOB_HOST_SUFFIX) || allowedHosts.has(u.hostname);
  let cacheErrors = 0;

  const cacheGet = async (key: string): Promise<string | null> => {
    if (cache === null) return null;
    try {
      return await cache.get(key);
    } catch {
      cacheErrors += 1;
      return null;
    }
  };
  const cachePut = async (key: string, value: string, ttl: number): Promise<void> => {
    if (cache === null || !(ttl >= 1)) return;
    try {
      await cache.put(key, value, Math.floor(ttl));
    } catch {
      cacheErrors += 1;
    }
  };

  // The manifest's bytes checked against what was asked for, and parsed.
  async function manifestOf(repo: string, ref: string, bytes: Uint8Array, contentType: string, from: "cache" | "registry", headerDigest: string | null): Promise<Manifest> {
    const what = `the manifest ${ref} of ${repo}`;
    const digest = await sha256Digest(bytes);
    if (DIGEST.test(ref) && digest !== ref) throw new GhcrError("integrity", `${what} hashes to ${digest}`);
    if (headerDigest !== null && headerDigest !== digest) throw new GhcrError("integrity", `${what} hashes to ${digest}, and GHCR named ${headerDigest}`);
    return { repo, ref, digest, bytes, contentType, json: parseManifest(bytes, what), from };
  }

  async function getManifest(repo: string, ref: string, opts: { maxBytes?: number } = {}): Promise<Manifest> {
    checkRepo(repo, namespace);
    checkRef(ref);
    const max = opts.maxBytes ?? MANIFEST_MAX_BYTES;
    if (!Number.isSafeInteger(max) || max < 1 || max > MANIFEST_LIMIT_BYTES) throw new GhcrError("usage", `maxBytes ${max} is not a whole number from 1 to ${MANIFEST_LIMIT_BYTES}`);
    const key = `ghcr:m:${repo}@${ref}`;
    const hit = await cacheGet(key);
    if (hit !== null) {
      try {
        const v = JSON.parse(hit) as { v?: number; contentType?: unknown; text?: unknown };
        const bytes = typeof v.text === "string" ? new TextEncoder().encode(v.text) : null;
        if (v.v === 1 && bytes !== null && bytes.byteLength <= max && typeof v.contentType === "string") {
          return await manifestOf(repo, ref, bytes, v.contentType, "cache", null);
        }
      } catch (err) {
        // A stored entry that is not a manifest of this ref is a miss: read GHCR.
        if (!(err instanceof GhcrError) && !(err instanceof SyntaxError)) throw err;
        cacheErrors += 1;
      }
    }
    const res = await ghcr(d, repo, `${REGISTRY}/v2/${repo}/manifests/${ref}`, { accept: MANIFEST_ACCEPT });
    if (res.status !== 200) throw await statusError(res, `manifest ${ref} of ${repo}`);
    const bytes = await readCapped(res, max, d.timeoutMs);
    if (bytes === null) throw new GhcrError("too-large", `the manifest ${ref} of ${repo} is over ${max} bytes`, 200);
    const header = res.headers.get("docker-content-digest");
    const m = await manifestOf(repo, ref, bytes, res.headers.get("content-type") ?? "application/octet-stream", "registry", header !== null && DIGEST.test(header) ? header : null);
    const text = new TextDecoder().decode(bytes);
    await cachePut(key, JSON.stringify({ v: 1, contentType: m.contentType, text }), DIGEST.test(ref) ? MANIFEST_TTL_S.byDigest : MANIFEST_TTL_S.byTag);
    return m;
  }

  async function headManifest(repo: string, ref: string): Promise<ManifestHead> {
    checkRepo(repo, namespace);
    checkRef(ref);
    const res = await ghcr(d, repo, `${REGISTRY}/v2/${repo}/manifests/${ref}`, { accept: MANIFEST_ACCEPT }, "HEAD");
    if (res.status !== 200) throw await statusError(res, `manifest ${ref} of ${repo}`);
    await discard(res);
    const digest = res.headers.get("docker-content-digest");
    const size = Number(res.headers.get("content-length"));
    if (digest === null || !DIGEST.test(digest)) throw new GhcrError("upstream", `GHCR answered the HEAD of ${ref} of ${repo} with no sha256 docker-content-digest`, 200);
    if (DIGEST.test(ref) && digest !== ref) throw new GhcrError("integrity", `GHCR answered the HEAD of ${ref} of ${repo} with the digest ${digest}`, 200);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MANIFEST_LIMIT_BYTES)
      throw new GhcrError("upstream", `GHCR answered the HEAD of ${ref} of ${repo} with the length ${res.headers.get("content-length")}`, 200);
    return { repo, ref, digest, size, contentType: res.headers.get("content-type") ?? "application/octet-stream" };
  }

  async function listTags(repo: string, opts: { maxPages?: number } = {}): Promise<TagList> {
    checkRepo(repo, namespace);
    const maxPages = opts.maxPages ?? TAG_PAGES_MAX;
    if (!Number.isSafeInteger(maxPages) || maxPages < 1) throw new GhcrError("usage", `maxPages ${maxPages} is not a whole number of at least 1`);
    const tags: string[] = [];
    const seen = new Set<string>();
    let url: string | null = `${REGISTRY}/v2/${repo}/tags/list?n=${TAG_PAGE}`;
    let pages = 0;
    while (url !== null && pages < maxPages) {
      if (seen.has(url)) throw new GhcrError("upstream", `the tag list of ${repo} names a page it already gave (${url})`);
      seen.add(url);
      const res = await ghcr(d, repo, url, { accept: "application/json" });
      if (res.status !== 200) throw await statusError(res, `tag list of ${repo}`);
      const bytes = await readCapped(res, TAG_PAGE_MAX_BYTES, d.timeoutMs);
      if (bytes === null) throw new GhcrError("too-large", `a page of the tag list of ${repo} is over ${TAG_PAGE_MAX_BYTES} bytes`, 200);
      let body: unknown;
      try {
        body = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        throw new GhcrError("upstream", `a page of the tag list of ${repo} is not JSON`, 200);
      }
      // GHCR answers a package with no tag with `"tags": null` or no member.
      const page = isObj(body) ? (body.tags ?? []) : null;
      if (!Array.isArray(page) || page.some((t) => typeof t !== "string")) throw new GhcrError("upstream", `a page of the tag list of ${repo} holds no list of tags`, 200);
      tags.push(...(page as string[]));
      pages += 1;
      url = nextTagPage(res.headers.get("link"), repo);
    }
    return { tags, pages, truncated: url !== null };
  }

  // The signed URL of a blob: the cache's while its se is ahead by the margin
  // and its host is one a 307 may name, else a new 307 from the registry. A 2xx
  // from the registry itself is handed back as `direct`.
  async function signedUrl(repo: string, digest: string, rangeHeader: string, fresh: boolean): Promise<{ signed: Signed; from: "cache" | "registry" } | { direct: Response }> {
    const key = `ghcr:u:${repo}@${digest}`;
    if (!fresh) {
      const hit = await cacheGet(key);
      if (hit !== null) {
        try {
          const v = JSON.parse(hit) as { url?: unknown; se?: unknown };
          const se = typeof v.se === "number" ? v.se : null;
          const kept = typeof v.url === "string" ? new URL(v.url) : null;
          if (kept !== null && kept.protocol === "https:" && blobHostOk(kept) && (se === null || se - Date.now() > SIGNED_MARGIN_S * 1000)) {
            return { signed: { url: kept.href, se }, from: "cache" };
          }
        } catch {
          // A stored entry that is not a signed URL is a miss: ask the registry.
          cacheErrors += 1;
        }
      }
    }
    const res = await ghcr(d, repo, `${REGISTRY}/v2/${repo}/blobs/${digest}`, { range: rangeHeader });
    if (res.status === 200 || res.status === 206) return { direct: res };
    if (res.status < 300 || res.status >= 400) throw await statusError(res, `blob ${digest} of ${repo}`);
    await discard(res);
    const location = res.headers.get("location");
    let u: URL | null = null;
    try {
      u = location ? new URL(location, REGISTRY) : null;
    } catch {
      u = null;
    }
    if (u === null || u.protocol !== "https:") throw new GhcrError("redirect", `GHCR redirected the blob ${digest} of ${repo} to ${u ? `${u.protocol}//${u.host}` : "no URL"}, not https`, res.status);
    if (!blobHostOk(u)) throw new GhcrError("redirect", `GHCR redirected the blob ${digest} of ${repo} to ${u.host}, which is not on *${BLOB_HOST_SUFFIX} nor a host this reader allows`, res.status);
    const se = signedExpiry(u);
    // With no se, the URL is used once and not kept; with one, at most SIGNED_MAX_S.
    if (se !== null) await cachePut(key, JSON.stringify({ url: u.href, se }), Math.min(se - Date.now(), SIGNED_MAX_S * 1000) / 1000 - SIGNED_MARGIN_S);
    return { signed: { url: u.href, se }, from: "registry" };
  }

  // The range answer checked: exactly the bytes [start, end).
  async function rangeBytes(res: Response, start: number, end: number, what: string, who: string): Promise<{ bytes: Uint8Array; size: number | null }> {
    const want = end - start;
    if (res.status === 416) {
      await discard(res);
      throw new GhcrError("range", `${what}: bytes ${start} to ${end - 1} are past the end of the blob (${res.headers.get("content-range") ?? "no Content-Range"})`, 416);
    }
    if (res.status === 200) {
      // The host ignored Range. Only a read of the whole blob from 0 may take it.
      const length = Number(res.headers.get("content-length"));
      if (start !== 0 || length !== want) {
        await discard(res);
        throw new GhcrError("upstream", `${what}: the host answered 200 to a Range of bytes ${start} to ${end - 1}, so it ignored the range`, 200);
      }
      const bytes = await readCapped(res, want, d.timeoutMs);
      if (bytes === null || bytes.byteLength !== want) throw new GhcrError("integrity", `${what}: the body is ${bytes === null ? "longer" : bytes.byteLength} bytes, not ${want}`, 200);
      return { bytes, size: want };
    }
    if (res.status !== 206) throw await statusError(res, what, who);
    const cr = contentRange(res.headers.get("content-range"));
    if (cr === null || cr.start !== start || cr.end !== end - 1) {
      await discard(res);
      throw new GhcrError("integrity", `${what}: the 206 answer's Content-Range is ${JSON.stringify(res.headers.get("content-range"))}, not bytes ${start}-${end - 1}`, 206);
    }
    const bytes = await readCapped(res, want, d.timeoutMs);
    if (bytes === null) throw new GhcrError("integrity", `${what}: the body is longer than the ${want} bytes asked for`, 206);
    if (bytes.byteLength !== want) throw new GhcrError("integrity", `${what}: the body is ${bytes.byteLength} bytes, not ${want}`, 206);
    return { bytes, size: cr.total };
  }

  async function readRange(repo: string, digest: string, start: number, end: number): Promise<RangeRead> {
    checkRepo(repo, namespace);
    checkDigest(digest);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start)
      throw new GhcrError("usage", `the range [${start}, ${end}) is not whole numbers with 0 <= start < end`);
    if (end - start > maxRange) throw new GhcrError("usage", `the range is ${end - start} bytes; a read is at most ${maxRange}`);
    const what = `bytes ${start} to ${end - 1} of the blob ${digest} of ${repo}`;
    const rangeHeader = `bytes=${start}-${end - 1}`;
    for (const fresh of [false, true]) {
      const s = await signedUrl(repo, digest, rangeHeader, fresh);
      if ("direct" in s) {
        const { bytes, size } = await rangeBytes(s.direct, start, end, what, "GHCR");
        return { bytes, size, host: REGISTRY_HOST, unexpected: false, se: null, signed: "registry" };
      }
      const u = new URL(s.signed.url);
      // The signed URL carries its own authority: no Authorization goes there.
      const res = await send(d, u.href, null, { range: rangeHeader });
      if (s.from === "cache" && !fresh && (res.status === 401 || res.status === 403 || res.status === 404)) {
        // A kept URL the host no longer honours: ask the registry for a new one, once.
        await discard(res);
        continue;
      }
      const { bytes, size } = await rangeBytes(res, start, end, what, u.host);
      return { bytes, size, host: u.host, unexpected: !u.hostname.endsWith(BLOB_HOST_SUFFIX), se: s.signed.se, signed: s.from };
    }
    // The loop returns or throws on its second pass, which asks the registry.
    throw new GhcrError("upstream", `${what}: no answer`);
  }

  return {
    dial: d,
    get cacheErrors() {
      return cacheErrors;
    },
    getManifest,
    headManifest,
    listTags,
    readRange,
  };
}
