// packages/ghcr/src/reader.ts: the time a request has, on node:test's mock
// clock. A head that never comes ends at exactly the dial's time, a body that
// never comes ends at exactly that time after the head, and the head's timer
// ends with the head, so a head and a body each have the whole time. The
// fetchers and bodies are synthetic; no test reaches the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { dialer, GhcrError, ghcrReader, readCapped, send } from "../src/reader.ts";

const UA = "domains.pkgforge.dev/test (synthetic)";
const URL_ = "https://ghcr.io/v2/pkgforge-dev/domains.pkgforge.dev/ref/manifests/a";
const T = 10_000;
const REPO = "pkgforge-dev/domains.pkgforge.dev/ref";

// setImmediate is not mocked: it lets every promise that can settle, settle.
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
// Two turns: a read that ends at the time has settled by then. A test reads the
// state before it awaits, so a timer that never fires fails it at once.
const settle = async (): Promise<void> => {
  await flush();
  await flush();
};

// A fetcher whose answer never comes; it fails when its signal aborts, as fetch does.
const hang = (_url: string, init: RequestInit): Promise<Response> =>
  new Promise((_, fail) => {
    init.signal?.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });

// A body that sends its bytes `afterMs` after it is first read, and breaks off
// when `signal` aborts, as a fetch body does.
function slowBody(signal: AbortSignal | null | undefined, afterMs: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>(
    {
      start(c) {
        signal?.addEventListener("abort", () => {
          try {
            c.error(new Error("aborted"));
          } catch {
            // Closed already.
          }
        });
      },
      pull(c) {
        return new Promise<void>((resolve) => {
          setTimeout(() => {
            try {
              c.enqueue(new Uint8Array([1, 2, 3]));
              c.close();
            } catch {
              // Broken off already.
            }
            resolve();
          }, afterMs);
        });
      },
    },
    { highWaterMark: 0 },
  );
}

// Whether a promise has settled, read without awaiting it.
function track(p: Promise<unknown>): { settled: () => boolean } {
  let done = false;
  p.then(
    () => {
      done = true;
    },
    () => {
      done = true;
    },
  );
  return { settled: () => done };
}

test("timer: a head that never comes ends at exactly the dial's time, not before and not later", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const d = dialer({ userAgent: UA, fetcher: hang, timeoutMs: T });
  const p = send(d, URL_, null);
  const state = track(p);
  await flush();
  t.mock.timers.tick(T - 1);
  await flush();
  assert.equal(state.settled(), false, "still waiting 1 ms before the time");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(state.settled(), true, "ended at the time");
  await assert.rejects(p, (e: unknown) => e instanceof GhcrError && e.code === "timeout" && /did not answer within 10 s/.test(e.message));
});

test("timer: a body that never comes ends at exactly the time after it is read, not before and not later", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const res = new Response(slowBody(null, 10 * T));
  const p = readCapped(res, 64, T);
  const state = track(p);
  await flush();
  t.mock.timers.tick(T - 1);
  await flush();
  assert.equal(state.settled(), false, "still waiting 1 ms before the time");
  t.mock.timers.tick(1);
  await settle();
  assert.equal(state.settled(), true, "ended at the time");
  await assert.rejects(p, (e: unknown) => e instanceof GhcrError && e.code === "timeout" && /a body did not arrive within 10 s/.test(e.message));
});

test("timer: a head and a body each have the whole time: a head at 0.9 of it and a body 0.9 of it later are read", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const late = 0.9 * T;
  const fetcher = (_url: string, init: RequestInit): Promise<Response> =>
    new Promise((resolve) => {
      setTimeout(() => resolve(new Response(slowBody(init.signal, late))), late);
    });
  const d = dialer({ userAgent: UA, fetcher, timeoutMs: T });
  const head = send(d, URL_, null);
  await flush();
  t.mock.timers.tick(late);
  const res = await head;
  assert.equal(res.status, 200);
  const bytes = readCapped(res, 64, T);
  await flush();
  // The head's timer, had it outlived the head, would abort the body here.
  t.mock.timers.tick(late);
  const state = track(bytes);
  await settle();
  assert.equal(state.settled(), true, "the body arrived");
  assert.deepEqual(await bytes, new Uint8Array([1, 2, 3]));
});

test("timer: a reader's manifest body and range body that never come end at the reader's own time, not the 30 s default", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const stalled =
    (status: number, headers: Record<string, string>) =>
    (_url: string, init: RequestInit): Promise<Response> =>
      Promise.resolve(new Response(slowBody(init.signal, 10 * T), { status, headers }));
  const reads: [string, (g: ReturnType<typeof ghcrReader>) => Promise<unknown>, ReturnType<typeof stalled>][] = [
    ["manifest", (g) => g.getManifest(REPO, "a"), stalled(200, { "content-type": "application/vnd.oci.image.manifest.v1+json" })],
    ["range", (g) => g.readRange(REPO, `sha256:${"1".repeat(64)}`, 0, 3), stalled(206, { "content-range": "bytes 0-2/3", "content-length": "3" })],
  ];
  for (const [label, read, fetcher] of reads) {
    const g = ghcrReader({ userAgent: UA, fetcher, timeoutMs: T });
    const p = read(g);
    const state = track(p);
    await flush();
    t.mock.timers.tick(T - 1);
    await flush();
    assert.equal(state.settled(), false, `${label}: still waiting 1 ms before the time`);
    t.mock.timers.tick(1);
    await settle();
    assert.equal(state.settled(), true, `${label}: ended at the time`);
    await assert.rejects(p, (e: unknown) => e instanceof GhcrError && e.code === "timeout" && /within 10 s/.test(e.message), label);
  }
});
