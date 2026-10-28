// probes/worker/test/range-workerd.test.ts — the /range route of DOM-007 in
// workerd (Miniflare, through @domains/testkit), behind test/range-entry.ts,
// against a mock registry: every outbound fetch the Worker makes is answered by
// `registry` below, never by the network. The registry, its blob bytes, its
// digests and its signed URLs are synthetic; no answer here was recorded from
// GHCR. It proves what the Node test (src/range.test.ts) cannot: that workerd
// hands a redirect asked with redirect "manual" back to the Worker, that the
// real Cache API keeps the manifest, the signed URL and a binary block, and that
// the route bundles and runs under the probe's compatibility date and flags.
//
//   node scripts/test.mjs probes/worker --name range
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Outbound, withWorker } from "@domains/testkit";

const ENTRY = fileURLToPath(new URL("./range-entry.ts", import.meta.url));
const REPO = "pkgforge-dev/domains.pkgforge.dev/probe";
const LOCKED = "pkgforge-dev/domains.pkgforge.dev/locked";
const TAG = "size-test";
const SIZE = 200_000;
const DUMMY = "Bearer QQ==";
const PULL = "Bearer synthetic-pull-token";
const BLOB_HOST = "https://pkg-containers.githubusercontent.com";
// Bytes of every value from 0 to 255, so a block that the Cache API changed would not hash the same.
const DATA = Uint8Array.from({ length: SIZE }, (_, i) => (i * 131 + (i >> 9)) & 255);
const sha = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const LAYER = sha(DATA);
const MANIFEST = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  artifactType: "application/vnd.pkgforge.domains.probe.v1",
  config: { mediaType: "application/vnd.oci.empty.v1+json", digest: sha("{}"), size: 2 },
  layers: [{ mediaType: "application/octet-stream", digest: LAYER, size: SIZE, annotations: { "org.opencontainers.image.title": "payload.bin" } }],
});
const PINNED = sha(MANIFEST);

interface Seen {
  url: string;
  authorization: string | null;
  accept: string | null;
  range: string | null;
}

// A signed URL of the mock blob host, whose se is 480 s ahead of the real clock (workerd's).
const signed = (path: string, scheme = "https"): string => {
  const se = new Date(Date.now() + 480_000).toISOString().replace(/\.\d{3}Z$/, "Z");
  return `${scheme}://pkg-containers.githubusercontent.com/ghcrblobs10/blobs/${path}?se=${encodeURIComponent(se)}&sig=synthetic%2Bsig&sp=r`;
};

// The mock registry: REPO answers the dummy token; LOCKED answers only a pull
// token from the anonymous flow; the blob of `http-layer` redirects to http.
function registry(seen: Seen[]): Outbound {
  return (request) => {
    const h = request.headers;
    seen.push({ url: request.url, authorization: h.get("authorization"), accept: h.get("accept"), range: h.get("range") });
    const url = new URL(request.url);
    const auth = h.get("authorization");
    if (url.origin === BLOB_HOST) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(h.get("range") ?? "");
      if (m === null) return new Response("no range", { status: 400 });
      const first = Number(m[1]);
      const last = Number(m[2]);
      return new Response(DATA.slice(first, last + 1), { status: 206, headers: { "content-range": `bytes ${first}-${last}/${SIZE}`, "accept-ranges": "bytes" } });
    }
    if (url.origin === "https://ghcr.io" && url.pathname === "/token") return Response.json({ token: PULL.slice("Bearer ".length) });
    const m = /^\/v2\/(.+)\/(manifests|blobs)\/([^/]+)$/.exec(url.pathname);
    if (url.origin !== "https://ghcr.io" || m === null) return new Response("unknown", { status: 404 });
    const [, repo, kind, ref] = m;
    if (repo === LOCKED && auth !== PULL)
      return new Response("", { status: 401, headers: { "www-authenticate": `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${LOCKED}:pull"` } });
    if (repo !== LOCKED && auth !== DUMMY) return new Response("", { status: 403 });
    if (kind === "manifests" && (ref === TAG || ref === PINNED)) {
      return new Response(MANIFEST, { status: 200, headers: { "content-type": "application/vnd.oci.image.manifest.v1+json", "docker-content-digest": PINNED } });
    }
    if (kind === "blobs" && ref === LAYER) return new Response(null, { status: 307, headers: { location: signed(LAYER, repo === LOCKED ? "http" : "https") } });
    return new Response('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', { status: 404 });
  };
}

interface Answer {
  ok: boolean;
  status: number | null;
  failed_at: string | null;
  error: string | null;
  manifest: { digest: string } | null;
  steps: { step: string; from: string; auth?: string; status: number | null }[];
  subrequests: number;
  bytes: { read: number; first: number; last: number; sha256: string } | null;
  signed: { host: string; expected_host: boolean; se_in_s: number | null } | null;
  cache: { mode: string; manifest?: string; signed?: string; block?: string; puts: { kind: string; ttl_s: number; ok: boolean }[] };
}

test("range workerd: a read makes three subrequests, workerd hands the 307 back to the route, and the real Cache API then answers a binary block with none", async () => {
  const seen: Seen[] = [];
  await withWorker({ scriptPath: ENTRY, outbound: registry(seen) }, async (w) => {
    const res = await w.fetch(`/range?tag=${PINNED}&offset=65536&length=65536&cache=block`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("cache-control"), "no-store");
    const text = await res.text();
    const first = JSON.parse(text) as Answer;
    assert.equal(first.ok, true, text);
    assert.equal(first.status, 206);
    assert.deepEqual(
      first.steps.map((s) => [s.step, s.from, s.status]),
      [
        ["manifest", "ghcr", 200],
        ["blob", "ghcr", 307],
        ["range", "ghcr", 206],
      ],
    );
    assert.equal(first.subrequests, 3);
    assert.deepEqual(first.manifest, { digest: PINNED });
    assert.deepEqual(first.bytes && { read: first.bytes.read, first: first.bytes.first, last: first.bytes.last, sha256: first.bytes.sha256 }, {
      read: 65536,
      first: 65536,
      last: 131071,
      sha256: sha(DATA.subarray(65536, 131072)),
    });
    assert.equal(first.signed?.host, "pkg-containers.githubusercontent.com");
    assert.equal(first.signed?.expected_host, true);
    assert.ok(!text.includes("sig="), "the signed URL is not in the answer");
    // The route fetched the Location itself, once: workerd did not follow the redirect.
    assert.deepEqual(
      seen.map((s) => [new URL(s.url).origin + new URL(s.url).pathname, s.authorization, s.range]),
      [
        [`https://ghcr.io/v2/${REPO}/manifests/${PINNED}`, DUMMY, null],
        [`https://ghcr.io/v2/${REPO}/blobs/${LAYER}`, DUMMY, null],
        [`${BLOB_HOST}/ghcrblobs10/blobs/${LAYER}`, null, "bytes=65536-131071"],
      ],
    );
    assert.match(seen[0]?.accept ?? "", /application\/vnd\.oci\.image\.manifest\.v1\+json/);
    const loc = first.cache.puts.find((p) => p.kind === "loc");
    assert.ok(loc !== undefined && loc.ok && loc.ttl_s >= 300 && loc.ttl_s <= 360, `the signed URL is kept until se minus 120 s: ${JSON.stringify(loc)}`);
    assert.deepEqual(
      first.cache.puts.map((p) => [p.kind, p.ok]),
      [
        ["man", true],
        ["loc", true],
        ["blk", true],
      ],
    );

    const again = (await (await w.fetch(`/range?tag=${PINNED}&offset=65536&length=65536&cache=block`)).json()) as Answer;
    assert.equal(again.ok, true);
    assert.equal(again.subrequests, 0);
    assert.deepEqual([again.cache.manifest, again.cache.block, again.cache.signed], ["hit", "hit", undefined]);
    assert.deepEqual(
      again.steps.map((s) => [s.step, s.from, s.status]),
      [
        ["manifest", "cache", 200],
        ["range", "cache", 206],
      ],
    );
    assert.equal(again.bytes?.sha256, first.bytes?.sha256);

    const next = (await (await w.fetch(`/range?tag=${PINNED}&offset=0&length=1024&cache=block`)).json()) as Answer;
    assert.equal(next.ok, true);
    assert.equal(next.subrequests, 1);
    assert.deepEqual([next.cache.manifest, next.cache.block, next.cache.signed], ["hit", "miss", "hit"]);
    assert.deepEqual(
      next.steps.map((s) => [s.step, s.from, s.status]),
      [
        ["manifest", "cache", 200],
        ["blob", "cache", 307],
        ["range", "ghcr", 206],
      ],
    );
    assert.equal(next.bytes?.sha256, sha(DATA.subarray(0, 1024)));
    assert.equal(seen.length, 4);
  });
});

test("range workerd: the anonymous token flow, an http redirect refused, and a repo outside the namespace refused before any fetch", async () => {
  const seen: Seen[] = [];
  await withWorker({ scriptPath: ENTRY, outbound: registry(seen) }, async (w) => {
    const locked = (await (await w.fetch(`/range?repo=${LOCKED}&tag=${TAG}`)).json()) as Answer;
    assert.equal(locked.ok, false);
    assert.deepEqual(
      locked.steps.map((s) => [s.step, s.auth, s.status]),
      [
        ["manifest", "dummy", 401],
        ["token", "none", 200],
        ["manifest", "token", 200],
        ["blob", "dummy", 401],
        ["token", "none", 200],
        ["blob", "token", 307],
      ],
    );
    assert.equal(locked.failed_at, "blob");
    assert.equal(locked.error, "the redirect's Location is http, not https");
    assert.equal(locked.subrequests, 6);
    assert.ok(
      seen.every((s) => !s.url.startsWith("http:")),
      "the http Location is never fetched",
    );
    const token = new URL(seen[1]?.url ?? "");
    assert.equal(token.searchParams.get("scope"), `repository:${LOCKED}:pull`);
    assert.equal(seen[2]?.authorization, PULL);

    const before = seen.length;
    for (const query of [`repo=pkgforge-dev/mirror-archlinux/x86_64/core&tag=latest`, `tag=${TAG}&length=1048577`, `tag=${TAG}&cache=yes`]) {
      const res = await w.fetch(`/range?${query}`);
      assert.equal(res.status, 400, query);
      await res.text();
    }
    assert.equal(seen.length, before, "a refused query makes no subrequest");
    const missing = (await (await w.fetch("/range?tag=no-such-tag")).json()) as Answer;
    assert.deepEqual([missing.ok, missing.status, missing.failed_at], [false, 404, "manifest"]);
    assert.equal((await w.fetch("/gaps")).status, 404);
  });
});
