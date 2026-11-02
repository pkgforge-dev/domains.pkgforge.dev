// apps/api/test/helpers.ts — what the Worker's Node tests share: the testkit's
// world (a GHCR stand-in behind a mock fetch, a Cache API stub with a clock), a
// synthetic root, and a blob host that answers Range reads of the bytes a test
// plants. Every digest, root and signed URL here is synthetic; no answer was
// recorded from GHCR.
import { BLOB_HOST, inWorld, T0, type World, type WorldOptions } from "@domains/testkit";
import { resetTokens } from "../../../packages/ghcr/src/reader.ts";
import worker from "../src/index.ts";
import { ROOT_TYPE, resetRoot } from "../src/root.ts";

export const BUILD = "0123456789ab";
export const ENV = Object.freeze({ BUILD });
export const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");
export const sha256 = async (bytes: Uint8Array | string): Promise<string> => {
  const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", b.slice()));
  return `sha256:${Array.from(d, (x) => x.toString(16).padStart(2, "0")).join("")}`;
};

// A root.json of format domains.root.v1 that names no pack: the head fields of
// a promoted root, and empty datasets, so validateRoot of packages/root holds
// it whole (as_of null, since no pack gives one).
export function rootDoc(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    format: "domains.root.v1",
    root_seq: 74,
    as_of: null,
    created: iso(T0 - 3600_000),
    previous: `sha256:${"9".repeat(64)}`,
    psl: "1f96bae40adfc22ca2474d7c0099bbcfcb25aefd3e2547b5c2147c0dd2e3ebd9",
    psl_live: [],
    corpus_since: {},
    gaps: {},
    through: {},
    counts: {},
    datasets: {},
    withdrawn: [],
    ...over,
  };
}

// Planted blob bytes by digest, which the blob host answers by Range.
export type Blobs = Map<string, Uint8Array>;

// The blob host of the signed URLs: a GET with `Range: bytes=A-B` answers 206
// with exactly those bytes, as pkg-containers.githubusercontent.com does. A
// URL with an Authorization header fails the test: the signed URL carries its
// own authority.
export function blobHost(w: World, blobs: Blobs): void {
  w.intercept = (url, init) => {
    if (!url.startsWith(`${BLOB_HOST}/`)) return undefined;
    const h = new Headers(init.headers);
    if (h.has("authorization")) throw new Error(`the blob host was sent an Authorization header: ${url}`);
    const d = /\/blobs\/(sha256:[0-9a-f]{64})\?/.exec(url)?.[1] ?? "";
    const bytes = blobs.get(d);
    if (bytes === undefined) return w.response(404, "BlobNotFound", {}, { url });
    const m = /^bytes=(\d+)-(\d+)$/.exec(h.get("range") ?? "");
    if (!m) return w.response(200, bytes, { "content-length": String(bytes.byteLength) }, { url });
    const start = Number(m[1]);
    const end = Math.min(Number(m[2]), bytes.byteLength - 1);
    const part = bytes.slice(start, end + 1);
    return w.response(206, part, { "content-range": `bytes ${start}-${end}/${bytes.byteLength}`, "content-length": String(part.byteLength) }, { url });
  };
}

export interface PlantedRoot {
  manifest: string;
  layer: string;
  size: number;
}

// root:latest in the world: a root manifest whose layer root.json holds `doc`,
// its blob answered with a 307 to a signed URL of the blob host.
export async function plantRoot(w: World, blobs: Blobs, doc: unknown = rootDoc(), extra: Record<string, unknown> = { artifactType: ROOT_TYPE }): Promise<PlantedRoot> {
  const bytes = new TextEncoder().encode(typeof doc === "string" ? doc : JSON.stringify(doc));
  const layer = await sha256(bytes);
  blobs.set(layer, bytes);
  w.blobs.set(`root@${layer}`, true);
  const body = w.manifest("root:latest", [["root.json", layer, bytes.byteLength]], extra);
  return { manifest: await sha256(body), layer, size: bytes.byteLength };
}

// A world for the Worker of apps/api: each test starts in a new isolate (no
// kept root, no kept token), with BUILD set and the blob host answering.
export async function apiWorld(setup: (w: World, blobs: Blobs) => void | Promise<void>, fn: (w: World, blobs: Blobs) => Promise<void>, options: WorldOptions = {}): Promise<void> {
  const blobs: Blobs = new Map();
  await inWorld(
    worker,
    async (w) => {
      blobHost(w, blobs);
      await setup(w, blobs);
    },
    (w) => fn(w, blobs),
    {
      env: ENV,
      ...options,
      resetIsolate: () => {
        resetRoot();
        resetTokens();
      },
    },
  );
}

// The GHCR requests (not the blob host's) a world saw from index `from` on.
export const ghcrRequests = (w: World, from = 0): { url: string; init: RequestInit }[] => w.since(from).filter((r) => r.url.startsWith("https://ghcr.io/"));

export const header = (init: RequestInit, name: string): string | null => new Headers(init.headers).get(name);

export async function body(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}
