// apps/api/test/workerd.test.ts — the Worker of apps/api in workerd (Miniflare,
// through @domains/testkit), from its real entry src/index.ts, against a mock
// GHCR: every outbound fetch is answered by `registry` below, never by the
// network. The registry, the root and the signed URLs are synthetic. It proves
// what the Node tests cannot: that the Worker bundles and runs under its
// compatibility date and flags, that workerd hands the blob's 307 back to the
// reader, and that the real Cache API keeps the `man` entry, which a later
// request reads as a `hit` with no subrequest. The `blob` and `body` entries
// are not read back here: the root the isolate keeps answers before them, and
// the Node tests read them through the testkit's Cache API stub.
//
//   node scripts/test.mjs apps/api --name workerd
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { type Outbound, withWorker } from "@domains/testkit";

const ENTRY = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const REG = "https://ghcr.io/v2/pkgforge-dev/domains.pkgforge.dev/root";
const BLOB_HOST = "https://pkg-containers.githubusercontent.com";
const sha = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

function plant() {
  const root = new TextEncoder().encode(
    JSON.stringify({
      format: "domains.root.v1",
      root_seq: 74,
      as_of: iso(Date.now() - 2 * 3600_000),
      created: iso(Date.now() - 3600_000),
      previous: `sha256:${"9".repeat(64)}`,
      psl: "1f96bae40adfc22ca2474d7c0099bbcfcb25aefd3e2547b5c2147c0dd2e3ebd9",
      psl_live: [],
      corpus_since: {},
      gaps: {},
      through: {},
      counts: {},
      datasets: {},
      withdrawn: [],
    }),
  );
  const layer = sha(root);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: "application/vnd.pkgforge.domains.root.v1",
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: sha("{}"), size: 2 },
    layers: [{ mediaType: "application/json", digest: layer, size: root.byteLength, annotations: { "org.opencontainers.image.title": "root.json" } }],
  });
  return { root, layer, manifest, digest: sha(manifest) };
}

function registry(p: ReturnType<typeof plant>, seen: string[]): Outbound {
  return (request) => {
    seen.push(request.url);
    const url = new URL(request.url);
    if (request.url === `${REG}/manifests/latest`) {
      if (request.headers.get("authorization") !== "Bearer QQ==") return new Response("", { status: 401 });
      return new Response(p.manifest, { status: 200, headers: { "content-type": "application/vnd.oci.image.manifest.v1+json" } });
    }
    if (request.url === `${REG}/blobs/${p.layer}`) {
      const se = iso(Date.now() + 480_000);
      return new Response(null, { status: 307, headers: { location: `${BLOB_HOST}/ghcrblobs10/blobs/${p.layer}?se=${encodeURIComponent(se)}&sig=synthetic&sp=r` } });
    }
    if (url.origin === BLOB_HOST && url.pathname.endsWith(p.layer)) {
      if (request.headers.get("authorization") !== null) return new Response("an Authorization header", { status: 400 });
      const m = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
      if (!m) return new Response("no range", { status: 400 });
      const part = p.root.slice(Number(m[1]), Number(m[2]) + 1);
      return new Response(part, { status: 206, headers: { "content-range": `bytes ${m[1]}-${m[2]}/${p.root.byteLength}`, "content-length": String(part.byteLength) } });
    }
    return new Response("not in the mock registry", { status: 404 });
  };
}

test("workerd: the Worker answers /healthz and /v1/index/latest from its real entry, and the real Cache API keeps the man entry, a hit with no subrequest", async () => {
  const p = plant();
  const seen: string[] = [];
  await withWorker({ scriptPath: ENTRY, bindings: { BUILD: "0123456789ab" }, outbound: registry(p, seen) }, async (w) => {
    const health = await w.fetch("/healthz");
    assert.equal(health.status, 200, await health.clone().text());
    const h = (await health.json()) as { ok: boolean; version: string; root_age_s: number };
    assert.equal(h.ok, true);
    assert.equal(h.version, "0123456789ab");
    assert.ok(h.root_age_s >= 3599 && h.root_age_s <= 3700, `root_age_s ${h.root_age_s}`);
    assert.equal(health.headers.get("access-control-allow-origin"), "*");
    assert.equal(health.headers.get("x-domains-root"), p.digest);
    // The manifest GET, the blob 307 and the range read of the signed URL.
    assert.deepEqual(seen, [`${REG}/manifests/latest`, `${REG}/blobs/${p.layer}`, seen[2]]);
    assert.ok(seen[2]?.startsWith(`${BLOB_HOST}/`));

    const latest = await w.fetch("/v1/index/latest");
    assert.equal(latest.status, 200);
    const l = (await latest.json()) as { data: { root: string; root_seq: number; references: { root_digest: string } } };
    assert.equal(l.data.root, p.digest);
    assert.equal(l.data.root_seq, 74);
    assert.equal(l.data.references.root_digest, `ghcr.io/pkgforge-dev/domains.pkgforge.dev/root@${p.digest}`);
    assert.equal(latest.headers.get("x-domains-root"), l.data.root);

    // The man entry is written after the answer: wait for a request that reads it.
    let cache: string | null = null;
    let before = 0;
    for (let i = 0; i < 20 && cache !== "hit"; i += 1) {
      before = seen.length;
      const again = await w.fetch("/v1/index/latest");
      assert.equal(again.status, 200);
      cache = again.headers.get("x-domains-cache");
      await again.arrayBuffer();
    }
    assert.equal(cache, "hit");
    assert.equal(seen.length, before, "a hit makes no subrequest");
  });
});

test("workerd: a 404, a 405, an OPTIONS and a HEAD answer in workerd as in Node", async () => {
  const p = plant();
  await withWorker({ scriptPath: ENTRY, outbound: registry(p, []) }, async (w) => {
    const missing = await w.fetch("/nothing");
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get("content-type"), "application/problem+json");
    assert.equal(((await missing.json()) as { see: string }).see, "/llms-full.txt#reason-not-found");
    const post = await w.fetch("/healthz", { method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD, OPTIONS");
    await post.arrayBuffer();
    const options = await w.fetch("/healthz", { method: "OPTIONS" });
    assert.equal(options.status, 204);
    assert.equal(options.headers.get("access-control-allow-origin"), "*");
    const head = await w.fetch("/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), "");
    const health = await w.fetch("/healthz");
    assert.equal(((await health.json()) as { version: unknown }).version, null, "no BUILD binding");
  });
});
