// packages/adapter/node/connect.ts: liveConnect against local servers, one
// per bound. The production default carries an echo; each bound is driven
// with small limits by the server that trips it: a refused port, a silent
// server, a server that trickles a byte every 50 ms, and one past the byte cap.
import assert from "node:assert/strict";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { test } from "node:test";
import { closedPort } from "../../../scripts/measure/fixtures/kafka/broker.mjs";
import { LIVE_CONNECT_LIMITS, liveConnect, SocketError } from "../node/connect.ts";
import type { SocketOptions } from "../src/types.ts";

// A server on 127.0.0.1 whose connections `onConnection` drives.
async function serve(onConnection: (s: Socket) => void): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    // The client ends a connection by destroying it; the reset is expected.
    s.on("error", () => {});
    onConnection(s);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    close: () =>
      new Promise<void>((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => ok());
      }),
  };
}

// Reads until the stream fails: the error and the bytes read before it.
async function readToFailure(readable: ReadableStream<Uint8Array>): Promise<{ error: unknown; bytes: number }> {
  const reader = readable.getReader();
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { error: null, bytes };
      bytes += value.byteLength;
    }
  } catch (error) {
    return { error, bytes };
  }
}

const isSocketError = (e: unknown, code: string): boolean => e instanceof SocketError && e.code === code;
const SMALL = { connectMs: 2_000, idleMs: 5_000, lifeMs: 10_000, maxBytes: 1 << 20 };

test("adapter liveConnect: the production default opens, carries a write and its echo, and close ends the socket", { timeout: 60_000 }, async () => {
  const server = await serve((s) => s.pipe(s));
  try {
    const socket = liveConnect()({ hostname: "127.0.0.1", port: server.port }, { secureTransport: "off" });
    assert.deepEqual(await socket.opened, { remoteAddress: `127.0.0.1:${server.port}` });
    const writer = socket.writable.getWriter();
    const reader = socket.readable.getReader();
    await writer.write(new TextEncoder().encode("ping\n"));
    let got = "";
    while (got !== "ping\n") {
      const { done, value } = await reader.read();
      assert.equal(done, false);
      got += new TextDecoder().decode(value);
    }
    await socket.close();
    await socket.close();
    assert.deepEqual(LIVE_CONNECT_LIMITS, { connectMs: 10_000, idleMs: 60_000, lifeMs: 15 * 60_000, maxBytes: 1024 * 1024 * 1024 });
  } finally {
    await server.close();
  }
});

test("adapter liveConnect: a refused port, a silent server, a trickling server and a server past the byte cap end with SocketError connect, idle, life and bytes", { timeout: 60_000 }, async () => {
  // connect: nothing listens. Windows retries a refused loopback connect for
  // about 2 s, so the 200 ms bound fires there; elsewhere the refusal comes first.
  const port = await closedPort();
  const refused = liveConnect({ ...SMALL, connectMs: 200 })({ hostname: "127.0.0.1", port });
  await assert.rejects(refused.opened, (e: unknown) => isSocketError(e, "connect") && new RegExp(`^connect: 127\\.0\\.0\\.1:${port}: `).test((e as Error).message));
  // The streams fail too, with the bound's SocketError or the refusal itself.
  assert.notEqual((await readToFailure(refused.readable)).error, null);

  // idle: the server accepts and says nothing.
  const silent = await serve(() => {});
  try {
    const socket = liveConnect({ ...SMALL, idleMs: 150 })({ hostname: "127.0.0.1", port: silent.port });
    await socket.opened;
    const { error, bytes } = await readToFailure(socket.readable);
    assert.ok(isSocketError(error, "idle"), String(error));
    assert.equal(bytes, 0);
  } finally {
    await silent.close();
  }

  // life: a byte every 50 ms keeps the socket from idling, and the life bound ends it.
  const trickle = await serve((s) => {
    const t = setInterval(() => s.write("x"), 50);
    s.on("close", () => clearInterval(t));
  });
  try {
    const started = Date.now();
    const socket = liveConnect({ ...SMALL, idleMs: 1_000, lifeMs: 400 })({ hostname: "127.0.0.1", port: trickle.port });
    await socket.opened;
    const { error, bytes } = await readToFailure(socket.readable);
    assert.ok(isSocketError(error, "life"), String(error));
    assert.ok(bytes >= 2, `read ${bytes} bytes before the life bound`);
    assert.ok(Date.now() - started >= 390, "the life bound fires no earlier than lifeMs");
  } finally {
    await trickle.close();
  }

  // bytes: 1 KiB every 5 ms with no end, against a cap of 4,000. The chunk
  // that passes the cap may reach the reader; nothing after it does.
  const flood = await serve((s) => {
    const t = setInterval(() => s.write(Buffer.alloc(1024, 0x61)), 5);
    s.on("close", () => clearInterval(t));
  });
  try {
    const socket = liveConnect({ ...SMALL, maxBytes: 4_000 })({ hostname: "127.0.0.1", port: flood.port });
    await socket.opened;
    const { error, bytes } = await readToFailure(socket.readable);
    assert.ok(isSocketError(error, "bytes"), String(error));
    assert.ok(bytes < 64 << 10, `read ${bytes} bytes past the cap`);
  } finally {
    await flood.close();
  }
});

// The review of DOM-026: the connect timer, the byte cap's edge and the half-open default.
test("adapter liveConnect: the connect bound is cleared once the socket opens, and fires when it never opens", { timeout: 60_000 }, async () => {
  // A first byte at 3 x connectMs is still read: the connect bound ends at open.
  const late = await serve((s) => {
    const t = setTimeout(() => s.write("x"), 600);
    s.on("close", () => clearTimeout(t));
  });
  try {
    const socket = liveConnect({ ...SMALL, connectMs: 200 })({ hostname: "127.0.0.1", port: late.port });
    await socket.opened;
    const { value } = await socket.readable.getReader().read();
    assert.equal(new TextDecoder().decode(value), "x");
    await socket.close();
  } finally {
    await late.close();
  }
  // 192.0.2.1 is TEST-NET-1 (RFC 5737): no host answers it. Where the network
  // drops the packets the bound fires; where it refuses the route at once,
  // the refusal is the SocketError connect.
  const started = Date.now();
  const never = liveConnect({ ...SMALL, connectMs: 300 })({ hostname: "192.0.2.1", port: 81 });
  await assert.rejects(never.opened, (e: unknown) => isSocketError(e, "connect"));
  const took = Date.now() - started;
  assert.ok(took < 5_000, `the connect failed after ${took} ms`);
  await never.close();
});

test("adapter liveConnect: a socket may read exactly maxBytes; a byte past it ends the socket; when the server ends its side, a write fails", { timeout: 60_000 }, async () => {
  let more: (() => void) | null = null;
  const capped = await serve((s) => {
    s.write("12345");
    more = () => s.write("6");
  });
  try {
    const socket = liveConnect({ ...SMALL, maxBytes: 5 })({ hostname: "127.0.0.1", port: capped.port });
    await socket.opened;
    const reader = socket.readable.getReader();
    let got = 0;
    while (got < 5) got += (await reader.read()).value!.byteLength;
    const pending = reader.read();
    const quiet = await Promise.race([
      pending.then(
        () => "read",
        () => "failed",
      ),
      new Promise((ok) => setTimeout(() => ok("pending"), 200)),
    ]);
    assert.equal(quiet, "pending", "exactly maxBytes is no fault");
    more!();
    // The chunk that passes the cap may reach the reader; the read after it fails.
    const after = await pending.then(
      () =>
        reader.read().then(
          () => null,
          (e: unknown) => e,
        ),
      (e: unknown) => e,
    );
    assert.ok(isSocketError(after, "bytes"), String(after));
  } finally {
    await capped.close();
  }
  const ending = await serve((s) => s.end("x"));
  try {
    const socket = liveConnect()({ hostname: "127.0.0.1", port: ending.port });
    await socket.opened;
    const reader = socket.readable.getReader();
    assert.equal((await reader.read()).done, false);
    assert.equal((await reader.read()).done, true);
    // Not half-open by default: the socket ends with the server's side.
    await new Promise((ok) => setTimeout(ok, 50));
    await assert.rejects(socket.writable.getWriter().write(new TextEncoder().encode("late")));
    await socket.close();
  } finally {
    await ending.close();
  }
});

test("adapter liveConnect: TLS is refused, close before the socket opens fails opened as closed, and limits are held to positive integers", { timeout: 60_000 }, async () => {
  assert.throws(
    () => liveConnect()({ hostname: "127.0.0.1", port: 9 }, { secureTransport: "on" } as unknown as SocketOptions),
    (e: unknown) => isSocketError(e, "connect") && /secureTransport "on" is not built/.test((e as Error).message),
  );
  const server = await serve(() => {});
  try {
    const socket = liveConnect()({ hostname: "127.0.0.1", port: server.port });
    await socket.close();
    await assert.rejects(socket.opened, (e: unknown) => isSocketError(e, "closed"));
  } finally {
    await server.close();
  }
  for (const k of ["connectMs", "idleMs", "lifeMs", "maxBytes"] as const)
    for (const v of [0, -1, 1.5, Number.NaN]) assert.throws(() => liveConnect({ ...LIVE_CONNECT_LIMITS, [k]: v }), new RegExp(`${k} .* is not a positive integer`), `${k} ${v}`);
});
