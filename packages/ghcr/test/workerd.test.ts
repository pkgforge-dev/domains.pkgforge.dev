// packages/ghcr in workerd (Miniflare, through @domains/testkit), under the
// harness's compatibility date and flags (no nodejs_compat): the reader's
// production dial, the global fetch, is proven there, not assumed. Every fetch
// the Worker makes reaches the `outbound` stand-in below, which answers as GHCR,
// its token endpoint and the blob host do; nothing reaches the network. The
// repository, token, tags and bytes are synthetic.
//
//   node scripts/test.mjs packages/ghcr --name workerd
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { type Outbound, withWorker } from "@domains/testkit";

const WORKER = join(import.meta.dirname, "ghcr-worker.ts");
const REPO = "pkgforge-dev/domains.pkgforge.dev/ref";
const V2 = `https://ghcr.io/v2/${REPO}`;
const BLOB = `sha256:${"b".repeat(64)}`;
const SIGNED = `https://pkg-containers.githubusercontent.com/ghcrblobs10/blobs/${BLOB}?se=2026-10-29T00%3A45%3A00Z&sig=s&sp=r`;
const MANIFEST = JSON.stringify({
  schemaVersion: 2,
  mediaType: "application/vnd.oci.image.manifest.v1+json",
  artifactType: "application/vnd.pkgforge.domains.ref.v1",
  config: { mediaType: "application/vnd.oci.empty.v1+json", digest: `sha256:${"4".repeat(64)}`, size: 2 },
  layers: [{ mediaType: "text/plain", digest: BLOB, size: 65536, annotations: { "org.opencontainers.image.title": "public_suffix_list.dat" } }],
});
const DIGEST = `sha256:${createHash("sha256").update(MANIFEST).digest("hex")}`;
const TAGS = Array.from({ length: 1500 }, (_, i) => `t-${String(i).padStart(4, "0")}`);
const byte = (i: number) => i % 251;

interface Seen {
  url: string;
  authorization: string | null;
  userAgent: string | null;
  range: string | null;
}

// A stand-in that refuses the dummy token with a 401 and a Bearer challenge, as
// mirror-archlinux documents a private repository answers (READ
// mirror@669ac72:docs/worker.md, "GHCR tokens", and docs/research/reference/ghcr.ts),
// so the token flow runs in workerd; a pull token reads it. GHCR itself accepts
// the dummy token for a public package (docs/architecture.md section 4.3).
function registry(seen: Seen[]): Outbound {
  return (request) => {
    const url = request.url;
    const authorization = request.headers.get("authorization");
    seen.push({ url, authorization, userAgent: request.headers.get("user-agent"), range: request.headers.get("range") });
    const u = new URL(url);
    if (u.origin === "https://ghcr.io" && u.pathname === "/token") return Response.json({ token: "tok-w" });
    if (url.startsWith(V2)) {
      if (authorization !== "Bearer tok-w") {
        return new Response('{"errors":[{"code":"UNAUTHORIZED"}]}', {
          status: 401,
          headers: { "www-authenticate": `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${REPO}:pull"` },
        });
      }
      if (u.pathname.endsWith("/manifests/psl-a")) return new Response(MANIFEST, { headers: { "content-type": "application/vnd.oci.image.manifest.v1+json", "docker-content-digest": DIGEST } });
      if (u.pathname.endsWith(`/blobs/${BLOB}`)) return new Response(null, { status: 307, headers: { location: SIGNED } });
      if (u.pathname.endsWith("/tags/list")) {
        const last = u.searchParams.get("last");
        const n = Number(u.searchParams.get("n"));
        const from = last === null ? 0 : TAGS.indexOf(last) + 1;
        const page = TAGS.slice(from, from + n);
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (from + n < TAGS.length) headers.link = `</v2/${REPO}/tags/list?last=${page.at(-1)}&n=${n}>; rel="next"`;
        return new Response(JSON.stringify({ name: REPO, tags: page }), { headers });
      }
      return new Response('{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', { status: 404 });
    }
    if (url.startsWith("https://pkg-containers.githubusercontent.com/")) {
      const m = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "");
      if (!m) return new Response("no range", { status: 400 });
      const start = Number(m[1]);
      const end = Number(m[2]) + 1;
      return new Response(
        Uint8Array.from({ length: end - start }, (_, i) => byte(start + i)),
        { status: 206, headers: { "content-range": `bytes ${start}-${end - 1}/65536` } },
      );
    }
    return new Response("not GHCR", { status: 599 });
  };
}

test("ghcr workerd: the reader's global-fetch dial runs the token flow, pages the tag list and reads a range through the 307 in workerd", async () => {
  const seen: Seen[] = [];
  await withWorker({ scriptPath: WORKER, outbound: registry(seen) }, async (w) => {
    const q = `repo=${encodeURIComponent(REPO)}`;
    const m = await w.fetch(`/manifest?${q}&ref=psl-a`);
    assert.equal(m.status, 200);
    assert.deepEqual(await m.json(), { digest: DIGEST, artifactType: "application/vnd.pkgforge.domains.ref.v1", layers: 1, requests: 3, tokenRequests: 1 });
    assert.deepEqual(
      seen.map((s) => [new URL(s.url).pathname, s.authorization]),
      [
        [`/v2/${REPO}/manifests/psl-a`, "Bearer QQ=="],
        ["/token", null],
        [`/v2/${REPO}/manifests/psl-a`, "Bearer tok-w"],
      ],
    );
    assert.ok(seen.every((s) => s.userAgent === "domains.pkgforge.dev/test (synthetic, workerd)"));

    const t = await w.fetch(`/tags?${q}`);
    assert.equal(t.status, 200);
    assert.deepEqual(await t.json(), { count: 1500, first: "t-0000", last: "t-1499", pages: 2, truncated: false });

    seen.length = 0;
    const r = await w.fetch(`/range?${q}&digest=${BLOB}&start=1000&end=1032`);
    assert.equal(r.status, 200);
    const body = (await r.json()) as { hex: string; size: number; host: string; unexpected: boolean; se: number; signed: string };
    assert.equal(body.hex, Buffer.from(Uint8Array.from({ length: 32 }, (_, i) => byte(1000 + i))).toString("hex"));
    assert.equal(body.size, 65536);
    assert.equal(body.host, "pkg-containers.githubusercontent.com");
    assert.equal(body.unexpected, false);
    assert.equal(body.se, Date.parse("2026-10-29T00:45:00Z"));
    assert.equal(body.signed, "registry");
    const signed = seen.find((s) => s.url.startsWith("https://pkg-containers."));
    assert.equal(signed?.authorization, null);
    assert.equal(signed?.range, "bytes=1000-1031");

    const missing = await w.fetch(`/manifest?${q}&ref=absent`);
    assert.equal(missing.status, 502);
    assert.equal(((await missing.json()) as { code: string }).code, "missing");
  });
});
