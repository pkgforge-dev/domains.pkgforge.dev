// packages/adapter/node/connect.ts — the connect a production run gives an
// adapter as ctx.connect: a node:net socket in the shape of cloudflare:sockets
// (src/types.ts Connect), with the bounds that keep a hung or runaway broker
// from holding the ingest leg.
//
//   const connect = liveConnect();                       // LIVE_CONNECT_LIMITS
//   const socket = connect({ hostname, port });
//   await socket.opened;
//
// Each bound destroys the socket with a SocketError of its code, which a
// pending read or write of the adapter then rejects with:
//   connect  it did not open within connectMs, or it failed to open;
//   idle     no byte moved for idleMs once open;
//   life     it was open for lifeMs, so a broker that trickles bytes cannot
//            hold the leg; the adapter reads no clock, so its output still
//            depends only on the bytes it read and ctx.now;
//   bytes    it read more than maxBytes;
//   closed   close() was called before it opened.
// Plain TCP only: secureTransport other than "off" throws (TLS is not built).
import { connect as netConnect, type Socket } from "node:net";
import { Duplex } from "node:stream";
import type { AdapterSocket, Connect } from "../src/types.ts";

export interface LiveConnectLimits {
  readonly connectMs: number;
  readonly idleMs: number;
  readonly lifeMs: number;
  readonly maxBytes: number;
}

// connectMs: DOM-004's reach timeout. idleMs: a Fetch waits at most 500 ms at
// the broker, so a minute of silence is a hung broker. lifeMs: the worst case
// of oi-nrd's caps reads about 1.5 million messages, 5.4 to 9 minutes at
// DOM-004's rates of 0.6 to 1.0 MB/s, so 15 minutes ends a broker that
// trickles and never such a read; the verify and the pushes of the leg come
// after the socket closes (adapters/oi-nrd/src/index.ts, LIMITS, has the step
// budget). maxBytes: such a run reads about 0.33 GB, so 1 GiB bounds a runaway
// and never a normal run.
export const LIVE_CONNECT_LIMITS: LiveConnectLimits = Object.freeze({ connectMs: 10_000, idleMs: 60_000, lifeMs: 15 * 60_000, maxBytes: 1024 * 1024 * 1024 });

export type SocketErrorCode = "connect" | "idle" | "life" | "bytes" | "closed";

export class SocketError extends Error {
  readonly code: SocketErrorCode;
  constructor(code: SocketErrorCode, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${message}`, options);
    this.name = "SocketError";
    this.code = code;
  }
}

function checkLimits(limits: LiveConnectLimits): void {
  for (const k of ["connectMs", "idleMs", "lifeMs", "maxBytes"] as const) {
    const v = limits?.[k];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new TypeError(`liveConnect: ${k} ${v} is not a positive integer`);
  }
}

export function liveConnect(limits: LiveConnectLimits = LIVE_CONNECT_LIMITS): Connect {
  checkLimits(limits);
  return (address, options): AdapterSocket => {
    const at = `${address.hostname}:${address.port}`;
    const tls = options?.secureTransport;
    if (tls !== undefined && tls !== "off") throw new SocketError("connect", `${at}: secureTransport ${JSON.stringify(tls)} is not built; plain TCP only`);
    const sock: Socket = netConnect({ host: address.hostname, port: address.port, allowHalfOpen: options?.allowHalfOpen ?? false });
    // One request in flight: Nagle's delay buys no batching here.
    sock.setNoDelay(true);
    // Before the 'data' listener below: toWeb reads by its own listener, and
    // pauses the socket for backpressure, which stops the count's events too.
    const { readable, writable } = Duplex.toWeb(sock);
    let life: ReturnType<typeof setTimeout> | null = null;
    let open = false;
    let settle: { ok: () => void; fail: (err: Error) => void } | null = null;
    const opened = new Promise<{ remoteAddress: string }>((ok, fail) => {
      settle = { ok: () => ok({ remoteAddress: at }), fail };
    });
    // A failure to open reaches the adapter through its streams as well; it
    // need not await opened.
    opened.catch(() => {});
    const fail = (err: Error): void => {
      settle?.fail(err);
      settle = null;
      sock.destroy(err);
    };
    const connectTimer = setTimeout(() => fail(new SocketError("connect", `${at}: did not open within ${limits.connectMs} ms`)), limits.connectMs);
    sock.once("connect", () => {
      clearTimeout(connectTimer);
      open = true;
      settle?.ok();
      settle = null;
      sock.setTimeout(limits.idleMs);
      life = setTimeout(() => sock.destroy(new SocketError("life", `${at}: open for ${limits.lifeMs} ms, the most a connection lives`)), limits.lifeMs);
    });
    sock.on("timeout", () => sock.destroy(new SocketError("idle", `${at}: no byte moved for ${limits.idleMs} ms`)));
    let read = 0;
    sock.on("data", (chunk: Buffer) => {
      read += chunk.byteLength;
      if (read > limits.maxBytes) sock.destroy(new SocketError("bytes", `${at}: read ${read} bytes, past the cap of ${limits.maxBytes}`));
    });
    sock.on("error", (err) => {
      // An error before the socket opened fails `opened`; after, it reaches
      // the streams, which toWeb errors with it.
      if (!open) {
        clearTimeout(connectTimer);
        const wrapped = err instanceof SocketError ? err : new SocketError("connect", `${at}: ${err.message}`, { cause: err });
        settle?.fail(wrapped);
        settle = null;
      }
    });
    sock.once("close", () => {
      clearTimeout(connectTimer);
      if (life !== null) clearTimeout(life);
      settle?.fail(new SocketError("closed", `${at}: closed before it opened`));
      settle = null;
    });
    return {
      readable,
      writable,
      opened,
      close: () =>
        new Promise<void>((done) => {
          if (sock.closed) return done();
          sock.once("close", () => done());
          sock.destroy();
        }),
    };
  };
}
