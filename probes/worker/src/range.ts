// probes/worker/src/range.ts — GET /range: one Range read of a blob of this
// project's GHCR packages, made from the Worker and timed step by step (DOM-007,
// TODO/storage.md). scripts/measure/range-load.mjs drives it under load.
//
//   GET /range?tag=sha256:<manifest digest>&offset=0&length=25600&cache=none
//
// The query: repo (default pkgforge-dev/domains.pkgforge.dev/probe), tag (a tag
// or a manifest digest; required), offset (default 0), length (1 to
// LIMITS.max_length, default 1024), cache (none, signed or block; default none).
// A tag moves (DOM-006 pushes new bytes to probe:size-1536m on every dispatch),
// so a measurement names the manifest digest: range-load.mjs pins the tag to it
// with its first request.
//
// The steps, each one subrequest with its own time cap, in this order:
//   manifest  GET ghcr.io/v2/REPO/manifests/TAG with `Authorization: Bearer QQ==`
//             and the OCI Accept list; the largest layer is the one read
//   blob      GET ghcr.io/v2/REPO/blobs/DIGEST with redirect "manual": a 3xx
//             whose Location is https, the signed URL
//   range     GET the signed URL with `Range: bytes=OFFSET-END`, no Authorization
// A 401 or 403 to the dummy token reads the Bearer challenge (a `challenge` step
// when a 403 carries none), asks its realm, https on ghcr.io only, for a pull
// token (a `token` step), and asks once more with it. The token is used for that
// one request and never kept: GHCR answers a public package to the dummy token
// (MEASURED 2026-10-28T15:30:59Z, probe:size-1536m answered 200 to Bearer QQ==).
//
// cache=signed keeps the manifest and the signed URL in the Cache API, as
// mirror-archlinux's Worker does (TTL_S below). cache=block also keeps the block,
// under the key DIGEST/OFFSET-LENGTH, so a warm read makes no subrequest. The
// answer names a cache state (hit, miss or error) only for a cache it read.
//
// The answer is JSON with status 200 whenever the read was attempted, whatever
// GHCR answered: `status` is the status the read ended with (206 when it worked),
// `failed_at` the step that ended it, and each step carries its status and its
// milliseconds. A deployed Worker's clock advances only across I/O (locally,
// workerd's clock advances regardless), so deployed, a step's milliseconds are
// its subrequest's wall time. A query the route cannot read, or
// an offset past the layer's end, answers 400.
//
// Bounded by its own limits, never by refusing a caller (AGENTS.md absolute 8):
// the query is at most LIMITS.query_chars, a read at most LIMITS.max_length
// bytes, a manifest at most LIMITS.manifest_bytes, a token answer at most
// LIMITS.token_bytes, a subrequest at most LIMITS.subrequest_ms, all of one
// answer's subrequests at most LIMITS.total_ms, and at most
// LIMITS.max_subrequests subrequests (3, plus 3 for each of the two GHCR steps
// whose dummy token is refused).
//
// Not an open proxy: repo must be a package under pkgforge-dev/domains.pkgforge.dev/,
// so the route reads no other registry path; the only other host it asks is the
// one GHCR's own redirect names. The answer carries 16 bytes of each end of the
// block and its SHA-256, never the block, and never the signed URL or a token,
// which are credentials (docs/security/secrets.md).
import { ProbeError } from "./gaps.ts";
import type { Route } from "./index.ts";
import type { Env } from "./types.ts";

export const RANGE_VERSION = 1;
export const REGISTRY_HOST = "ghcr.io";
export const REGISTRY = `https://${REGISTRY_HOST}`;
// The namespace of docs/architecture.md section 4.1: the only packages the route reads.
export const NAMESPACE = "pkgforge-dev/domains.pkgforge.dev";
export const DEFAULT_REPO = `${NAMESPACE}/probe`;
// The dummy token GHCR accepts for a public package (docs/architecture.md section 4.3).
export const DUMMY = "Bearer QQ==";
// The manifest types asked for, the list of docs/research/reference/ghcr.ts.
export const MANIFEST_ACCEPT =
  "application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.oci.artifact.manifest.v1+json";
// The hosts GHCR's blob redirect lands on (MEASURED 2026-10-28T15:31:12Z:
// pkg-containers.githubusercontent.com). Another https host is followed and
// reported with expected_host false, so a move of GHCR's blob host shows in the answer.
export const BLOB_HOST_SUFFIX = ".githubusercontent.com";
export const TITLE = "org.opencontainers.image.title";

export const LIMITS = Object.freeze({
  // The largest read the entry asks for is 1 MB.
  max_length: 1_048_576,
  // mirror-archlinux's Worker refuses a manifest over 64 KiB; probe:size-1536m is 720 B (MEASURED 2026-10-28T15:30:59Z).
  manifest_bytes: 65_536,
  // GHCR's anonymous token answer was 97 B (MEASURED 2026-10-28T15:36:20Z).
  token_bytes: 4_096,
  // mirror-archlinux's subrequest deadline (READ its docs/worker.md, "Limits").
  subrequest_ms: 10_000,
  total_ms: 25_000,
  // manifest and blob: the dummy try, a bare challenge, the token and the second try each; then the range.
  max_subrequests: 9,
  query_chars: 512,
});

// mirror-archlinux docs/worker.md ("Caching"): a signed URL lives until its `se`
// minus 120 s and at most 600 s; a manifest by digest 1 year, by tag 30 s. A block
// is named by its blob's digest, so it never changes: its TTL only bounds how long
// the probe's entry stays, one day, which outlasts a measurement series.
export const TTL_S = Object.freeze({
  manifest_by_digest: 31_536_000,
  manifest_by_tag: 30,
  signed_margin: 120,
  signed_max: 600,
  block: 86_400,
});

export const CACHE_MODES = Object.freeze(["none", "signed", "block"] as const);
export type CacheMode = (typeof CACHE_MODES)[number];
type CacheKind = "man" | "loc" | "blk";
type CacheState = "hit" | "miss" | "error";

const QUERY_KEYS = Object.freeze(["repo", "tag", "offset", "length", "cache"]);
// A repository path under the namespace: lowercase components joined by . _ __ or dashes (the OCI grammar).
const REPO = /^pkgforge-dev\/domains\.pkgforge\.dev(?:\/[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*)+$/;
// A lowercase tag (every tag of this project is lowercase, section 4.1) or a manifest digest.
const REF = /^(?:[a-z0-9_][a-z0-9._-]{0,127}|sha256:[0-9a-f]{64})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const JSON_TYPE = "application/json; charset=utf-8";
const ENDS = 16;
const ERROR_CHARS = 200;

export interface RangeQuery {
  readonly repo: string;
  readonly ref: string;
  readonly offset: number;
  readonly length: number;
  readonly cache: CacheMode;
}

function intParam(url: URL, name: string, min: number, max: number, fallback: number): number {
  const text = url.searchParams.get(name);
  if (text === null) return fallback;
  const value = /^\d{1,16}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new ProbeError(400, `${name} must be a whole number from ${min} to ${max}`);
  return value;
}

// The query, checked. Throws ProbeError 400 on anything the route does not read.
export function parseQuery(url: URL): RangeQuery {
  if (url.search.length > LIMITS.query_chars) throw new ProbeError(400, `the query is over ${LIMITS.query_chars} characters`);
  const seen = new Set<string>();
  for (const name of url.searchParams.keys()) {
    if (!QUERY_KEYS.includes(name)) throw new ProbeError(400, `/range takes ${QUERY_KEYS.join(", ")}, not ${name.slice(0, 40)}`);
    if (seen.has(name)) throw new ProbeError(400, `${name} is given more than once`);
    seen.add(name);
  }
  const repo = url.searchParams.get("repo") ?? DEFAULT_REPO;
  if (repo.length > 255 || !REPO.test(repo)) throw new ProbeError(400, `repo must be a package of this project, ${NAMESPACE}/<name>: /range reads no other registry path`);
  const ref = url.searchParams.get("tag");
  if (ref === null) throw new ProbeError(400, "tag is required: a tag of the package, or its manifest digest sha256:<64 hex>, which never moves");
  if (!REF.test(ref)) throw new ProbeError(400, "tag must be a lowercase tag (letters, digits, . _ -, at most 128) or a manifest digest sha256:<64 hex>");
  const cache = url.searchParams.get("cache") ?? "none";
  if (!(CACHE_MODES as readonly string[]).includes(cache)) throw new ProbeError(400, `cache must be one of ${CACHE_MODES.join(", ")}`);
  return {
    repo,
    ref,
    offset: intParam(url, "offset", 0, Number.MAX_SAFE_INTEGER - LIMITS.max_length, 0),
    length: intParam(url, "length", 1, LIMITS.max_length, 1024),
    cache: cache as CacheMode,
  };
}

// The TTL of a signed URL whose `se` is seMs, read at nowMs: until se minus the
// margin, at most the cap; 0 (not kept) when that leaves under a second.
export function signedTtl(seMs: number, nowMs: number): number {
  const left = Math.floor((seMs - nowMs) / 1000) - TTL_S.signed_margin;
  return Math.max(0, Math.min(TTL_S.signed_max, left));
}

// The realm of a Bearer challenge, or null (docs/research/reference/ghcr.ts bearerRealm).
export function bearerRealm(www: string | null): string | null {
  if (typeof www !== "string" || !/^\s*bearer\s/i.test(www)) return null;
  return /\brealm="([^"]*)"/i.exec(www)?.[1] ?? null;
}

// `bytes A-B/T` as numbers, or null.
export function parseContentRange(text: string | null): { first: number; last: number; total: number } | null {
  const m = /^bytes (\d{1,16})-(\d{1,16})\/(\d{1,16})$/.exec(text ?? "");
  if (m === null) return null;
  return { first: Number(m[1]), last: Number(m[2]), total: Number(m[3]) };
}

// An error's text with any URL query removed, so a signed URL's signature never
// reaches an answer or a log.
export function redact(text: string): string {
  return text.replace(/\?[^\s"'<>]*/g, "?REDACTED").slice(0, ERROR_CHARS);
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return `sha256:${hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)))}`;
}

// The body read to its end, or null when more than `max` bytes arrive: the reader
// is then cancelled, so an answer larger than the cap is never buffered.
export async function readCapped(body: ReadableStream<Uint8Array> | null, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const out = new Uint8Array(max);
  if (body === null) return out.subarray(0, 0);
  const reader = body.getReader();
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out.subarray(0, total);
    if (total + value.byteLength > max) {
      await reader.cancel();
      return null;
    }
    out.set(value, total);
    total += value.byteLength;
  }
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // A body that cannot be cancelled is already closed or errored: nothing is left to free.
  }
}

// caches.default exists only in workerd, so Node's types do not declare it: the
// interface names the two members the route uses (as src/index.ts does).
interface ProbeCache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, response: Response): Promise<void>;
}

const defaultCache = (): ProbeCache | undefined => (globalThis as unknown as { caches?: { default?: ProbeCache } }).caches?.default;

export type StepName = "manifest" | "challenge" | "token" | "blob" | "range";

export interface Step {
  readonly step: StepName;
  readonly from: "ghcr" | "cache";
  // dummy: Bearer QQ==; token: a pull token from the challenge's realm; none: no Authorization.
  readonly auth?: "dummy" | "token" | "none";
  status: number | null;
  ms: number;
  // The range step's time to its response head; ms runs to the body's last byte.
  head_ms?: number;
  error?: string;
}

interface CachePut {
  readonly kind: CacheKind;
  readonly ttl_s: number;
  ok: boolean;
  ms: number;
  error?: string;
}

interface CacheReport {
  readonly mode: CacheMode;
  manifest?: CacheState;
  signed?: CacheState;
  block?: CacheState;
  puts: CachePut[];
}

interface Layer {
  readonly digest: string;
  readonly size: number;
  readonly title: string | null;
  readonly index: number;
}

interface Signed {
  readonly host: string;
  readonly expected_host: boolean;
  readonly se: string | null;
  readonly se_in_s: number | null;
}

interface Read {
  readonly query: RangeQuery;
  readonly origin: string;
  readonly now: () => number;
  readonly deadline: number;
  readonly cache: ProbeCache | null;
  readonly report: CacheReport;
  readonly steps: Step[];
  subrequests: number;
}

function fault(err: unknown): string {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const message = err instanceof Error ? err.message : String(err);
  return redact(`unreachable: ${typeof name === "string" ? name : "Error"}: ${message}`);
}

// One subrequest, recorded as a step: never more than LIMITS.max_subrequests, and
// never past the answer's deadline; a redirect is never followed.
async function send(r: Read, step: Step, url: string, headers: Record<string, string>): Promise<Response | null> {
  r.steps.push(step);
  const started = r.now();
  const left = r.deadline - started;
  if (r.subrequests >= LIMITS.max_subrequests) throw new ProbeError(500, `the read reached ${LIMITS.max_subrequests} subrequests`);
  if (left <= 0) {
    step.error = `the answer's ${LIMITS.total_ms} ms had passed before this step`;
    return null;
  }
  r.subrequests += 1;
  try {
    const res = await fetch(url, { method: "GET", headers, redirect: "manual", signal: AbortSignal.timeout(Math.min(LIMITS.subrequest_ms, left)) });
    step.status = res.status;
    return res;
  } catch (err) {
    step.error = fault(err);
    return null;
  } finally {
    step.ms = r.now() - started;
  }
}

// A pull token from the realm of GHCR's challenge, or null with the reason in a step.
async function pullToken(r: Read, url: string, refused: number, www: string | null): Promise<string | null> {
  let realm = bearerRealm(www);
  if (realm === null && refused === 403) {
    // GHCR answers 403 with no challenge; a request with no Authorization gets 401 with one.
    const bare = await send(r, { step: "challenge", from: "ghcr", auth: "none", status: null, ms: 0 }, url, {});
    if (bare === null) return null;
    realm = bearerRealm(bare.headers.get("www-authenticate"));
    await discard(bare);
  }
  const step: Step = { step: "token", from: "ghcr", auth: "none", status: null, ms: 0 };
  let u: URL | null = null;
  try {
    u = realm === null ? null : new URL(realm);
  } catch {
    u = null;
  }
  if (u === null || u.protocol !== "https:" || u.hostname !== REGISTRY_HOST) {
    step.error = `GHCR answered ${refused} and named no https realm on ${REGISTRY_HOST}`;
    r.steps.push(step);
    return null;
  }
  u.searchParams.set("service", REGISTRY_HOST);
  u.searchParams.set("scope", `repository:${r.query.repo}:pull`);
  const res = await send(r, step, u.href, { accept: "application/json" });
  if (res === null) return null;
  if (res.status !== 200) {
    await discard(res);
    return null;
  }
  const bytes = await readCapped(res.body, LIMITS.token_bytes);
  let token: unknown = null;
  try {
    const body = bytes === null ? null : (JSON.parse(new TextDecoder().decode(bytes)) as { token?: unknown; access_token?: unknown });
    token = [body?.token, body?.access_token].find((t) => typeof t === "string" && t !== "") ?? null;
  } catch {
    token = null;
  }
  if (typeof token !== "string") {
    step.error = bytes === null ? `the token answer is over ${LIMITS.token_bytes} bytes` : "the token answer holds no token";
    return null;
  }
  return token;
}

// One GHCR request: the dummy token, then on a 401 or 403 one pull token and one more try.
async function ghcr(r: Read, name: "manifest" | "blob", url: string, headers: Record<string, string>): Promise<{ res: Response | null; step: Step }> {
  const first: Step = { step: name, from: "ghcr", auth: "dummy", status: null, ms: 0 };
  const res = await send(r, first, url, { ...headers, authorization: DUMMY });
  if (res === null || (res.status !== 401 && res.status !== 403)) return { res, step: first };
  const www = res.headers.get("www-authenticate");
  await discard(res);
  const token = await pullToken(r, url, res.status, www);
  if (token === null) return { res: null, step: first };
  const second: Step = { step: name, from: "ghcr", auth: "token", status: null, ms: 0 };
  return { res: await send(r, second, url, { ...headers, authorization: `Bearer ${token}` }), step: second };
}

function cacheKey(origin: string, kind: CacheKind, name: string): Request {
  return new Request(`${origin}/__cache/v1/${kind}/${name}`);
}

async function cacheMatch(r: Read, kind: CacheKind, key: Request): Promise<Response | null> {
  if (r.cache === null) return null;
  const field = kind === "man" ? "manifest" : kind === "loc" ? "signed" : "block";
  try {
    const hit = await r.cache.match(key);
    r.report[field] = hit === undefined ? "miss" : "hit";
    return hit ?? null;
  } catch {
    // A cache that fails is read as a miss, and the answer says it failed.
    r.report[field] = "error";
    return null;
  }
}

// The status of the step an entry stands for (200, a 3xx or 206), kept beside it:
// the Cache API stores neither a 206 nor a redirect as such.
const STEP_STATUS = "x-step-status";

function storedStatus(hit: Response): number {
  const stored = Number(hit.headers.get(STEP_STATUS));
  return Number.isInteger(stored) && stored >= 100 && stored <= 599 ? stored : hit.status;
}

// Puts one entry with its TTL. A TTL under a second is not kept, and the answer says so.
async function cachePut(r: Read, kind: CacheKind, key: Request, body: Uint8Array<ArrayBuffer> | string, ttl: number, status: number, headers: Record<string, string>): Promise<void> {
  if (r.cache === null) return;
  const put: CachePut = { kind, ttl_s: ttl, ok: false, ms: 0 };
  r.report.puts.push(put);
  if (ttl < 1) {
    put.error = "a TTL under 1 s: not kept";
    return;
  }
  const started = r.now();
  try {
    await r.cache.put(key, new Response(body, { status: 200, headers: { ...headers, [STEP_STATUS]: String(status), "cache-control": `public, max-age=${ttl}` } }));
    put.ok = true;
  } catch (err) {
    put.error = redact(err instanceof Error ? err.message : String(err));
  } finally {
    put.ms = r.now() - started;
  }
}

// The largest layer of an image manifest (the first of equal sizes), or the reason there is none.
export function pickLayer(doc: unknown): Layer | string {
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return "the manifest is not a JSON object";
  const { layers, manifests } = doc as { layers?: unknown; manifests?: unknown };
  if (!Array.isArray(layers)) return Array.isArray(manifests) ? "the manifest is an image index: ask one of its manifests by digest" : "the manifest has no layers";
  let best: Layer | null = null;
  for (const [index, layer] of layers.entries()) {
    const { digest, size, annotations } = (layer ?? {}) as { digest?: unknown; size?: unknown; annotations?: Record<string, unknown> };
    if (typeof digest !== "string" || !DIGEST.test(digest) || typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return `layer ${index} has no sha256 digest and whole size`;
    const title = typeof annotations?.[TITLE] === "string" ? (annotations[TITLE] as string) : null;
    if (best === null || size > best.size) best = { digest, size, title, index };
  }
  return best ?? "the manifest has no layers";
}

interface Manifest {
  readonly digest: string;
  readonly layer: Layer;
}

async function manifestFrom(step: Step, bytes: Uint8Array<ArrayBuffer>, ref: string, headerDigest: string | null): Promise<Manifest | null> {
  const digest = await sha256(bytes);
  // A digest names one manifest: bytes that hash to another are not it.
  if (DIGEST.test(ref) && digest !== ref) {
    step.error = `the manifest's bytes hash to ${digest}, not the digest asked`;
    return null;
  }
  if (headerDigest !== null && headerDigest !== digest) {
    step.error = `the manifest's bytes hash to ${digest}, and docker-content-digest says ${headerDigest.slice(0, 80)}`;
    return null;
  }
  let doc: unknown = null;
  try {
    doc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    step.error = "the manifest is not JSON";
    return null;
  }
  const layer = pickLayer(doc);
  if (typeof layer === "string") {
    step.error = layer;
    return null;
  }
  return { digest, layer };
}

async function manifestStep(r: Read): Promise<Manifest | null> {
  const q = r.query;
  const key = cacheKey(r.origin, "man", `${encodeURIComponent(q.repo)}/${encodeURIComponent(q.ref)}`);
  const started = r.now();
  const hit = await cacheMatch(r, "man", key);
  if (hit !== null) {
    const step: Step = { step: "manifest", from: "cache", status: storedStatus(hit), ms: 0 };
    r.steps.push(step);
    const bytes = await readCapped(hit.body, LIMITS.manifest_bytes);
    step.ms = r.now() - started;
    if (bytes === null) {
      step.error = `the cached manifest is over ${LIMITS.manifest_bytes} bytes`;
      return null;
    }
    return manifestFrom(step, bytes, q.ref, null);
  }
  const { res, step } = await ghcr(r, "manifest", `${REGISTRY}/v2/${q.repo}/manifests/${q.ref}`, { accept: MANIFEST_ACCEPT });
  if (res === null) return null;
  if (res.status !== 200) {
    await discard(res);
    return null;
  }
  const before = r.now() - step.ms;
  const bytes = await readCapped(res.body, LIMITS.manifest_bytes);
  step.ms = r.now() - before;
  if (bytes === null) {
    step.error = `the manifest is over ${LIMITS.manifest_bytes} bytes`;
    return null;
  }
  const manifest = await manifestFrom(step, bytes, q.ref, res.headers.get("docker-content-digest"));
  if (manifest !== null) {
    const ttl = DIGEST.test(q.ref) ? TTL_S.manifest_by_digest : TTL_S.manifest_by_tag;
    await cachePut(r, "man", key, bytes, ttl, res.status, { "content-type": res.headers.get("content-type") ?? "application/json" });
  }
  return manifest;
}

// The signed URL in a Location, checked: https only, with the host and `se` reported.
function signedOf(location: string | null, nowMs: number): { url: URL; info: Signed } | string {
  let u: URL;
  try {
    if (location === null) return "the redirect carries no Location";
    u = new URL(location, REGISTRY);
  } catch {
    return "the redirect's Location is not a URL";
  }
  if (u.protocol !== "https:") return `the redirect's Location is ${u.protocol.replace(/:$/, "")}, not https`;
  const seMs = Date.parse(u.searchParams.get("se") ?? "");
  const se = Number.isFinite(seMs) ? new Date(seMs).toISOString() : null;
  return { url: u, info: { host: u.hostname, expected_host: u.hostname.endsWith(BLOB_HOST_SUFFIX), se, se_in_s: se === null ? null : Math.round((seMs - nowMs) / 1000) } };
}

async function signedStep(r: Read, layer: Layer): Promise<{ url: URL; info: Signed } | null> {
  const q = r.query;
  const key = cacheKey(r.origin, "loc", `${encodeURIComponent(q.repo)}/${layer.digest}`);
  const started = r.now();
  const hit = await cacheMatch(r, "loc", key);
  if (hit !== null) {
    const step: Step = { step: "blob", from: "cache", status: storedStatus(hit), ms: 0 };
    r.steps.push(step);
    const text = await hit.text();
    step.ms = r.now() - started;
    const signed = signedOf(text, r.now());
    if (typeof signed === "string") {
      step.error = `the cached signed URL: ${signed}`;
      return null;
    }
    return signed;
  }
  const { res, step } = await ghcr(r, "blob", `${REGISTRY}/v2/${q.repo}/blobs/${layer.digest}`, {});
  if (res === null) return null;
  await discard(res);
  if (res.status < 300 || res.status > 399) {
    step.error = res.status === 200 || res.status === 206 ? "GHCR answered the blob itself, not a redirect: its body is not read" : `GHCR answered ${res.status}, not a redirect`;
    return null;
  }
  const signed = signedOf(res.headers.get("location"), r.now());
  if (typeof signed === "string") {
    step.error = signed;
    return null;
  }
  // A signed URL that names no `se` has no known life, so it is not kept.
  const ttl = signed.info.se === null ? 0 : signedTtl(Date.parse(signed.info.se), r.now());
  await cachePut(r, "loc", key, signed.url.href, ttl, res.status, { "content-type": "text/plain; charset=utf-8" });
  return signed;
}

interface Bytes {
  readonly read: number;
  readonly first: number;
  readonly last: number;
  readonly head: string;
  readonly tail: string;
  readonly sha256: string;
}

async function bytesOf(bytes: Uint8Array<ArrayBuffer>, offset: number): Promise<Bytes> {
  return {
    read: bytes.byteLength,
    first: offset,
    last: offset + bytes.byteLength - 1,
    head: hex(bytes.subarray(0, ENDS)),
    tail: hex(bytes.subarray(Math.max(0, bytes.byteLength - ENDS))),
    sha256: await sha256(bytes),
  };
}

async function blockHit(r: Read, key: Request): Promise<Bytes | null> {
  const q = r.query;
  const started = r.now();
  const hit = await cacheMatch(r, "blk", key);
  if (hit === null) return null;
  const step: Step = { step: "range", from: "cache", status: storedStatus(hit), ms: 0 };
  r.steps.push(step);
  const bytes = await readCapped(hit.body, q.length);
  step.ms = r.now() - started;
  if (bytes === null || bytes.byteLength !== q.length) {
    // A cached block of the wrong length is not trusted: the read goes to GHCR, and the answer says so.
    step.error = `the cached block is not ${q.length} bytes`;
    r.report.block = "error";
    return null;
  }
  return bytesOf(bytes, q.offset);
}

async function rangeStep(r: Read, layer: Layer, signed: URL): Promise<Bytes | null> {
  const q = r.query;
  const end = q.offset + q.length - 1;
  const step: Step = { step: "range", from: "ghcr", auth: "none", status: null, ms: 0 };
  // The signed URL carries its own authority: no Authorization goes there.
  const res = await send(r, step, signed.href, { range: `bytes=${q.offset}-${end}` });
  if (res === null) return null;
  step.head_ms = step.ms;
  const before = r.now() - step.ms;
  if (res.status !== 206) {
    // A 200 would be the whole blob: it is never read.
    await discard(res);
    if (res.status === 200) step.error = "the blob host ignored Range and answered the whole blob, which is not read";
    return null;
  }
  const range = parseContentRange(res.headers.get("content-range"));
  if (range === null || range.first !== q.offset || range.last !== end || range.total !== layer.size) {
    await discard(res);
    step.error = `Content-Range ${JSON.stringify((res.headers.get("content-range") ?? "").slice(0, 80))} is not bytes ${q.offset}-${end}/${layer.size}`;
    return null;
  }
  let bytes: Uint8Array<ArrayBuffer> | null;
  try {
    bytes = await readCapped(res.body, q.length);
  } catch (err) {
    step.ms = r.now() - before;
    step.error = `the body failed: ${fault(err)}`;
    return null;
  }
  step.ms = r.now() - before;
  if (bytes === null || bytes.byteLength !== q.length) {
    step.error = bytes === null ? `the blob host sent more than the ${q.length} bytes asked` : `the blob host sent ${bytes.byteLength} of the ${q.length} bytes asked`;
    return null;
  }
  if (q.cache === "block") {
    const key = cacheKey(r.origin, "blk", `${layer.digest}/${q.offset}-${q.length}`);
    await cachePut(r, "blk", key, bytes, TTL_S.block, res.status, { "content-type": "application/octet-stream", "content-range": `bytes ${q.offset}-${end}/${layer.size}` });
  }
  return bytesOf(bytes, q.offset);
}

function colo(request: Request): { cf_ray: string | null; colo: string | null } {
  const ray = request.headers.get("cf-ray");
  const fromCf = (request as unknown as { cf?: { colo?: unknown } }).cf?.colo;
  const fromRay = ray === null ? null : (/-([A-Z]{3})$/.exec(ray)?.[1] ?? null);
  return { cf_ray: ray, colo: typeof fromCf === "string" ? fromCf : fromRay };
}

export interface RangeAnswer {
  readonly v: number;
  readonly entry: "DOM-007";
  readonly query: { repo: string; tag: string; offset: number; length: number; cache: CacheMode };
  readonly ok: boolean;
  readonly status: number | null;
  readonly failed_at: StepName | null;
  readonly error: string | null;
  readonly manifest: { digest: string } | null;
  readonly layer: Layer | null;
  readonly signed: Signed | null;
  readonly bytes: Bytes | null;
  readonly steps: Step[];
  readonly subrequests: number;
  readonly total_ms: number;
  readonly cf_ray: string | null;
  readonly colo: string | null;
  readonly cache: CacheReport;
  readonly limits: typeof LIMITS;
}

// One read, as the answer reports it.
export async function readRange(request: Request, q: RangeQuery, origin: string, now: () => number): Promise<RangeAnswer> {
  const started = now();
  let cache: ProbeCache | null = null;
  if (q.cache !== "none") {
    cache = defaultCache() ?? null;
    if (cache === null) throw new ProbeError(500, `cache=${q.cache} needs the Cache API, and this runtime has none`);
  }
  const r: Read = { query: q, origin, now, deadline: started + LIMITS.total_ms, cache, report: { mode: q.cache, puts: [] }, steps: [], subrequests: 0 };
  let manifest: Manifest | null = null;
  let signed: Signed | null = null;
  let bytes: Bytes | null = null;
  manifest = await manifestStep(r);
  if (manifest !== null) {
    const layer = manifest.layer;
    if (q.offset + q.length > layer.size) throw new ProbeError(400, `offset ${q.offset} and length ${q.length} pass the end of layer ${layer.index}, ${layer.size} bytes`);
    const blockKey = cacheKey(origin, "blk", `${layer.digest}/${q.offset}-${q.length}`);
    if (q.cache === "block") bytes = await blockHit(r, blockKey);
    if (bytes === null) {
      const found = await signedStep(r, layer);
      if (found !== null) {
        signed = found.info;
        bytes = await rangeStep(r, layer, found.url);
      }
    }
  }
  const last = r.steps.at(-1) ?? null;
  const ok = bytes !== null && last !== null && last.step === "range" && last.status === 206 && last.error === undefined;
  return {
    v: RANGE_VERSION,
    entry: "DOM-007",
    query: { repo: q.repo, tag: q.ref, offset: q.offset, length: q.length, cache: q.cache },
    ok,
    status: last?.status ?? null,
    failed_at: ok || last === null ? null : last.step,
    error: ok ? null : (last?.error ?? null),
    manifest: manifest === null ? null : { digest: manifest.digest },
    layer: manifest?.layer ?? null,
    signed,
    bytes: ok ? bytes : null,
    steps: r.steps,
    subrequests: r.subrequests,
    total_ms: now() - started,
    ...colo(request),
    cache: r.report,
    limits: LIMITS,
  };
}

async function rangeHandle(request: Request, _env: Env, url: URL, now: () => number): Promise<Response> {
  const query = parseQuery(url);
  const answer = await readRange(request, query, url.origin, now);
  return new Response(`${JSON.stringify(answer, null, 2)}\n`, { status: 200, headers: { "content-type": JSON_TYPE, "cache-control": "no-store" } });
}

export const rangeRoute: Route = {
  method: "GET",
  path: "/range",
  entry: "DOM-007",
  summary: `one Range read of a blob of this project's GHCR packages, timed step by step: repo (default ${DEFAULT_REPO}; only packages under ${NAMESPACE}/), tag (a tag or a manifest digest, required), offset (default 0), length (1 to ${LIMITS.max_length}, default 1024), cache=none|signed|block (default none)`,
  handle: rangeHandle,
};
