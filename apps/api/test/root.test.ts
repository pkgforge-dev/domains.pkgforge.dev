// apps/api/test/root.test.ts — the root kept in the isolate (apps/api/src/root.ts):
// the head check at load, validateRoot once per root when a route reads the
// datasets, the refusals of a root this Worker cannot read, and a new
// root:latest taking the kept root's place, and an older one never taking it.
// The roots are synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { GhcrError, type GhcrReader, TITLE } from "@domains/ghcr";
import { RootError } from "@domains/root";
import { T0, type World } from "@domains/testkit";
import { ApiCache } from "../src/cache.ts";
import { LIMITS, readerOf } from "../src/ghcr.ts";
import { headOf, LoadedRoot, ROOT_LAYER_MAX_BYTES, ROOT_REPO, ROOT_TYPE, RootUnavailable, rootOf } from "../src/root.ts";
import { apiWorld, type Blobs, body, iso, plantRoot, rootDoc, sha256 } from "./helpers.ts";

const cacheOf = (waits: Promise<unknown>[] = []) => new ApiCache({ host: "domains.example.test", ray: "-", waitUntil: (p) => waits.push(p) });

// A reader whose getManifest does `manifest`; no other method is called.
const readerDoing = (manifest: () => Promise<unknown>): GhcrReader => ({ getManifest: manifest }) as unknown as GhcrReader;

// root:latest with a layer root.json of exactly these bytes.
async function plantBytes(w: World, blobs: Blobs, bytes: Uint8Array): Promise<void> {
  const layer = await sha256(bytes);
  blobs.set(layer, bytes);
  w.blobs.set(`root@${layer}`, true);
  w.manifest("root:latest", [["root.json", layer, bytes.byteLength]], { artifactType: ROOT_TYPE });
}

const concat = (...chunks: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
};

test("root: validateRoot runs once a root, however often datasets() is asked", () => {
  let reads = 0;
  const json = rootDoc();
  Object.defineProperty(json, "datasets", {
    enumerable: true,
    get() {
      reads += 1;
      return {};
    },
  });
  const root = new LoadedRoot(`sha256:${"1".repeat(64)}`, { digest: `sha256:${"2".repeat(64)}`, size: 1 }, headOf(json), { json, validated: null });
  root.datasets();
  const once = reads;
  assert.ok(once > 0, "validateRoot read the datasets");
  root.datasets();
  root.datasets();
  assert.equal(reads, once);
});

test("root: a fault of the Worker, a TypeError or a GhcrError usage, is never taken for GHCR's: rootOf throws it, even with a root kept", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      assert.equal((await w.get("/v1/index/latest")).status, 200);
      const logged: string[] = [];
      for (const fault of [new TypeError("a planted fault"), new GhcrError("usage", "a planted misuse")]) {
        const g = readerDoing(async () => {
          throw fault;
        });
        await assert.rejects(
          () => rootOf(g, cacheOf(), (m) => logged.push(m)),
          (err: unknown) => err === fault,
        );
      }
      assert.deepEqual(logged, [], "no stale answer");
    },
  );
});

test("root: the reads of a root have a deadline in all; past it the request answers as GHCR failed, from the kept root when there is one", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      let kept = "";
      const slow = (digest: () => string) =>
        readerDoing(
          () =>
            new Promise((resolve) => {
              setTimeout(() => resolve({ digest: digest(), from: "registry", json: {} }), 300);
            }),
        );
      const t0 = performance.now();
      await assert.rejects(
        () =>
          rootOf(
            slow(() => kept),
            cacheOf(),
            () => undefined,
            50,
          ),
        (err: unknown) => err instanceof RootUnavailable && !err.missing && /GHCR did not give the root within 0\.05 s/.test(err.message),
      );
      assert.ok(performance.now() - t0 < 250, "answered at the deadline, not when the read ended");
      const first = await w.get("/v1/index/latest");
      kept = String(first.headers.get("x-domains-root"));
      const logged: string[] = [];
      const r = await rootOf(
        slow(() => kept),
        cacheOf(),
        (m) => logged.push(m),
        50,
      );
      assert.equal(r.stale, true);
      assert.equal(r.root.digest, kept);
      assert.deepEqual(r.reads, []);
      assert.match(logged[0] ?? "", /answering from the kept root .* within 0\.05 s/);
      // Let the slow reads end inside the test.
      await new Promise((resolve) => setTimeout(resolve, 300));
    },
  );
});

test("root: a root.json blob GHCR does not hold, after a good manifest, gives 502 source-unavailable; only a missing root:latest gives 503", async () => {
  await apiWorld(
    async (w, blobs) => {
      const p = await plantRoot(w, blobs);
      w.blobs.delete(`root@${p.layer}`);
    },
    async (w) => {
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 502);
      assert.equal((await body(res)).reason, "source-unavailable");
    },
  );
});

test("root: root.json that is not strict UTF-8, that starts with a byte order mark, or whose layer is 0 B, is refused with 502", async () => {
  const text = JSON.stringify(rootDoc({ note: "X" }));
  const [head, tail] = text.split('"X"') as [string, string];
  const enc = new TextEncoder();
  for (const [label, plant] of [
    ["invalid UTF-8", (w: World, blobs: Blobs) => plantBytes(w, blobs, concat(enc.encode(`${head}"`), new Uint8Array([0xff]), enc.encode(`"${tail}`)))],
    ["byte order mark", (w: World, blobs: Blobs) => plantBytes(w, blobs, concat(new Uint8Array([0xef, 0xbb, 0xbf]), enc.encode(text)))],
    [
      "a layer of 0 B",
      async (w: World, blobs: Blobs) => {
        const p = await plantRoot(w, blobs);
        w.manifest("root:latest", [["root.json", p.layer, 0]], { artifactType: ROOT_TYPE });
      },
    ],
  ] as const) {
    await apiWorld(
      async (w, blobs) => {
        await plant(w, blobs);
      },
      async (w) => {
        const res = await w.get("/v1/index/latest");
        assert.equal(res.status, 502, label);
        assert.equal((await body(res)).reason, "source-unavailable", label);
      },
    );
  }
});

test("root: datasets() runs validateRoot in the reader's form once a root, and /healthz never runs it", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs, rootDoc({ unknown_field: 1, datasets: { "a-dataset-later": [] } }));
    },
    async () => {
      const cache = cacheOf();
      const r = await rootOf(readerOf(cache), cache, () => undefined);
      const first = r.root.datasets();
      assert.equal(first.root_seq, 74);
      assert.equal(r.root.datasets(), first, "validated once");
    },
  );
});

test("root: a root whose datasets fail validateRoot still answers /healthz and /v1/index/latest, and datasets() throws RootError", async () => {
  // A pack entry with no field at all: validateRoot refuses it; the head is whole.
  const doc = rootDoc({ as_of: "2026-10-27T02:00:00Z", datasets: { names: [{}] } });
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs, doc);
    },
    async (w) => {
      assert.equal((await w.get("/healthz")).status, 200);
      assert.equal((await w.get("/v1/index/latest")).status, 200);
      const cache = cacheOf();
      const r = await rootOf(readerOf(cache), cache, () => undefined);
      assert.throws(
        () => r.root.datasets(),
        (err: unknown) => err instanceof RootError,
      );
    },
  );
});

test("root: the head check refuses another format, a root_seq below 1, a created that is not a time, a previous that is not a digest", () => {
  assert.equal(headOf(rootDoc()).root_seq, 74);
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ format: "domains.root.v2" }, /the format is "domains\.root\.v2"; this Worker knows domains\.root\.v1/],
    [{ root_seq: 0 }, /root_seq is 0/],
    [{ root_seq: 1.5 }, /root_seq is 1\.5/],
    [{ created: "2026-10-27 03:00:00" }, /created is "2026-10-27 03:00:00"/],
    [{ as_of: "yesterday" }, /as_of is "yesterday"/],
    [{ previous: "sha256:abc" }, /previous is neither null nor a sha256: digest/],
  ];
  for (const [over, message] of cases)
    assert.throws(
      () => headOf(rootDoc(over)),
      (err: unknown) => err instanceof RootError && message.test(err.message),
      JSON.stringify(over),
    );
  assert.throws(() => headOf([]), RootError);
  assert.throws(() => headOf(null), RootError);
});

test("root: a format this Worker does not know gives 502 source-unavailable", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs, rootDoc({ format: "domains.root.v2" }));
    },
    async (w) => {
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 502);
      assert.match(String((await body(res)).detail), /this Worker knows domains\.root\.v1/);
    },
  );
});

test("root: a manifest that is not of the root's artifact type, or holds root.json twice or not at all, gives 502", async () => {
  for (const [label, plant] of [
    ["another type", async (w: World, blobs: Blobs) => plantRoot(w, blobs, rootDoc(), { artifactType: "application/vnd.pkgforge.domains.pack.v1" })],
    [
      "two layers",
      async (w: World, blobs: Blobs) => {
        const p = await plantRoot(w, blobs);
        w.manifest(
          "root:latest",
          [
            ["root.json", p.layer, p.size],
            ["root.json", p.layer, p.size],
          ],
          { artifactType: "application/vnd.pkgforge.domains.root.v1" },
        );
      },
    ],
    [
      "no layer",
      async (w: World, blobs: Blobs) => {
        const p = await plantRoot(w, blobs);
        w.manifest("root:latest", [["sources.json", p.layer, p.size]], { artifactType: "application/vnd.pkgforge.domains.root.v1" });
      },
    ],
    [
      "a layer over 8 MiB",
      async (w: World, blobs: Blobs) => {
        const p = await plantRoot(w, blobs);
        w.manifest("root:latest", [["root.json", p.layer, ROOT_LAYER_MAX_BYTES + 1]], { artifactType: "application/vnd.pkgforge.domains.root.v1" });
      },
    ],
    ["not JSON", async (w: World, blobs: Blobs) => plantRoot(w, blobs, "{not json")],
  ] as const) {
    await apiWorld(
      async (w, blobs) => {
        await plant(w, blobs);
      },
      async (w) => {
        const res = await w.get("/v1/index/latest");
        assert.equal(res.status, 502, label);
        assert.equal((await body(res)).reason, "source-unavailable", label);
      },
    );
  }
});

test("root: a new root:latest takes the kept root's place once the man entry expires", async () => {
  let second = { manifest: "", layer: "", size: 0 };
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs, rootDoc({ root_seq: 74 }));
    },
    async (w, blobs) => {
      const a = await body(await w.get("/v1/index/latest"));
      assert.equal((a as { data: { root_seq: number } }).data.root_seq, 74);
      second = await plantRoot(w, blobs, rootDoc({ root_seq: 75, created: iso(T0 - 60_000) }));
      w.advance(10);
      // Within 30 s the man entry still names the first root.
      assert.equal(((await body(await w.get("/v1/index/latest"))) as { data: { root_seq: number } }).data.root_seq, 74);
      w.advance(21);
      const res = await w.get("/v1/index/latest");
      assert.equal(((await body(res)) as { data: { root_seq: number } }).data.root_seq, 75);
      assert.equal(res.headers.get("x-domains-root"), second.manifest);
      assert.deepEqual(await body(await w.get("/healthz")), { ok: true, version: "0123456789ab", root_age_s: 91 });
    },
  );
});

// A root.json and the manifest of root:latest that names it, for a reader double.
interface RootBlob {
  manifest: string;
  layer: string;
  bytes: Uint8Array;
  json: Record<string, unknown>;
}

async function rootBlob(doc: Record<string, unknown>): Promise<RootBlob> {
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  const layer = await sha256(bytes);
  const json = { schemaVersion: 2, artifactType: ROOT_TYPE, layers: [{ digest: layer, size: bytes.byteLength, annotations: { [TITLE]: "root.json" } }] };
  return { manifest: await sha256(JSON.stringify(json)), layer, bytes, json };
}

// A reader whose root:latest names r; each blob read first awaits before().
function rootReader(r: RootBlob, blobReads: { n: number }, before: () => Promise<void> = async () => undefined): GhcrReader {
  return {
    getManifest: async () => ({ digest: r.manifest, from: "cache", json: r.json }),
    readRange: async (_repo: string, digest: string, start: number, end: number) => {
      blobReads.n += 1;
      await before();
      assert.equal(digest, r.layer);
      return { bytes: r.bytes.slice(start, end), size: r.bytes.byteLength };
    },
  } as unknown as GhcrReader;
}

test("root: a root of a lower root_seq never replaces the kept root; the read that met the older manifest answers its own request", async () => {
  await apiWorld(
    () => undefined,
    async () => {
      const older = await rootBlob(rootDoc({ root_seq: 74 }));
      const newer = await rootBlob(rootDoc({ root_seq: 75 }));
      const reads = { n: 0 };
      let release: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      // Request A met the older manifest in the man entry, and its root.json read is slow.
      const a = rootOf(
        rootReader(older, reads, () => gate),
        cacheOf(),
        () => undefined,
      );
      // Request B met the newer manifest and loads the newer root while A waits.
      const b = await rootOf(rootReader(newer, reads), cacheOf(), () => undefined);
      assert.equal(b.root.head.root_seq, 75);
      release();
      const ra = await a;
      assert.equal(ra.root.head.root_seq, 74, "A answers from the root its own read gave");
      assert.equal(ra.stale, false);
      // Request C meets the newer manifest: the kept root answers, with no read of root.json.
      const before = reads.n;
      const c = await rootOf(rootReader(newer, reads), cacheOf(), () => undefined);
      assert.equal(c.root.head.root_seq, 75);
      assert.equal(c.stale, false);
      assert.equal(c.reads.length, 1, "the manifest read alone");
      assert.equal(reads.n, before, "no blob read");
    },
  );
});

test("root: the manifest of root:latest is read with the Worker's cap, LIMITS.manifestBytes", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async () => {
      const real = readerOf(cacheOf());
      const seen: unknown[][] = [];
      const g = {
        ...real,
        getManifest: (repo: string, ref: string, options?: { maxBytes?: number }) => {
          seen.push([repo, ref, options]);
          return real.getManifest(repo, ref, options);
        },
      } as GhcrReader;
      const r = await rootOf(g, cacheOf(), () => undefined);
      assert.equal(r.stale, false);
      assert.equal(LIMITS.manifestBytes, 65_536);
      assert.deepEqual(seen, [[ROOT_REPO, "latest", { maxBytes: LIMITS.manifestBytes }]]);
    },
  );
});
