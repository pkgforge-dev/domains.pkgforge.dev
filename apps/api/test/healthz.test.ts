// apps/api/test/healthz.test.ts — GET /healthz (TODO/serve.md DOM-030): the
// root's age, the 6-hour line, the version from BUILD, and the answer when no
// root can be read. The root and every registry answer are synthetic.
//
//   node scripts/test.mjs apps/api --name healthz
import assert from "node:assert/strict";
import { test } from "node:test";
import { T0 } from "@domains/testkit";
import { ROOT_AGE_MAX_S, versionOf } from "../src/health.ts";
import { apiWorld, BUILD, body, iso, plantRoot, rootDoc } from "./helpers.ts";

const REG = "https://ghcr.io/v2/pkgforge-dev/domains.pkgforge.dev";

test("healthz: a root created 1 h ago answers 200 with ok true, the 12 hex version and root_age_s 3600, never stored", async () => {
  let planted = { manifest: "", layer: "", size: 0 };
  await apiWorld(
    async (w, blobs) => {
      planted = await plantRoot(w, blobs, rootDoc({ created: iso(T0 - 3600_000) }));
    },
    async (w) => {
      const res = await w.get("/healthz");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.deepEqual(await body(res), { ok: true, version: BUILD, root_age_s: 3600 });
      assert.equal(res.headers.get("x-domains-root"), planted.manifest);
      assert.equal(res.headers.get("x-domains-cache"), "ghcr");
      assert.equal(res.headers.get("x-domains-body"), "derived");
      assert.equal(res.headers.get("x-domains-degraded"), null);
      assert.equal(w.errors.length, 0, "a 200 logs nothing");
    },
  );
});

test("healthz: a root older than 6 hours answers 503 with ok false; one of exactly 6 hours answers 200", async () => {
  assert.equal(ROOT_AGE_MAX_S, 21_600);
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs, rootDoc({ created: iso(T0 - 21_601_000) }));
    },
    async (w) => {
      const res = await w.get("/healthz");
      assert.equal(res.status, 503);
      assert.deepEqual(await body(res), { ok: false, version: BUILD, root_age_s: 21_601 });
      assert.ok(w.errors.some((e) => /21601 s old, above 21600 s/.test(String(e[0]))));
    },
  );
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs, rootDoc({ created: iso(T0 - 21_600_000) }));
    },
    async (w) => {
      const res = await w.get("/healthz");
      assert.equal(res.status, 200);
      assert.deepEqual(await body(res), { ok: true, version: BUILD, root_age_s: 21_600 });
    },
  );
});

test("healthz: the age grows with the clock while root:latest stays, and a root created in the future reads 0", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs, rootDoc({ created: iso(T0 - 21_590_000) }));
    },
    async (w) => {
      assert.equal(((await body(await w.get("/healthz"))) as { root_age_s: number }).root_age_s, 21_590);
      w.advance(11);
      const res = await w.get("/healthz");
      assert.equal(res.status, 503);
      assert.equal(((await body(res)) as { root_age_s: number }).root_age_s, 21_601);
    },
  );
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs, rootDoc({ created: iso(T0 + 5_000) }));
    },
    async (w) => {
      assert.deepEqual(await body(await w.get("/healthz")), { ok: true, version: BUILD, root_age_s: 0 });
    },
  );
});

test("healthz: no root can be read (GHCR answers 500, nothing kept) answers 503 with ok false and root_age_s null", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
      w.intercept = async (url) => (url.startsWith(`${REG}/`) ? w.response(500, "down", {}, { url }) : undefined);
    },
    async (w) => {
      const res = await w.get("/healthz");
      assert.equal(res.status, 503);
      assert.deepEqual(await body(res), { ok: false, version: BUILD, root_age_s: null });
      assert.equal(res.headers.get("x-domains-root"), null, "no root answered, so no provenance");
      assert.equal(res.headers.get("retry-after"), "30");
      assert.ok(w.errors.some((e) => /no root: GHCR answered 500/.test(String(e[0]))));
    },
  );
});

test("healthz: GHCR holds no root:latest answers 503 with ok false", async () => {
  await apiWorld(
    () => undefined,
    async (w) => {
      const res = await w.get("/healthz");
      assert.equal(res.status, 503);
      assert.deepEqual(await body(res), { ok: false, version: BUILD, root_age_s: null });
    },
  );
});

test("healthz: a BUILD that is not 12 lowercase hex digits gives version null", async () => {
  assert.equal(versionOf("0123456789ab"), "0123456789ab");
  for (const bad of [undefined, "", "0123456789a", "0123456789abc", "0123456789AB", "g123456789ab", 123456789012]) assert.equal(versionOf(bad), null, String(bad));
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      const res = await w.get("/healthz");
      assert.equal(res.status, 200);
      assert.deepEqual(await body(res), { ok: true, version: null, root_age_s: 3600 });
    },
    { env: {} },
  );
});

test("healthz: HEAD answers as GET does, with no body", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      const res = await w.head("/healthz");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(await res.text(), "");
    },
  );
});
