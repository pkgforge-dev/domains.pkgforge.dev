// apps/api/test/ghcr.test.ts — the Worker's GHCR reads (TODO/serve.md DOM-030,
// the Tests line): the dummy token, the token flow, the realm and size checks,
// and the Cache API entries with their times to live, through GET
// /v1/index/latest in the testkit's world. Every registry answer is synthetic.
//
//   node scripts/test.mjs apps/api --name ghcr
import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOB_HOST, type World } from "@domains/testkit";
import { entryOf, TTL_S } from "../src/cache.ts";
import { USER_AGENT } from "../src/ghcr.ts";
import { resetRoot } from "../src/root.ts";
import { apiWorld, body, ghcrRequests, header, plantRoot, rootDoc, sha256 } from "./helpers.ts";

const REG = "https://ghcr.io/v2/pkgforge-dev/domains.pkgforge.dev";
const YEAR_S = 31_536_000;

test("ghcr: the dummy token is accepted: one manifest GET, one blob 307 and one range read, Bearer QQ== to GHCR and no Authorization to the blob host", async () => {
  let planted = { manifest: "", layer: "", size: 0 };
  await apiWorld(
    async (w, blobs) => {
      planted = await plantRoot(w, blobs);
    },
    async (w) => {
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 200);
      assert.equal(((await body(res)) as { data: { root: string } }).data.root, planted.manifest);
      const ghcr = ghcrRequests(w);
      assert.deepEqual(
        ghcr.map((r) => r.url),
        [`${REG}/root/manifests/latest`, `${REG}/root/blobs/${planted.layer}`],
      );
      for (const r of ghcr) {
        assert.equal(header(r.init, "authorization"), "Bearer QQ==");
        assert.equal(header(r.init, "user-agent"), USER_AGENT);
        assert.equal(r.init.redirect, "manual");
      }
      assert.equal(
        header(ghcr[0]!.init, "accept"),
        "application/vnd.oci.image.manifest.v1+json, application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.artifact.manifest.v1+json",
      );
      const signed = w.requests.filter((r) => r.url.startsWith(`${BLOB_HOST}/`));
      assert.equal(signed.length, 1);
      assert.equal(header(signed[0]!.init, "authorization"), null);
      assert.equal(header(signed[0]!.init, "range"), `bytes=0-${planted.size - 1}`);
      assert.equal(header(signed[0]!.init, "user-agent"), USER_AGENT);
    },
  );
});

test("ghcr: a 403 to the dummy token runs the token flow once, and the next request of the isolate sends the kept token", async () => {
  const tokenUrls: string[] = [];
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
      w.intercept = ((blobIntercept) => async (url: string, init: RequestInit) => {
        const auth = header(init, "authorization");
        if (url.startsWith("https://ghcr.io/token")) {
          tokenUrls.push(url);
          return w.response(200, JSON.stringify({ token: "synthetic-pull-token", expires_in: 300 }), { "content-type": "application/json" }, { url });
        }
        if (url.startsWith(`${REG}/`) && auth === "Bearer QQ==") return w.response(403, '{"errors":[{"code":"DENIED"}]}', {}, { url });
        if (url.startsWith(`${REG}/`) && auth === null) return w.response(401, "", { "www-authenticate": 'Bearer realm="https://ghcr.io/token",service="ghcr.io"' }, { url });
        return blobIntercept?.(url, init);
      })(w.intercept);
    },
    async (w) => {
      const first = await w.get("/v1/index/latest");
      assert.equal(first.status, 200, await first.clone().text());
      assert.equal(tokenUrls.length, 1);
      const u = new URL(tokenUrls[0]!);
      assert.equal(u.searchParams.get("service"), "ghcr.io");
      assert.equal(u.searchParams.get("scope"), "repository:pkgforge-dev/domains.pkgforge.dev/root:pull");
      // The man entry answers the next 30 s; past it, the manifest GET sends the kept token.
      w.advance(31);
      const from = w.requests.length;
      const second = await w.get("/v1/index/latest");
      assert.equal(second.status, 200);
      assert.equal(tokenUrls.length, 1);
      const manifestGets = ghcrRequests(w, from).filter((r) => r.url.endsWith("/manifests/latest"));
      assert.equal(manifestGets.length, 1);
      assert.equal(header(manifestGets[0]!.init, "authorization"), "Bearer synthetic-pull-token");
    },
  );
});

test("ghcr: a Bearer realm outside ghcr.io gives 502 source-unavailable, and no request goes to that realm", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
      w.intercept = async (url) => {
        if (url.startsWith("https://evil.example/")) throw new Error(`the Worker asked the realm ${url}`);
        if (url.startsWith(`${REG}/`)) return w.response(401, "", { "www-authenticate": 'Bearer realm="https://evil.example/token",service="ghcr.io"' }, { url });
        return undefined;
      };
    },
    async (w) => {
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 502);
      assert.equal(res.headers.get("content-type"), "application/problem+json");
      const p = await body(res);
      assert.equal(p.reason, "source-unavailable");
      assert.match(String(p.detail), /realm that is not https:\/\/ghcr\.io\/token/);
      assert.equal(res.headers.get("retry-after"), "30");
      assert.equal(
        w.requests.some((r) => r.url.includes("evil.example")),
        false,
      );
      assert.equal(w.errors.length > 0, true, "a 5xx is logged");
    },
  );
});

test("ghcr: a root manifest over 64 KiB gives 502 source-unavailable, and the Worker keeps nothing of it", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs, rootDoc(), { artifactType: "application/vnd.pkgforge.domains.root.v1", annotations: { pad: "x".repeat(70_000) } });
    },
    async (w) => {
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 502);
      const p = await body(res);
      assert.equal(p.reason, "source-unavailable");
      assert.match(String(p.detail), /over 65536 bytes/);
      assert.equal(w.cache.ofKind("man").length, 0);
    },
  );
});

test("ghcr: root:latest is kept 30 s in the man entry: a request within 30 s makes no GHCR request, and one after 31 s reads GHCR again", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      assert.equal((await w.get("/v1/index/latest")).status, 200);
      const man = w.cache.ofKind("man");
      assert.equal(man.length, 1);
      assert.equal(man[0]!.ttl, 30);
      assert.equal(decodeURIComponent(new URL(man[0]!.url).pathname), "/__cache/v1/man/pkgforge-dev/domains.pkgforge.dev/root@latest");
      w.advance(29);
      let from = w.requests.length;
      const warm = await w.get("/v1/index/latest");
      assert.equal(warm.status, 200);
      assert.equal(warm.headers.get("x-domains-cache"), "hit");
      assert.equal(w.since(from).length, 0, "no subrequest within 30 s");
      w.advance(2);
      from = w.requests.length;
      const again = await w.get("/v1/index/latest");
      assert.equal(again.status, 200);
      // The manifest is read again; root.json is the kept root's, read by no request.
      assert.deepEqual(
        ghcrRequests(w, from).map((r) => r.url),
        [`${REG}/root/manifests/latest`],
      );
      assert.equal(again.headers.get("x-domains-cache"), "ghcr");
    },
  );
});

test("ghcr: a read by digest is kept 1 year: the body entry of root.json, and a manifest by digest", async () => {
  let planted = { manifest: "", layer: "", size: 0 };
  await apiWorld(
    async (w, blobs) => {
      planted = await plantRoot(w, blobs);
    },
    async (w) => {
      assert.equal((await w.get("/v1/index/latest")).status, 200);
      const bodies = w.cache.ofKind("body");
      assert.equal(bodies.length, 1);
      assert.equal(bodies[0]!.ttl, YEAR_S);
      assert.equal(decodeURIComponent(new URL(bodies[0]!.url).pathname), `/__cache/v1/body/pkgforge-dev/domains.pkgforge.dev/root@${planted.layer}/0-${planted.size}`);
    },
  );
  const byDigest = entryOf(`ghcr:m:pkgforge-dev/domains.pkgforge.dev/names@sha256:${"a".repeat(64)}`, 86_400);
  assert.deepEqual(byDigest, { kind: "man", name: `pkgforge-dev/domains.pkgforge.dev/names@sha256:${"a".repeat(64)}`, ttl: YEAR_S });
  assert.equal(entryOf("ghcr:m:pkgforge-dev/domains.pkgforge.dev/root@latest", 60)?.ttl, 30);
  assert.equal(entryOf("ghcr:m:pkgforge-dev/domains.pkgforge.dev/names@names-d-20261026", 60)?.ttl, 30);
  assert.equal(entryOf("ghcr:x:anything", 60), null);
});

test("ghcr: a signed URL is kept until its se less 120 s, and at most 600 s", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
      w.seAfter = 400;
    },
    async (w) => {
      assert.equal((await w.get("/v1/index/latest")).status, 200);
      const blob = w.cache.ofKind("blob");
      assert.equal(blob.length, 1);
      assert.equal(blob[0]!.ttl, 400 - 120);
    },
  );
  // The reader's own time to live is min(se - now, 900 s) - 60 s.
  assert.equal(entryOf("ghcr:u:r@d", 400 - 60)?.ttl, 280);
  assert.equal(entryOf("ghcr:u:r@d", 900 - 60)?.ttl, 600);
  assert.equal(TTL_S.signedMax, 600);
  assert.equal(entryOf("ghcr:u:r@d", 100 - 60)?.ttl, -20);
});

test("ghcr: a signed URL whose se is less than 121 s ahead is not kept, and one 121 s ahead is kept 1 s", async () => {
  for (const seAfter of [100, 120]) {
    await apiWorld(
      async (w, blobs) => {
        await plantRoot(w, blobs);
        w.seAfter = seAfter;
      },
      async (w) => {
        assert.equal((await w.get("/v1/index/latest")).status, 200);
        assert.equal(w.cache.ofKind("blob").length, 0, `se ${seAfter} s ahead`);
        assert.equal(
          w.cache.puts.some((p) => p.url.includes("/__cache/v1/blob/")),
          false,
        );
        assert.equal(w.errors.length, 0, "a URL too short-lived to keep is no cache failure");
      },
    );
  }
  // The edge: the reader gives floor(se - now - 60) = 61 s, and the entry keeps that less 60 s.
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
      w.seAfter = 121;
    },
    async (w) => {
      assert.equal((await w.get("/v1/index/latest")).status, 200);
      const blob = w.cache.ofKind("blob");
      assert.equal(blob.length, 1);
      assert.equal(blob[0]!.ttl, 1);
    },
  );
});

test("ghcr: a body entry whose bytes do not hash to the digest is a miss: logged, and the blob is read again", async () => {
  let planted = { manifest: "", layer: "", size: 0 };
  await apiWorld(
    async (w, blobs) => {
      planted = await plantRoot(w, blobs);
    },
    async (w) => {
      assert.equal((await w.get("/v1/index/latest")).status, 200);
      const key = w.cache.ofKind("body")[0]!.url;
      const entry = w.cache.entries.get(key)!;
      const bad = new Uint8Array(entry.bytes);
      bad[0] = bad[0]! ^ 1;
      w.cache.entries.set(key, { ...entry, bytes: bad });
      // A new isolate, and a manifest past its 30 s, read the root again.
      resetRoot();
      w.advance(31);
      const from = w.requests.length;
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 200);
      // The signed URL is still kept, so the bytes come from the blob host again.
      const read = w.since(from).filter((r) => r.url.startsWith(`${BLOB_HOST}/`));
      assert.equal(read.length, 1);
      assert.ok(read[0]!.url.includes(planted.layer));
      assert.ok(w.errors.some((e) => /do not hash to the digest/.test(String(e[0]))));
    },
  );
});

test("ghcr: root.json whose bytes do not hash to its layer digest gives 502, and nothing is kept", async () => {
  await apiWorld(
    async (w, blobs) => {
      const planted = await plantRoot(w, blobs);
      const bytes = blobs.get(planted.layer)!.slice();
      bytes[bytes.length - 2] = 0x20;
      blobs.set(planted.layer, bytes);
    },
    async (w) => {
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 502);
      assert.match(String((await body(res)).detail), /hashes to sha256:/);
      assert.equal(w.cache.ofKind("body").length, 0);
    },
  );
});

test("ghcr: GHCR holds no root:latest: /v1/index/latest answers 503 no-root", async () => {
  await apiWorld(
    () => undefined,
    async (w) => {
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 503);
      const p = await body(res);
      assert.equal(p.reason, "no-root");
      assert.equal(p.see, "/llms-full.txt#reason-no-root");
      assert.equal(res.headers.get("retry-after"), "30");
    },
  );
});

test("ghcr: GHCR down with a root kept in the isolate answers that root, degraded, and names no tier, since no read of the request served it", async () => {
  let planted = { manifest: "", layer: "", size: 0 };
  await apiWorld(
    async (w, blobs) => {
      planted = await plantRoot(w, blobs);
    },
    async (w) => {
      assert.equal((await w.get("/v1/index/latest")).headers.get("x-domains-cache"), "ghcr");
      // The kept root's last manifest read was a hit, then GHCR fails, then again after a ghcr read.
      assert.equal((await w.get("/v1/index/latest")).headers.get("x-domains-cache"), "hit");
      w.advance(31);
      const blobIntercept = w.intercept;
      w.intercept = async (url, init) => (url.startsWith(`${REG}/`) ? w.response(500, "down", {}, { url }) : blobIntercept?.(url, init));
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-domains-degraded"), "1");
      assert.equal(res.headers.get("x-domains-root"), planted.manifest);
      assert.equal(res.headers.get("x-domains-cache"), null, "a stale answer claims no tier");
      assert.equal(res.headers.get("x-domains-tiers-read"), "0");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.ok(w.errors.some((e) => /answering from the kept root .* GHCR answered 500/.test(String(e[0]))));
      const health = await w.get("/healthz");
      assert.equal(health.status, 200);
      assert.equal(health.headers.get("x-domains-degraded"), "1");
      assert.equal(health.headers.get("x-domains-cache"), null);
    },
  );
});

test("ghcr: a new root:latest that the Worker refuses, with a root kept, answers the kept root degraded with no tier, though its request read the new manifest from GHCR", async () => {
  let first = { manifest: "", layer: "", size: 0 };
  await apiWorld(
    async (w, blobs) => {
      first = await plantRoot(w, blobs);
    },
    async (w, blobs) => {
      assert.equal((await w.get("/v1/index/latest")).status, 200);
      await plantRoot(w, blobs, rootDoc({ format: "domains.root.v2" }));
      w.advance(31);
      const from = w.requests.length;
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-domains-root"), first.manifest);
      assert.equal(res.headers.get("x-domains-degraded"), "1");
      assert.equal(res.headers.get("x-domains-cache"), null);
      assert.ok(ghcrRequests(w, from).length >= 2, "the new manifest and its root.json were read from GHCR");
    },
  );
});

test("ghcr: a blob redirect to a Location that is not https, or to a host off *.githubusercontent.com, and a range answer of other bytes, give 502", async () => {
  for (const [label, plant, detail] of [
    [
      "http Location",
      (w: World, layer: string) => {
        w.blobs.set(`root@${layer}`, `http://pkg-containers.githubusercontent.com/ghcrblobs10/blobs/${layer}?se=2026-10-27T03%3A06%3A40Z&sig=x`);
      },
      /not https/,
    ],
    [
      "foreign host",
      (w: World, layer: string) => {
        w.blobs.set(`root@${layer}`, `https://evil.example/blobs/${layer}?se=2026-10-27T03%3A06%3A40Z&sig=x`);
      },
      /evil\.example/,
    ],
    [
      "wrong Content-Range",
      (w: World) => {
        const blobIntercept = w.intercept;
        w.intercept = async (url, init) => {
          const res = await blobIntercept?.(url, init);
          if (res === undefined || res.status !== 206) return res;
          const bytes = new Uint8Array(await res.arrayBuffer());
          return w.response(206, bytes, { "content-range": `bytes 1-${bytes.byteLength}/${bytes.byteLength + 1}`, "content-length": String(bytes.byteLength) }, { url });
        };
      },
      /Content-Range is/,
    ],
  ] as const) {
    await apiWorld(
      async (w, blobs) => {
        const p = await plantRoot(w, blobs);
        plant(w, p.layer);
      },
      async (w) => {
        const res = await w.get("/v1/index/latest");
        assert.equal(res.status, 502, label);
        const p = await body(res);
        assert.equal(p.reason, "source-unavailable", label);
        assert.match(String(p.detail), detail, label);
        assert.equal(
          w.requests.some((r) => r.url.startsWith("https://evil.example") || r.url.startsWith("http://")),
          false,
          label,
        );
        assert.equal(w.cache.ofKind("body").length, 0, label);
      },
    );
  }
});

test("ghcr: a cache that fails is a miss: every read goes to GHCR, and each failure is logged", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
      w.cache.failMatch = true;
      w.cache.failPut = true;
    },
    async (w) => {
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-domains-cache"), "ghcr");
      assert.ok(w.errors.filter((e) => /cache (read|write) of/.test(String(e[0]))).length >= 2);
    },
  );
});

test("ghcr: the root digest the Worker names is the sha256 of the manifest GHCR gave", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      const res = await w.get("/v1/index/latest");
      const manifest = w.manifests.get("root:latest")!;
      assert.equal(res.headers.get("x-domains-root"), await sha256(manifest));
    },
  );
});
