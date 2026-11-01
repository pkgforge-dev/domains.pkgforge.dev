// packages/adapter/src/connect.ts (the TCP recording, replayConnect,
// tapConnect, encodeTcpRecording), its reader readTcpRecordings, and the
// harness's TCP door, on the synthetic line adapter of synthetic.ts. Each
// refusal plants one fault. The tap test runs the adapter against a local
// server through liveConnect, then replays what it recorded.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { liveConnect } from "../node/connect.ts";
import { readTcpRecordings } from "../node/files.ts";
import { encodeTcpRecording, parseTcpRecording, REPLAY_IDLE_MS, replayConnect, TCP_RECORDING_FORMAT, type TcpExchange, type TcpRecording, tapConnect } from "../src/connect.ts";
import { HARNESS_USER_AGENT, replayFetch, runAdapter } from "../src/harness.ts";
import type { AdapterContext, SocketAddress } from "../src/types.ts";
import { ContractError } from "../src/validate.ts";
import { memoryWriter } from "../src/writer.ts";
import { PSL } from "./fixture-psl.ts";
import { TCP_ADDRESS, type TcpPlant, tcpAdapter } from "./synthetic.ts";

const NOW = "2026-10-30T08:35:00Z";
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);
const text = (b: Uint8Array): string => new TextDecoder().decode(b);
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const W0 = "5 a.example.com\n7 b.example.org\nEND\n";
const W1 = "3 c.example.net\nEND\n";
const exchange = (request: string, response: string, note: string | null = null): TcpExchange => ({ note, request: utf8(request), response: utf8(response) });
const LINES_EXCHANGES = [exchange("WINDOW 0\n", W0, "window 0"), exchange("WINDOW 1\n", W1), exchange("WINDOW 2\n", "NONE\n")];
const recording = (name: string, exchanges: TcpExchange[], address: SocketAddress = TCP_ADDRESS): TcpRecording =>
  parseTcpRecording(JSON.parse(encodeTcpRecording({ origin: "synthetic", address, exchanges })), name);
const LINES = recording("lines.tcp.json", LINES_EXCHANGES);

const run = (plant: TcpPlant, tcp: readonly TcpRecording[] = [LINES]) => runAdapter(tcpAdapter(plant), { recordings: [], tcp, psl: PSL, cursor: null, now: NOW });

// Rejects with a ContractError of exactly this check.
async function refuses(p: Promise<unknown>, check: string): Promise<ContractError> {
  let caught: unknown = null;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ContractError, `expected a ContractError ${check}, got ${caught === null ? "no error" : String(caught)}`);
  assert.equal(caught.check, check, caught.message);
  return caught;
}

// The ctx of one run outside the harness, with `connect` as ctx.connect.
const ctxOf = (connect: AdapterContext["connect"], now = NOW) => {
  const writer = memoryWriter();
  return { writer, ctx: Object.freeze({ fetch: replayFetch([]).fetch, connect, psl: PSL, now, userAgent: HARNESS_USER_AGENT, writer }) };
};

// Every chunk of a readable until it is done.
async function drain(readable: ReadableStream<Uint8Array>): Promise<Uint8Array[]> {
  const out: Uint8Array[] = [];
  const reader = readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

test("adapter connect: a recorded exchange answers a write of the same bytes, whole or in chunks", async () => {
  const { first, again, next } = await run("none");
  assert.deepEqual(
    first.result.segments.map((s) => [s.window.start, s.count]),
    [
      ["2026-10-30T08:00:00Z", 2],
      ["2026-10-30T08:10:00Z", 1],
    ],
  );
  assert.deepEqual(first.result.cursor, { window: 2 });
  assert.deepEqual(again.result.segments, first.result.segments);
  assert.deepEqual(next.result.segments, []);
  // One connection a run, each request answered by its exchange, logged with its size and digest.
  assert.deepEqual(first.connections, [
    {
      address: "tcp.example.test:7000",
      opened: true,
      requests: [0, 1, 2].map((i) => ({ bytes: 9, sha256: sha(`WINDOW ${i}\n`), exchange: `lines.tcp.json#${i}` })),
    },
  ]);
  assert.deepEqual(
    next.connections.map((c) => c.requests.map((r) => r.exchange)),
    [["lines.tcp.json#2"]],
  );
  // The same answers cut into chunks of at most 4 bytes: the adapter reads them whole.
  const chunked = replayConnect([LINES], { chunkBytes: 4 });
  const { writer, ctx } = ctxOf(chunked.connect);
  const direct = await tcpAdapter().run(null, ctx);
  assert.deepEqual(direct.segments, first.result.segments);
  assert.deepEqual(
    writer.written.map((w) => w.records),
    first.written.map((w) => w.records),
  );
  const socket = replayConnect([LINES], { chunkBytes: 4 }).connect(TCP_ADDRESS);
  await socket.opened;
  const w = socket.writable.getWriter();
  await w.write(utf8("WINDOW 0\n"));
  await socket.close();
  const chunks = await drain(socket.readable);
  assert.ok(chunks.every((c) => c.byteLength <= 4));
  assert.equal(text(new Uint8Array(chunks.flatMap((c) => [...c]))), W0);
  // A write after close() is refused; the recording is not changed by the adapter's bytes.
  await assert.rejects(w.write(utf8("WINDOW 1\n")), /a write after close\(\)/);
  assert.equal(text(LINES.exchanges[0]!.response), W0);
});

test("adapter connect: a write with no recording fails the run as unrecorded, even when the adapter catches the error", { timeout: 60_000 }, async () => {
  // One request in two writes: the first write's bytes match no request.
  const split = await refuses(run("split-write"), "unrecorded");
  assert.equal(split.message, `unrecorded: run 1: no recording for tcp.example.test:7000: no recording for a request of 3 bytes, sha256 ${sha("WIN")}`);
  const caught = await refuses(run("unrecorded-caught"), "unrecorded");
  assert.match(caught.message, new RegExp(`a request of 6 bytes, sha256 ${sha("HELLO\n")}$`));
  // After a miss the socket answers nothing more: the read and every later write reject alike.
  const replay = replayConnect([LINES]);
  const socket = replay.connect(TCP_ADDRESS);
  const w = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  await assert.rejects(w.write(utf8("HELLO\n")), (e: unknown) => e instanceof ContractError && e.check === "unrecorded");
  await assert.rejects(reader.read(), (e: unknown) => e instanceof ContractError && e.check === "unrecorded");
  await assert.rejects(w.write(utf8("WINDOW 0\n")), (e: unknown) => e instanceof ContractError && e.check === "unrecorded");
  assert.deepEqual(
    replay.connections[0]!.requests.map((r) => r.exchange),
    [null],
  );
  assert.equal(replay.misses.length, 1);
});

test("adapter connect: a recording cut short fails the run as unrecorded after idleMs, and a read that a write answers in time does not", { timeout: 60_000 }, async () => {
  // The answer to WINDOW 0 lost its last lines: the adapter reads on for its END.
  const short = recording("short.tcp.json", [exchange("WINDOW 0\n", "5 a.example.com\n")]);
  const replay = replayConnect([short], { idleMs: 200 });
  const { ctx } = ctxOf(replay.connect);
  const started = Date.now();
  await refuses(tcpAdapter().run(null, ctx), "unrecorded");
  assert.ok(Date.now() - started >= 190, "the bound fires no earlier than idleMs");
  assert.equal(replay.misses.length, 1);
  assert.match(replay.misses[0]!.detail, /^tcp\.example\.test:7000: a read waited 200 ms past every byte recorded, with no write/);
  // The harness's default bound, REPLAY_IDLE_MS, fails the run as unrecorded too.
  const viaHarness = await refuses(run("none", [short]), "unrecorded");
  assert.match(viaHarness.message, new RegExp(`a read waited ${REPLAY_IDLE_MS} ms past every byte recorded`));
  // A read that waits before its write is answered once the write comes within the bound.
  const early = replayConnect([LINES], { idleMs: 500 }).connect(TCP_ADDRESS);
  const reader = early.readable.getReader();
  const pending = reader.read();
  await new Promise((ok) => setTimeout(ok, 100));
  await early.writable.getWriter().write(utf8("WINDOW 0\n"));
  assert.equal(text((await pending).value!), W0);
  await early.close();
  assert.throws(() => replayConnect([LINES], { idleMs: 0 }), /idleMs 0 is not a positive integer/);
});

test("adapter connect: a write that is not a Uint8Array is a TypeError, not a miss, and a write after the readable is cancelled queues nothing", async () => {
  const replay = replayConnect([LINES]);
  const socket = replay.connect(TCP_ADDRESS);
  const w = socket.writable.getWriter();
  await assert.rejects(
    w.write(new ArrayBuffer(9) as unknown as Uint8Array),
    (e: unknown) => e instanceof TypeError && /a write of \[object ArrayBuffer\], not a Uint8Array/.test((e as Error).message),
  );
  assert.deepEqual(replay.misses, []);
  const cancelled = replay.connect(TCP_ADDRESS);
  await cancelled.readable.cancel();
  await cancelled.writable.getWriter().write(utf8("WINDOW 0\n"));
  assert.deepEqual(replay.misses, []);
  assert.deepEqual(
    replay.connections.map((c) => c.requests.map((r) => r.exchange)),
    [[], ["lines.tcp.json#0"]],
  );
});

test("adapter connect: a connect to an unrecorded address, or with TLS, fails as unrecorded", async () => {
  const other = await refuses(run("other-host"), "unrecorded");
  assert.match(other.message, /no recording for connect other\.example\.test:7000: no recording$/);
  const tls = await refuses(run("tls"), "unrecorded");
  assert.match(tls.message, /no recording for connect tcp\.example\.test:7000 with secureTransport "on": TLS is not recorded$/);
  // With no TCP recording at all, every connection is a miss.
  await refuses(run("none", []), "unrecorded");
  // The refused socket: opened, the read and the write all reject with the miss.
  const replay = replayConnect([LINES]);
  const socket = replay.connect({ hostname: "tcp.example.test", port: 7001 });
  await assert.rejects(socket.opened, (e: unknown) => e instanceof ContractError && e.check === "unrecorded" && /connect tcp\.example\.test:7001: no recording/.test(e.message));
  await assert.rejects(socket.readable.getReader().read(), /no recording/);
  await assert.rejects(socket.writable.getWriter().write(utf8("WINDOW 0\n")), /no recording/);
  assert.deepEqual(replay.connections, [{ address: "tcp.example.test:7001", opened: false, requests: [] }]);
  assert.deepEqual(replay.misses, [{ address: "tcp.example.test:7001", detail: "connect tcp.example.test:7001: no recording" }]);
});

test("adapter connect: two recordings that answer one request otherwise are refused, and equal pairs are kept once", async () => {
  const otherwise = recording("otherwise.tcp.json", [exchange("WINDOW 1\n", "NONE\n")]);
  assert.throws(
    () => replayConnect([LINES, otherwise]),
    (e: unknown) => e instanceof ContractError && e.check === "recording" && e.message === "recording: otherwise.tcp.json#0: another recording answers the same request otherwise (lines.tcp.json#1)",
  );
  await refuses(run("none", [LINES, otherwise]), "recording");
  // The same request at another address is another exchange.
  replayConnect([LINES, recording("elsewhere.tcp.json", [exchange("WINDOW 1\n", "NONE\n")], { hostname: "tcp.example.test", port: 7001 })]);
  const same = recording("same.tcp.json", [exchange("WINDOW 0\n", W0)]);
  const { first } = await run("none", [LINES, same]);
  assert.equal(first.connections[0]!.requests[0]!.exchange, "lines.tcp.json#0");
});

test("adapter connect: a recording is refused for each fault of its shape", () => {
  const good = JSON.parse(encodeTcpRecording({ origin: "synthetic", address: TCP_ADDRESS, exchanges: LINES_EXCHANGES })) as Record<string, unknown>;
  const ex = (good.exchanges as Record<string, unknown>[])[0]!;
  const cases: [string, unknown, RegExp][] = [
    ["not an object", [], /not an object/],
    ["unknown field", { ...good, extra: 1 }, /unknown field extra/],
    ["format", { ...good, format: "domains.tcp-recording.v0" }, /format is not/],
    ["origin", { ...good, origin: "live" }, /origin is not/],
    ["recorded without recorded_at", { ...good, origin: "recorded" }, /needs recorded_at/],
    ["synthetic with recorded_at", { ...good, recorded_at: "2026-10-30T08:00:00Z" }, /synthetic conversation has no recorded_at/],
    ["no address", { ...good, address: undefined }, /address is not an object/],
    ["address field", { ...good, address: { ...TCP_ADDRESS, tls: true } }, /unknown field address\.tls/],
    ["empty hostname", { ...good, address: { hostname: "", port: 7000 } }, /address\.hostname is not a hostname/],
    ["hostname with a space", { ...good, address: { hostname: "tcp example", port: 7000 } }, /address\.hostname is not a hostname/],
    ["port 0", { ...good, address: { hostname: "h", port: 0 } }, /address\.port is not an integer from 1 to 65535/],
    ["port 65536", { ...good, address: { hostname: "h", port: 65536 } }, /address\.port/],
    ["port 1.5", { ...good, address: { hostname: "h", port: 1.5 } }, /address\.port/],
    ["no exchanges", { ...good, exchanges: [] }, /exchanges is not a list of at least one exchange/],
    ["exchanges not a list", { ...good, exchanges: {} }, /exchanges is not a list/],
    ["exchange not an object", { ...good, exchanges: [7] }, /exchanges\[0\] is not an object/],
    ["exchange field", { ...good, exchanges: [{ ...ex, at: 1 }] }, /unknown field exchanges\[0\]\.at/],
    ["note not a string", { ...good, exchanges: [{ ...ex, note: 1 }] }, /exchanges\[0\]\.note is not a string/],
    ["empty request", { ...good, exchanges: [{ ...ex, request_base64: "" }] }, /exchanges\[0\]\.request_base64 holds no byte/],
    ["request not base64", { ...good, exchanges: [{ ...ex, request_base64: "abc" }] }, /exchanges\[0\]\.request_base64 is not base64/],
    ["response not base64", { ...good, exchanges: [{ ...ex, response_base64: "a b=" }] }, /exchanges\[0\]\.response_base64 is not base64/],
    ["response missing", { ...good, exchanges: [{ request_base64: ex.request_base64 }] }, /exchanges\[0\]\.response_base64 is not base64/],
    // An answer of no byte cannot be told from a recording cut short (the review of DOM-026).
    ["empty response", { ...good, exchanges: [{ ...ex, response_base64: "" }] }, /exchanges\[0\]\.response_base64 holds no byte/],
    ["null", null, /not an object/],
    ["a number", 5, /not an object/],
  ];
  for (const [what, json, why] of cases)
    assert.throws(
      () => parseTcpRecording(json, what),
      (e: unknown) => e instanceof ContractError && e.check === "recording" && why.test(e.message),
      what,
    );
  const ok = parseTcpRecording({ ...good, origin: "recorded", recorded_at: "2026-10-30T08:00:00Z", exchanges: [ex] }, "ok");
  assert.deepEqual(
    [ok.origin, ok.recordedAt, ok.address, ok.exchanges[0]!.note, text(ok.exchanges[0]!.request), text(ok.exchanges[0]!.response)],
    ["recorded", "2026-10-30T08:00:00Z", TCP_ADDRESS, "window 0", "WINDOW 0\n", W0],
  );
  assert.equal(good.format, TCP_RECORDING_FORMAT);
});

test("adapter connect: encodeTcpRecording writes a file that reads back, each equal pair once, and refuses a conflict or another address", () => {
  const text1 = encodeTcpRecording({ origin: "recorded", recordedAt: "2026-10-30T08:00:00Z", address: TCP_ADDRESS, exchanges: [...LINES_EXCHANGES, exchange("WINDOW 0\n", W0)] });
  assert.ok(text1.endsWith("}\n"));
  const back = parseTcpRecording(JSON.parse(text1), "back");
  assert.equal(back.exchanges.length, 3);
  assert.deepEqual(Object.keys(JSON.parse(text1)), ["format", "origin", "recorded_at", "address", "exchanges"]);
  // A note is written only when there is one.
  assert.deepEqual(
    (JSON.parse(text1).exchanges as Record<string, unknown>[]).map((x) => Object.keys(x)),
    [
      ["note", "request_base64", "response_base64"],
      ["request_base64", "response_base64"],
      ["request_base64", "response_base64"],
    ],
  );
  assert.throws(
    () => encodeTcpRecording({ origin: "synthetic", address: TCP_ADDRESS, exchanges: [exchange("A", "1"), exchange("A", "2")] }),
    /exchanges\[1\]: an exchange before it answers the same request otherwise/,
  );
  assert.throws(
    () => encodeTcpRecording({ origin: "synthetic", address: TCP_ADDRESS, exchanges: [{ ...exchange("A", "1"), address: { hostname: "other.example.test", port: 7000 } }] }),
    /exchanges\[0\] was taken on other\.example\.test:7000, not tcp\.example\.test:7000/,
  );
  // What parseTcpRecording refuses is never written: no exchange, or a recorded file with no time.
  assert.throws(
    () => encodeTcpRecording({ origin: "synthetic", address: TCP_ADDRESS, exchanges: [] }),
    (e: unknown) => e instanceof ContractError && e.check === "recording",
  );
  assert.throws(() => encodeTcpRecording({ origin: "recorded", address: TCP_ADDRESS, exchanges: LINES_EXCHANGES }), /needs recorded_at/);
});

// A local server of the line protocol: `WINDOW N` answers windows[N], or NONE.
async function lineServer(windows: readonly string[]): Promise<{ port: number; requests: string[]; close(): Promise<void> }> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    let buf = "";
    s.on("data", (b: Buffer) => {
      buf += b.toString("utf8");
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        requests.push(line);
        const n = /^WINDOW (\d+)$/.exec(line)?.[1];
        s.write(n !== undefined && windows[Number(n)] !== undefined ? (windows[Number(n)] as string) : "NONE\n");
      }
    });
    s.on("close", () => sockets.delete(s));
    // The client ends a connection by destroying it; the reset is expected.
    s.on("error", () => {});
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    requests,
    close: () =>
      new Promise<void>((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => ok());
      }),
  };
}

test("adapter connect: tapConnect answers prior requests from the prior exchanges and records the rest", async () => {
  const server = await lineServer([W0, W1]);
  try {
    const address = { hostname: "127.0.0.1", port: server.port };
    // Run 1 at 08:25 reads windows 0 and 1 from the server.
    const tap1 = tapConnect(liveConnect());
    const one = await tcpAdapter("none", address).run(null, ctxOf(tap1.connect, "2026-10-30T08:25:00Z").ctx);
    assert.deepEqual(one.cursor, { window: 2 });
    assert.deepEqual(
      tap1.exchanges.map((x) => [text(x.request), text(x.response), x.address]),
      [
        ["WINDOW 0\n", W0, address],
        ["WINDOW 1\n", W1, address],
      ],
    );
    // Run 2 at 08:35 from the start: windows 0 and 1 come from run 1's exchanges, and only window 2 reaches the server.
    const tap2 = tapConnect(liveConnect(), tap1.exchanges);
    const two = await tcpAdapter("none", address).run(null, ctxOf(tap2.connect).ctx);
    assert.deepEqual(two.cursor, { window: 2 });
    assert.deepEqual(server.requests, ["WINDOW 0", "WINDOW 1", "WINDOW 2"]);
    assert.deepEqual(
      tap2.exchanges.map((x) => [text(x.request), text(x.response)]),
      [["WINDOW 2\n", "NONE\n"]],
    );
    // What the two taps took replays through the harness, with no further request to the server.
    const taken = recording("taken.tcp.json", [...tap1.exchanges, ...tap2.exchanges], address);
    const { first, next } = await runAdapter(tcpAdapter("none", address), { recordings: [], tcp: [taken], psl: PSL, cursor: null, now: NOW });
    assert.deepEqual(
      first.result.segments.map((s) => s.count),
      [2, 1],
    );
    assert.deepEqual(next.result.segments, []);
    assert.equal(server.requests.length, 3);
    // Two prior exchanges that answer one request otherwise are refused.
    assert.throws(
      () =>
        tapConnect(liveConnect(), [
          { ...exchange("A", "1"), address },
          { ...exchange("A", "2"), address },
        ]),
      /prior\[1\]: another prior exchange answers the same request otherwise/,
    );
  } finally {
    await server.close();
  }
});

test("adapter connect: readTcpRecordings reads only *.tcp.json files, sorted, and refuses one that is not JSON", () => {
  const dir = mkdtempSync(join(tmpdir(), "adapter-tcp-recordings-"));
  try {
    const file = encodeTcpRecording({ origin: "synthetic", address: TCP_ADDRESS, exchanges: LINES_EXCHANGES });
    writeFileSync(join(dir, "README.txt"), "not a recording\n");
    writeFileSync(join(dir, "b.tcp.json"), file);
    writeFileSync(join(dir, "a.tcp.json"), file);
    // NTFS lists names case-blind (a, b, D) and ext4 in no set order: the code-unit sort puts D first on both.
    writeFileSync(join(dir, "D.tcp.json"), file);
    writeFileSync(join(dir, "a.http.json"), "{ an HTTP recording is not read here");
    assert.deepEqual(
      readTcpRecordings(dir).map((r) => r.name),
      ["D.tcp.json", "a.tcp.json", "b.tcp.json"],
    );
    writeFileSync(join(dir, "c.tcp.json"), "{ not json");
    assert.throws(
      () => readTcpRecordings(dir),
      (e: unknown) => e instanceof ContractError && e.check === "recording" && /c\.tcp\.json: not JSON/.test(e.message),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("adapter connect: replayConnect refuses options that are not its own", () => {
  assert.throws(
    () => replayConnect("x" as never),
    (e: unknown) => e instanceof ContractError && e.check === "options",
  );
  for (const chunkBytes of [0, -1, 1.5]) assert.throws(() => replayConnect([], { chunkBytes }), /chunkBytes .* is not a positive integer/, String(chunkBytes));
});
