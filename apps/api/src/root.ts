// apps/api/src/root.ts — the root the Worker answers from: `root:latest`
// (docs/architecture.md section 4.6), its layer `root.json`, kept in the isolate.
//
// Each request reads the manifest of `root:latest` through the `man` entry (30 s)
// or GHCR, so the answer names the root a read of this request gave. When its
// digest is the kept root's, the kept root answers with no other read.
// Otherwise the request reads `root.json` by its digest, through the `body`
// entry (1 year) or GHCR, holds the bytes to the digest, parses them, checks
// the head fields below, and keeps the root for the next request, unless the
// isolate keeps a root of a higher root_seq. The manifest is at most
// LIMITS.manifestBytes.
//
// The head check is what every route of DOM-030 reads: `format` (a reader
// refuses a format it does not know, section 11), `root_seq`, `created`,
// `as_of` and `previous`. validateRoot of packages/root, the reader's form,
// runs once per root and isolate when a route first reads the datasets
// (`datasets()`): on the root of 435,492 B of root_seq 73 it took 10 to 28 ms in
// one reading and 5 to 10 ms in another, five runs each, Node v26.7.0 on
// Windows 11, against the Worker's cpu_ms of 50 (MEASURED 2026-11-02,
// TODO/serve.md DOM-030). Its CPU on Cloudflare is not measured (DOM-054).
//
// Each read is a root read of the provenance (packages/core): it names the
// tier that served it in `x-domains-cache`, and no pack.
//
// When the read of a new root fails, GHCR's fault, a root this Worker refuses,
// or reads that pass LIMITS.rootMs in all, and the isolate keeps a root, the
// request answers from it as stale: `x-domains-degraded: 1` (section 7.1), and
// no read, since no read of this request served the kept root's bytes, so no
// `x-domains-cache`. Without a kept root the failure is the answer. A fault of
// the Worker itself (a GhcrError `usage`, or any other error) is never taken
// for GHCR's: it propagates, and the router answers 500.
//
// No promise is shared between requests: one request's reads never wait on
// another's I/O. Two requests that meet a new root at once each read it.
import type { PackRead, ReadTier } from "@domains/core";
import { artifactType, DIGEST, GhcrError, type GhcrReader, repoOf, TITLE } from "@domains/ghcr";
import { msOf, ROOT_FORMAT, RootError, type RootJson, validateRoot } from "@domains/root";
import type { ApiCache } from "./cache.ts";
import { ImmutableError, LIMITS, readImmutable } from "./ghcr.ts";

export const ROOT_REPO = repoOf("root");
export const ROOT_TAG = "latest";
export const ROOT_LAYER = "root.json";
export const ROOT_TYPE = artifactType("root");
// scripts/root/lib.mjs reads a root layer of up to 8 MiB; so does the Worker.
export const ROOT_LAYER_MAX_BYTES = 8 * 1024 * 1024;

export interface RootHead {
  readonly format: typeof ROOT_FORMAT;
  readonly root_seq: number;
  readonly as_of: string | null;
  readonly created: string;
  readonly previous: string | null;
}

// The parsed root.json, and its validateRoot once a route asked for it: one
// per root, shared by every LoadedRoot of that root.
interface RootBody {
  readonly json: Record<string, unknown>;
  validated: RootJson | null;
}

export class LoadedRoot {
  // The manifest digest of the root: what root:latest named.
  readonly digest: string;
  readonly layer: { readonly digest: string; readonly size: number };
  readonly head: RootHead;
  readonly createdMs: number;
  readonly #body: RootBody;

  constructor(digest: string, layer: { digest: string; size: number }, head: RootHead, body: RootBody) {
    this.digest = digest;
    this.layer = layer;
    this.head = head;
    this.createdMs = Date.parse(head.created);
    this.#body = body;
  }

  // root.json held whole by validateRoot in the reader's form (unknown fields
  // and datasets ignored), once a root; RootError when it fails.
  datasets(): RootJson {
    this.#body.validated ??= validateRoot(this.#body.json, { strict: false });
    return this.#body.validated;
  }
}

// The root of one request, the reads that gave it (none when stale), and
// whether it is stale.
export interface RootAnswer {
  readonly root: LoadedRoot;
  readonly reads: readonly PackRead[];
  readonly stale: boolean;
}

// The read of a new root failed and the isolate keeps none.
export class RootUnavailable extends Error {
  override name = "RootUnavailable";
  // true when GHCR holds no root:latest at all.
  readonly missing: boolean;
  constructor(message: string, missing: boolean) {
    super(message);
    this.missing = missing;
  }
}

// What one isolate keeps between its requests: a cache, never the only copy.
let kept: LoadedRoot | null = null;

// The state of a new isolate; the tests call it before each test.
export function resetRoot(): void {
  kept = null;
}

const tierOf = (from: "cache" | "registry"): ReadTier => (from === "cache" ? "cache" : "ghcr");

function refuse(message: string): never {
  throw new RootError("schema", message);
}

// The head fields of root.json, checked; RootError when one is not what a
// root of ROOT_FORMAT holds.
export function headOf(json: unknown): RootHead {
  if (typeof json !== "object" || json === null || Array.isArray(json)) refuse("root.json is not an object");
  const j = json as Record<string, unknown>;
  if (j.format !== ROOT_FORMAT) throw new RootError("format", `the format is ${JSON.stringify(j.format ?? null)}; this Worker knows ${ROOT_FORMAT}`);
  if (!Number.isSafeInteger(j.root_seq) || (j.root_seq as number) < 1) refuse(`root_seq is ${JSON.stringify(j.root_seq)}, not a whole number of at least 1`);
  msOf(j.created, "created");
  if (j.as_of !== null) msOf(j.as_of, "as_of");
  if (j.previous !== null && (typeof j.previous !== "string" || !DIGEST.test(j.previous))) refuse("previous is neither null nor a sha256: digest");
  return { format: ROOT_FORMAT, root_seq: j.root_seq as number, as_of: j.as_of as string | null, created: j.created as string, previous: j.previous as string | null };
}

async function readNew(g: GhcrReader, cache: ApiCache, reads: PackRead[]): Promise<LoadedRoot> {
  const m = await g.getManifest(ROOT_REPO, ROOT_TAG, { maxBytes: LIMITS.manifestBytes });
  reads.push({ tier: tierOf(m.from), pack: m.digest, sources: [], root: true });
  if (kept !== null && kept.digest === m.digest) return kept;
  if (m.json.artifactType !== ROOT_TYPE) refuse(`root:${ROOT_TAG} is ${JSON.stringify(m.json.artifactType ?? null)}, not ${ROOT_TYPE}`);
  const layers = (m.json.layers ?? []).filter((l) => l.annotations?.[TITLE] === ROOT_LAYER);
  const layer = layers[0];
  if (layer === undefined || layers.length !== 1) refuse(`root:${ROOT_TAG} holds ${layers.length} layers titled ${ROOT_LAYER}, not 1`);
  if (layer.size < 1 || layer.size > ROOT_LAYER_MAX_BYTES) refuse(`the layer ${ROOT_LAYER} is ${layer.size} B; this Worker reads 1 to ${ROOT_LAYER_MAX_BYTES} B`);
  const body = await readImmutable(g, cache, ROOT_REPO, layer.digest, 0, layer.size, { whole: layer.size });
  reads.push({ tier: body.tier, pack: m.digest, sources: [], root: true });
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(body.bytes));
  } catch {
    refuse(`the layer ${ROOT_LAYER} of ${m.digest} is not UTF-8 JSON`);
  }
  const head = headOf(json);
  const root = new LoadedRoot(m.digest, { digest: layer.digest, size: layer.size }, head, { json: json as Record<string, unknown>, validated: null });
  // root:latest moves forward in root_seq: buildRoot and rollbackRoot of
  // packages/root each promote the live root_seq plus 1. A root of a lower
  // root_seq than the kept one is a read that met the older manifest while
  // another request loaded the newer root: it answers its own request, and the
  // newer root stays kept.
  if (kept === null || root.head.root_seq >= kept.head.root_seq) kept = root;
  return root;
}

// A failure of GHCR, or a root this Worker refuses; anything else is the
// Worker's own fault.
const sourceFault = (err: unknown): err is Error => (err instanceof GhcrError && err.code !== "usage") || err instanceof RootError || err instanceof ImmutableError;

// The root a request answers from. `log` takes the message of a stale answer.
// The reads have `deadlineMs` in all; a read still running then is no
// answer's, and the request answers as GHCR failed.
export async function rootOf(g: GhcrReader, cache: ApiCache, log: (message: string) => void, deadlineMs: number = LIMITS.rootMs): Promise<RootAnswer> {
  const reads: PackRead[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new GhcrError("timeout", `GHCR did not give the root within ${deadlineMs / 1000} s`)), deadlineMs);
  });
  const work = readNew(g, cache, reads);
  // A read that ends after the deadline settles no answer.
  work.catch(() => undefined);
  try {
    const root = await Promise.race([work, late]);
    return { root, reads, stale: false };
  } catch (err) {
    if (!sourceFault(err)) throw err;
    const missing = err instanceof GhcrError && err.code === "missing" && reads.length === 0;
    if (kept === null) throw new RootUnavailable(missing ? `GHCR holds no root:${ROOT_TAG}` : err.message, missing);
    log(`answering from the kept root ${kept.digest} (root_seq ${kept.head.root_seq}): ${err.message}`);
    return { root: kept, reads: [], stale: true };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

// Whole seconds since the root's `created`, never below 0.
export const ageOf = (root: LoadedRoot, now: number): number => Math.max(0, Math.floor((now - root.createdMs) / 1000));
