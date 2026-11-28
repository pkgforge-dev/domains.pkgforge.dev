import assert from "node:assert/strict";
import { test } from "node:test";
import { repoOf } from "@domains/ghcr";
import { type ImmutableRange, MAX_BUCKET_BYTES, R2_CAPACITY_BYTES, R2_SLOTS, R2Cache, type R2CacheBucket, r2SlotKey } from "../src/r2cache.ts";

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const rootRef = (n: number): ImmutableRange => ({ kind: "root", repo: repoOf("root"), digest: `sha256:${n.toString(16).padStart(64, "0")}`, start: 0, end: 4 });
const blockRef = (length: number): ImmutableRange => ({ ...rootRef(1), kind: "blk", repo: repoOf("obs"), start: 10, end: 10 + length });
const bytesOf = (value: number) => new Uint8Array(4).fill(value);

interface Stored {
  bytes: Uint8Array<ArrayBuffer>;
  uploaded: Date;
  metadata: Record<string, string>;
}

class RegistryBucket implements R2CacheBucket {
  readonly objects = new Map<string, Stored>();
  readonly gets: string[] = [];
  readonly puts: { key: string; object: Stored }[] = [];
  readonly canceled: string[] = [];
  commitCount = 0;
  beforeGet: (() => Promise<void>) | undefined;
  beforePut: ((n: number) => Promise<void>) | undefined;

  async get(key: string) {
    this.gets.push(key);
    await this.beforeGet?.();
    const object = this.objects.get(key);
    if (object === undefined) return null;
    return {
      key,
      size: object.bytes.byteLength,
      uploaded: object.uploaded,
      customMetadata: { ...object.metadata },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(object.bytes.slice());
        },
        pull(controller) {
          controller.close();
        },
        cancel: () => {
          this.canceled.push(key);
        },
      }),
    };
  }

  async put(key: string, body: ArrayBuffer, options: { customMetadata: Record<string, string> }): Promise<void> {
    const object = { bytes: new Uint8Array(body), uploaded: new Date(NOW), metadata: options.customMetadata };
    this.puts.push({ key, object });
    await this.beforePut?.(this.puts.length - 1);
    this.objects.set(key, object);
    this.commitCount += 1;
    let storedBytes = 0;
    for (const [written, row] of this.objects) {
      const slash = written.lastIndexOf("/");
      const prefix = written.slice(0, slash);
      const digits = written.slice(slash + 1);
      const pool = R2_SLOTS.find((entry) => entry.prefix === prefix);
      assert.ok(pool && pool.kind !== "hot", written);
      assert.match(digits, /^[0-9]{5}$/);
      assert.ok(Number(digits) < pool.slots, written);
      assert.ok(row.bytes.byteLength <= pool.bodyBytes, written);
      storedBytes += row.bytes.byteLength + written.length + JSON.stringify(row.metadata).length;
    }
    assert.ok(storedBytes < MAX_BUCKET_BYTES);
  }
}

function request(bucket: R2CacheBucket, now: () => number = () => NOW, lookupMs?: number) {
  const pending: Promise<unknown>[] = [];
  const logs: string[] = [];
  const cache = new R2Cache({ bucket, now, lookupMs, waitUntil: (p) => pending.push(p), log: (message) => logs.push(message) });
  return { cache, logs, pending, settled: () => Promise.all(pending) };
}

async function collidingRoots(): Promise<[ImmutableRange, ImmutableRange, string]> {
  const slots = new Map<string, ImmutableRange>();
  for (let n = 0; n < 6; n += 1) {
    const ref = rootRef(n);
    const key = await r2SlotKey(ref);
    assert.ok(key);
    const prior = slots.get(key);
    if (prior !== undefined) return [prior, ref, key];
    slots.set(key, ref);
  }
  assert.fail("six root identities must share one of five slots");
}

test("R2 controls the complete slot namespace and admits only exact identity and size classes", async () => {
  assert.equal(
    R2_SLOTS.reduce((count, pool) => count + pool.slots, 0),
    70_887,
  );
  assert.equal(R2_CAPACITY_BYTES, 4_690_312_192);
  assert.ok(R2_CAPACITY_BYTES < 5_000_000_000);
  const bodyClasses = [
    [32_768, /^blk\/s\/\d{5}$/],
    [32_769, /^blk\/m\/\d{5}$/],
    [131_072, /^blk\/m\/\d{5}$/],
    [131_073, /^blk\/l\/\d{5}$/],
    [1_048_576, /^blk\/l\/\d{5}$/],
  ] as const;
  for (const [length, prefix] of bodyClasses) assert.match((await r2SlotKey(blockRef(length))) ?? "", prefix);
  const bad: ImmutableRange[] = [
    blockRef(0),
    blockRef(1_048_577),
    { ...rootRef(1), start: 1 },
    { ...rootRef(1), end: 8_388_609 },
    { ...rootRef(1), digest: "latest" },
    { ...rootRef(1), repo: repoOf("state") },
    { ...blockRef(8), repo: "untrusted/obs" },
    { ...blockRef(8), repo: repoOf("dumps") },
    { ...blockRef(8), start: -1 },
    { ...blockRef(8), end: Number.MAX_SAFE_INTEGER + 1 },
    { ...blockRef(8), kind: "hot" as ImmutableRange["kind"], start: 0 },
  ];
  const bucket = new RegistryBucket();
  const r = request(bucket);
  for (const ref of bad) {
    assert.equal(await r2SlotKey(ref), null);
    assert.equal(await r.cache.get(ref), null);
    r.cache.putVerified(ref, bytesOf(7));
  }
  r.cache.putVerified(rootRef(0), new Uint8Array(5));
  assert.deepEqual([bucket.gets.length, bucket.puts.length, r.pending.length], [0, 0, 0]);

  const index = { ...rootRef(1), kind: "idx", repo: repoOf("names"), end: 1_048_576 } as const;
  assert.match((await r2SlotKey(index)) ?? "", /^idx\/\d{5}$/);
  assert.match((await r2SlotKey({ ...rootRef(1), end: 8_388_608 })) ?? "", /^root\/\d{5}$/);
  assert.equal(await r2SlotKey(rootRef(13)), "root/00000");
  assert.equal(await r2SlotKey({ ...index, end: index.end + 1 }), null);
});

test("R2 last-completed collision overwrites one whole slot and foreign identity cancels as a miss", async () => {
  const [first, second, key] = await collidingRoots();
  const bucket = new RegistryBucket();
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const release = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  bucket.beforePut = async (n) => {
    started[n]?.resolve();
    await release[n]?.promise;
  };
  const a = request(bucket);
  const b = request(bucket);
  a.cache.putVerified(first, bytesOf(1));
  await started[0]?.promise;
  b.cache.putVerified(second, bytesOf(2));
  await started[1]?.promise;
  assert.equal(bucket.objects.size, 0);
  release[1]?.resolve();
  await b.settled();
  assert.deepEqual(await request(bucket).cache.get(second), bytesOf(2));
  release[0]?.resolve();
  await a.settled();
  assert.equal(bucket.objects.size, 1);
  assert.equal(bucket.commitCount, 2);
  assert.deepEqual(await request(bucket).cache.get(first), bytesOf(1));
  assert.equal(await request(bucket).cache.get(second), null);
  assert.deepEqual(bucket.canceled, [key]);
  assert.deepEqual([...a.logs, ...b.logs], []);
});

test("R2 copies exactly the supplied byte view and bounds background puts per request", async () => {
  const bucket = new RegistryBucket();
  const first = rootRef(1);
  const r = request(bucket);
  // Buffer.slice aliases the visible range and can expose a larger backing allocation.
  const input = Buffer.alloc(10, 9).subarray(5, 9);
  r.cache.putVerified(first, input);
  input.fill(3);
  r.cache.putVerified(rootRef(2), bytesOf(2));
  await r.settled();
  assert.equal(r.pending.length, 1);
  assert.equal(bucket.commitCount, 1);
  assert.deepEqual(await request(bucket).cache.get(first), bytesOf(9));
});

test("R2 retries after either reported write failure replace the same key", async () => {
  const [first, second, key] = await collidingRoots();
  for (const landed of [false, true]) {
    const bucket = new RegistryBucket();
    const a = request(bucket);
    a.cache.putVerified(first, bytesOf(1));
    await a.settled();
    const priorPut = bucket.put.bind(bucket);
    bucket.put = async (slot, body, options) => {
      if (landed) await priorPut(slot, body, options);
      throw new Error("lost acknowledgement");
    };
    const failed = request(bucket);
    failed.cache.putVerified(second, bytesOf(2));
    await failed.settled();
    assert.deepEqual(failed.logs, ["R2 root fill failed"]);
    assert.deepEqual(await request(bucket).cache.get(landed ? second : first), bytesOf(landed ? 2 : 1));
    bucket.put = priorPut;
    const retry = request(bucket);
    retry.cache.putVerified(second, bytesOf(2));
    await retry.settled();
    assert.deepEqual([...bucket.objects.keys()], [key]);
    assert.deepEqual(await request(bucket).cache.get(second), bytesOf(2));
  }
});

test("R2 a late put after eviction still commits only its bounded slot", async () => {
  const [first, second, key] = await collidingRoots();
  const bucket = new RegistryBucket();
  const a = request(bucket);
  a.cache.putVerified(first, bytesOf(1));
  await a.settled();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  bucket.beforePut = async () => {
    started.resolve();
    await release.promise;
  };
  const late = request(bucket);
  late.cache.putVerified(second, bytesOf(2));
  await started.promise;
  bucket.objects.delete(key);
  assert.equal(await request(bucket).cache.get(first), null);
  release.resolve();
  await late.settled();
  assert.deepEqual([...bucket.objects.keys()], [key]);
  assert.deepEqual(await request(bucket).cache.get(second), bytesOf(2));
});

test("R2 expired entries, future upload timestamps and wrong object lengths cancel without deleting the slot", async () => {
  const bucket = new RegistryBucket();
  const a = request(bucket);
  const id = { ...blockRef(4), start: 0, end: 4 };
  a.cache.putVerified(id, bytesOf(1));
  await a.settled();
  const saved = bucket.puts[0];
  assert.ok(saved);
  assert.deepEqual(await request(bucket, () => NOW + 14 * DAY_MS - 1).cache.get(id), bytesOf(1));
  assert.equal(await request(bucket, () => NOW + 14 * DAY_MS).cache.get(id), null);
  assert.equal(await request(bucket, () => NOW - 1).cache.get(id), null);
  bucket.objects.set(saved.key, { ...saved.object, bytes: new Uint8Array(5) });
  const wrong = request(bucket);
  assert.equal(await wrong.cache.get(id), null);
  assert.deepEqual(wrong.logs, ["R2 blk read failed: wrong object size"]);
  assert.equal(bucket.objects.size, 1);
  assert.deepEqual(bucket.canceled, [saved.key, saved.key, saved.key]);
});

test("R2 returns a miss when a body is short, larger than its declared size, or throws", async () => {
  const ref = rootRef(1);
  const bucket = new RegistryBucket();
  const w = request(bucket);
  w.cache.putVerified(ref, bytesOf(6));
  await w.settled();
  for (const length of [3, 5]) {
    const fake: R2CacheBucket = {
      put: () => assert.fail("a read must never write"),
      async get(key) {
        const value = await bucket.get(key);
        assert.ok(value);
        await value.body.cancel();
        return {
          ...value,
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(length));
              controller.close();
            },
          }),
        };
      },
    };
    const r = request(fake);
    assert.equal(await r.cache.get(ref), null);
    assert.deepEqual(r.logs, ["R2 root read failed: wrong body length"]);
  }

  bucket.beforeGet = () => Promise.reject(new Error("binding unavailable"));
  const failing = request(bucket);
  assert.equal(await failing.cache.get(ref), null);
  assert.deepEqual(failing.logs, ["R2 root read failed: binding or body read failed"]);
});

test("R2 a late binding GET falls through promptly, occupies one slot, and cancels the late body", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ref = rootRef(1);
  const bucket = new RegistryBucket();
  const warmed = request(bucket);
  warmed.cache.putVerified(ref, bytesOf(4));
  await warmed.settled();
  const entered = Promise.withResolvers<void>();
  const ready = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const get = bucket.get.bind(bucket);
  let gets = 0;
  bucket.get = async (key) => {
    gets += 1;
    if (gets !== 1) return null;
    entered.resolve();
    await ready.promise;
    const value = await get(key);
    assert.ok(value);
    await value.body.cancel();
    return {
      ...value,
      body: new ReadableStream<Uint8Array>({
        cancel() {
          closed.resolve();
        },
      }),
    };
  };
  const r = request(bucket);
  const read = r.cache.get(ref);
  await entered.promise;
  assert.equal(await r.cache.get(rootRef(2)), null);
  t.mock.timers.tick(249);
  assert.deepEqual(r.logs, []);
  t.mock.timers.tick(1);
  assert.deepEqual(r.logs, ["R2 root lookup exceeded 250 ms"]);
  assert.equal(await read, null);
  assert.equal(await r.cache.get(rootRef(2)), null);
  assert.equal(gets, 1, "the timed-out GET keeps its slot until it completes");
  ready.resolve();
  await closed.promise;
  assert.equal(bucket.gets.length, 1);
});

test("R2 checks at most eight eligible lookups per request", async () => {
  const bucket = new RegistryBucket();
  const r = request(bucket);
  for (let i = 0; i < 12; i += 1) assert.equal(await r.cache.get(rootRef(i)), null);
  assert.equal(bucket.gets.length, 8);
});

test("R2 cancels a body that stalls after matching the slot's metadata", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const ref = rootRef(1);
  const bucket = new RegistryBucket();
  const warmed = request(bucket);
  warmed.cache.putVerified(ref, bytesOf(4));
  await warmed.settled();
  const watching = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  const get = bucket.get.bind(bucket);
  bucket.get = async (key) => {
    const value = await get(key);
    assert.ok(value);
    await value.body.cancel();
    const body = new ReadableStream<Uint8Array>(
      {
        pull() {
          watching.resolve();
        },
        cancel() {
          stopped.resolve();
        },
      },
      { highWaterMark: 0 },
    );
    return { ...value, body };
  };
  const r = request(bucket, () => NOW, 50);
  const read = r.cache.get(ref);
  await watching.promise;
  t.mock.timers.tick(50);
  assert.equal(await read, null);
  await stopped.promise;
  assert.deepEqual(r.logs, ["R2 root lookup exceeded 50 ms"]);
});
