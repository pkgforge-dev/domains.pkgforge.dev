// scripts/measure/kafka-client.mjs — the one Kafka client of the measurement
// scripts: TCP and TLS reach, one connection with requests matched to responses
// by correlation id, the offset summary of design A and design B, and a range
// consumer that counts what a raw lane would store.
//
// The research scripts of design A and design B each carried their own copy of
// the socket, the framing and the parsers (docs/research/2026-10-27-design-a/
// scripts/kafka-*.mjs, docs/research/2026-10-27-design-b/scripts/kafka*.mjs).
// Their copies under scripts/measure/ share this one instead
// (docs/conventions/code.md, "One read path, one write path").
//
// Read-only: it sends ApiVersions, Metadata, ListOffsets and Fetch, as a
// consumer with no group, so it commits nothing on the broker.
//
// Usage: import { KafkaClient, reach, consumeRange, offsetSummary } from './kafka-client.mjs'
// It is a module; it has no command line and no exit code.
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import tls from 'node:tls';
import {
  API,
  apiVersionsBody,
  decodeBatch,
  EARLIEST,
  encodeRequest,
  fetchBody,
  KafkaDecodeError,
  KafkaError,
  LATEST,
  listOffsetsBody,
  metadataBody,
  ProtocolError,
  parseApiVersions,
  parseFetch,
  parseListOffsets,
  parseMetadata,
  Reader,
  splitBatches,
  VERSION,
} from './kafka-protocol.mjs';

export const ZONESTREAM_HOST = 'kafka.zonestream.openintel.nl';
export const ZONESTREAM_PORT = 9092;
// The client id the broker's operator sees in its request log.
export const CLIENT_ID = 'domains.pkgforge.dev';
const HOUR = 3600e3;

// A TCP socket, or a TLS one that names the host for SNI when it is a name
// (TLS refuses an address as a server name).
const openSocket = (host, port, useTls) => (useTls ? tls.connect({ host, port, ...(net.isIP(host) === 0 ? { servername: host } : {}) }) : net.connect({ host, port }));

// Whether a TCP (or TLS) connection opens within timeoutMs. Never throws:
// {port, ok, ms} or {port, ok: false, error} where error is 'timeout' or a code.
// It records no address, of either end.
export function reach(host, port, timeoutMs, { useTls = false } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let settled = false;
    let timer = null;
    const done = (value, sock) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock?.destroy();
      resolve({ port, tls: useTls, ...value });
    };
    let sock;
    try {
      sock = openSocket(host, port, useTls);
    } catch (e) {
      done({ ok: false, error: e.code ?? e.message }, null);
      return;
    }
    timer = setTimeout(() => done({ ok: false, error: 'timeout', timeout_ms: timeoutMs }, sock), timeoutMs);
    sock.once(useTls ? 'secureConnect' : 'connect', () => {
      const extra = useTls ? { protocol: sock.getProtocol(), authorized: sock.authorized, authorization_error: sock.authorizationError ?? null } : {};
      done({ ok: true, ms: Math.round(performance.now() - t0), ...extra }, sock);
    });
    sock.once('error', (e) => done({ ok: false, error: e.code ?? e.message }, sock));
  });
}

// Joins size-prefixed frames from socket chunks with one copy per frame:
// concatenating on every chunk is quadratic in the size of a large Fetch.
export class FrameReader {
  constructor(onFrame) {
    this.onFrame = onFrame;
    this.chunks = [];
    this.length = 0;
    this.need = -1;
  }
  push(chunk) {
    this.chunks.push(chunk);
    this.length += chunk.length;
    for (;;) {
      if (this.need < 0) {
        if (this.length < 4) return;
        const head = this.chunks[0].length >= 4 ? this.chunks[0] : Buffer.concat(this.chunks, this.length);
        const size = head.readInt32BE(0);
        if (size < 4) throw new ProtocolError(`a response frame declares ${size} byte(s), less than its correlation id`);
        this.need = 4 + size;
      }
      if (this.length < this.need) return;
      const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.length);
      const frameBytes = this.need;
      const frame = all.subarray(4, frameBytes);
      const rest = all.subarray(frameBytes);
      this.chunks = rest.length > 0 ? [rest] : [];
      this.length = rest.length;
      this.need = -1;
      this.onFrame(frame, frameBytes);
    }
  }
}

export class KafkaClient {
  // Opens one connection. Rejects when it does not open within timeoutMs.
  static connect({ host = ZONESTREAM_HOST, port = ZONESTREAM_PORT, timeoutMs = 10e3, requestTimeoutMs = 60e3, clientId = CLIENT_ID, useTls = false } = {}) {
    return new Promise((resolve, reject) => {
      const sock = openSocket(host, port, useTls);
      const timer = setTimeout(() => {
        sock.destroy();
        reject(new Error(`connect ${host}:${port}: timeout after ${timeoutMs} ms`));
      }, timeoutMs);
      sock.once('error', (e) => {
        clearTimeout(timer);
        reject(new Error(`connect ${host}:${port}: ${e.code ?? e.message}`));
      });
      sock.once(useTls ? 'secureConnect' : 'connect', () => {
        clearTimeout(timer);
        sock.removeAllListeners('error');
        resolve(new KafkaClient(sock, { host, port, requestTimeoutMs, clientId }));
      });
    });
  }

  constructor(sock, { host, port, requestTimeoutMs, clientId }) {
    this.sock = sock;
    this.where = `${host}:${port}`;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientId = clientId;
    this.nextId = 1;
    this.pending = new Map();
    this.failed = null;
    this.bytesRead = 0;
    this.frames = new FrameReader((frame, frameBytes) => this.onFrame(frame, frameBytes));
    sock.on('data', (chunk) => {
      this.bytesRead += chunk.length;
      try {
        this.frames.push(chunk);
      } catch (e) {
        this.fail(e);
      }
    });
    sock.on('error', (e) => this.fail(new Error(`${this.where}: socket error ${e.code ?? e.message}`)));
    sock.on('close', () => this.fail(new Error(`${this.where}: connection closed`)));
  }

  onFrame(frame, frameBytes) {
    const id = frame.readInt32BE(0);
    const first = this.pending.keys().next().value;
    if (id !== first) {
      this.fail(new ProtocolError(`${this.where}: response with correlation id ${id} while ${first ?? 'none'} is the oldest pending`));
      return;
    }
    const p = this.pending.get(id);
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.resolve({ reader: new Reader(frame.subarray(4), p.what), frameBytes, raw: frame });
  }

  // Rejects every pending request and refuses new ones: after a framing or
  // socket failure the stream cannot be trusted.
  fail(err) {
    if (!this.failed) this.failed = err;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(this.failed);
    }
    this.pending.clear();
    this.sock.destroy();
  }

  request(apiKey, body, what) {
    if (this.failed) return Promise.reject(this.failed);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`${this.where}: ${what} timed out after ${this.requestTimeoutMs} ms`)), this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, what });
      this.sock.write(encodeRequest({ apiKey, apiVersion: VERSION[apiKey], correlationId: id, clientId: this.clientId, body }));
    });
  }

  // ApiVersions v0. Refuses a broker that cannot speak the versions this client sends.
  async apiVersions() {
    const { reader } = await this.request(API.API_VERSIONS, apiVersionsBody(), 'ApiVersions v0');
    const { errorCode, apis } = parseApiVersions(reader);
    if (errorCode !== 0) throw new KafkaError(errorCode, 'ApiVersions v0');
    for (const [key, version] of Object.entries(VERSION)) {
      const range = apis.get(Number(key));
      if (!range || version < range.min || version > range.max)
        throw new ProtocolError(`the broker serves API ${key} at ${range ? `${range.min}..${range.max}` : 'no version'}; this client sends v${version}`);
    }
    return apis;
  }

  async metadata(topics = []) {
    const { reader } = await this.request(API.METADATA, metadataBody(topics), 'Metadata v0');
    return parseMetadata(reader);
  }

  // ListOffsets v1 for [{topic, partitions: [{partition, timestamp}]}]. A
  // non-zero error code on any partition throws.
  async listOffsets(topics) {
    const { reader } = await this.request(API.LIST_OFFSETS, listOffsetsBody(topics), 'ListOffsets v1');
    const out = parseListOffsets(reader);
    for (const t of out) for (const p of t.partitions) if (p.errorCode !== 0) throw new KafkaError(p.errorCode, `ListOffsets ${t.topic}/${p.partition}`);
    return out;
  }

  // Fetch v4. frameBytes is the size of the response as it came off the socket.
  async fetch({ topics, maxWaitMs = 500, minBytes = 1, maxBytes = 8 << 20 }) {
    const { reader, frameBytes } = await this.request(API.FETCH, fetchBody({ topics, maxWaitMs, minBytes, maxBytes }), 'Fetch v4');
    return { frameBytes, ...parseFetch(reader) };
  }

  close() {
    this.failed ??= new Error(`${this.where}: closed by the caller`);
    this.sock.end();
    this.sock.destroy();
  }
}

// The topics of a Metadata answer that a consumer reads: not the internal ones.
export const userTopics = (md) => md.topics.filter((t) => !t.name.startsWith('__'));

// One Fetch of one partition at `offset`, decoded: the records at or after it,
// the whole batches as split, and the high watermark. A broker error or a batch
// that does not decode throws.
export async function fetchRecords(client, topic, partition, offset, maxBytes = 64 << 10) {
  const res = await client.fetch({ topics: [{ topic, partitions: [{ partition, offset, maxBytes }] }], maxWaitMs: 100, maxBytes });
  const rp = res.topics.find((t) => t.topic === topic)?.partitions.find((p) => p.partition === partition);
  if (!rp) throw new ProtocolError(`Fetch did not answer ${topic}/${partition}`);
  if (rp.errorCode !== 0) throw new KafkaError(rp.errorCode, `Fetch ${topic}/${partition} at offset ${offset}`);
  const { batches, partial } = splitBatches(rp.records ?? Buffer.alloc(0));
  const records = [];
  const decoded = batches.map((b) => decodeBatch(b.bytes));
  for (const d of decoded) if (!d.isControl) for (const r of d.records) if (r.offset >= offset) records.push(r);
  return { highWatermark: rp.highWatermark, frameBytes: res.frameBytes, recordsBytes: rp.records?.length ?? 0, batches, decoded, partial, records };
}

// One ListOffsets request per timestamp, over every partition of `topics`
// ([{name, partitions: [{partition}]}]). Returns Map "topic/partition" -> offset.
async function offsetsAt(client, topics, timestamp) {
  const res = await client.listOffsets(topics.map((t) => ({ topic: t.name, partitions: t.partitions.map((p) => ({ partition: p.partition, timestamp })) })));
  const map = new Map();
  for (const t of res) for (const p of t.partitions) map.set(`${t.topic}/${p.partition}`, p.offset);
  return map;
}

// The first record's timestamp of each partition at its earliest offset, read
// from the header of the first batch a small Fetch returns. null when empty.
async function earliestTimestamps(client, topics, earliest) {
  const out = new Map();
  for (const t of topics) {
    const res = await client.fetch({
      topics: [{ topic: t.name, partitions: t.partitions.map((p) => ({ partition: p.partition, offset: earliest.get(`${t.name}/${p.partition}`), maxBytes: 64 << 10 })) }],
      maxWaitMs: 100,
    });
    for (const rt of res.topics) {
      for (const rp of rt.partitions) {
        if (rp.errorCode !== 0) throw new KafkaError(rp.errorCode, `Fetch ${rt.topic}/${rp.partition} at the earliest offset`);
        const { batches } = splitBatches(rp.records ?? Buffer.alloc(0));
        out.set(`${rt.topic}/${rp.partition}`, batches[0]?.firstTimestamp ?? null);
      }
    }
  }
  return out;
}

// The offset summary of design A's kafka-offsets.mjs and design B's
// kafkaprobe.mjs, for every partition of `topics` at `now` (ms): earliest,
// latest, the offset at now - 1 h, 24 h and 7 d, and the counts between them.
// A timestamp query answered with -1 (no message at or after it) counts 0.
// Counts are offset differences, so a transaction marker counts as a message.
// last_24h_capped is true when the earliest retained message is younger than
// 24 h, so last_24h holds less than a day.
export async function offsetSummary(client, topics, now) {
  const earliest = await offsetsAt(client, topics, EARLIEST);
  const latest = await offsetsAt(client, topics, LATEST);
  const at = {};
  for (const [name, back] of [
    ['1h', HOUR],
    ['24h', 24 * HOUR],
    ['7d', 7 * 24 * HOUR],
  ])
    at[name] = await offsetsAt(client, topics, now - back);
  const firstTs = await earliestTimestamps(client, topics, earliest);
  const summary = {};
  for (const t of topics) {
    const parts = t.partitions.map((p) => {
      const k = `${t.name}/${p.partition}`;
      const l = latest.get(k);
      const since = (m) => (m.get(k) === -1 ? 0 : l - m.get(k));
      return {
        partition: p.partition,
        earliest: earliest.get(k),
        latest: l,
        off_1h_ago: at['1h'].get(k),
        off_24h_ago: at['24h'].get(k),
        off_7d_ago: at['7d'].get(k),
        last_1h: since(at['1h']),
        last_24h: since(at['24h']),
        last_7d: since(at['7d']),
        earliest_ts: firstTs.get(k),
      };
    });
    const sum = (f) => parts.reduce((a, p) => a + f(p), 0);
    const known = parts.map((p) => p.earliest_ts).filter((x) => x !== null);
    const earliestTs = known.length > 0 ? Math.min(...known) : null;
    summary[t.name] = {
      partitions: parts.length,
      retained: sum((p) => p.latest - p.earliest),
      last_1h: sum((p) => p.last_1h),
      last_24h: sum((p) => p.last_24h),
      last_7d: sum((p) => p.last_7d),
      earliest_ts: earliestTs === null ? null : new Date(earliestTs).toISOString(),
      last_24h_capped: earliestTs !== null && earliestTs > now - 24 * HOUR,
      by_partition: parts,
    };
  }
  return summary;
}

// The decode counters several consumes share: batches by codec, and failures by
// kind and by codec. snappy_failures in a result is failed_by_codec.snappy.
export function newDecodeStats() {
  return { batches: 0, by_codec: {}, failures: {}, failed_by_codec: {} };
}

const bump = (obj, key, n = 1) => {
  obj[key] = (obj[key] ?? 0) + n;
};

const FIRST_FETCH = 256 << 10;
const MIN_FETCH = 16 << 10;

// Consumes [start, stop) of each partition of one topic, counting every whole
// batch whose offsets reach into the range. Each counted batch is counted
// whole: its records are `messages`, its bytes are `wire_bytes`, so the two
// describe the same data even where a batch straddles an end of the range.
//
//   ranges      [{partition, start, stop}], stop exclusive
//   fetchBytes  the ceiling of each Fetch, per partition
//   wallCapMs   stop starting fetches after this long, whatever is left
//               (ended_by 'wall'); the fetch in flight still completes
//   onRecord    called with (record, partition) for each record of a counted batch
//   stats       the shared decode counters (newDecodeStats)
//
// The first Fetch of a partition asks for at most 256 KiB; each later one for
// what the rest of the range should take at the bytes per offset seen so far,
// plus 5% and 16 KiB, up to fetchBytes. So the read ends near its stop offset
// rather than up to fetchBytes past it, which would add bytes and seconds that
// belong to no counted batch. The broker returns a batch larger than the limit
// whole (Fetch v3 and later), so a small limit cannot stall the read.
//
// A partition ends at its stop offset ('window'), or at the high watermark when
// the range runs past what the broker holds ('head'). A broker error code, a
// framing error or five fetches in a row that return nothing below the high
// watermark throw. A batch that does not decode is counted in stats and in
// failed_batches and failed_wire_bytes, and the read goes on past it.
export async function consumeRange(client, { topic, ranges, fetchBytes = 8 << 20, maxWaitMs = 500, wallCapMs = Number.POSITIVE_INFINITY, onRecord = null, stats = newDecodeStats() }) {
  const parts = ranges.map((r) => ({ ...r, next: r.start, done: r.start >= r.stop, endedBy: r.start >= r.stop ? 'window' : null, hwm: null, seenBytes: 0, seenOffsets: 0 }));
  const sizeFor = (p) => {
    if (p.seenOffsets === 0) return Math.min(fetchBytes, FIRST_FETCH);
    const want = Math.ceil((p.stop - p.next) * (p.seenBytes / p.seenOffsets) * 1.05) + MIN_FETCH;
    return Math.min(fetchBytes, Math.max(MIN_FETCH, want));
  };
  const c = { messages: 0, bytes: 0, wire_bytes: 0, raw_bytes: 0, decoded_bytes: 0, batches: 0, control_batches: 0, failed_batches: 0, failed_wire_bytes: 0, fetches: 0, codecs: {} };
  let firstOffset = null;
  let lastOffset = null;
  let firstTs = null;
  let lastTs = null;
  let empties = 0;
  let wall = false;
  const t0 = performance.now();
  for (;;) {
    const active = parts.filter((p) => !p.done);
    if (active.length === 0) break;
    if (performance.now() - t0 > wallCapMs) {
      wall = true;
      break;
    }
    const asks = active.map((p) => ({ partition: p.partition, offset: p.next, maxBytes: sizeFor(p) }));
    const res = await client.fetch({
      topics: [{ topic, partitions: asks }],
      maxWaitMs,
      maxBytes: Math.min(
        0x7fffffff,
        asks.reduce((a, x) => a + x.maxBytes, 0),
      ),
    });
    c.fetches += 1;
    c.bytes += res.frameBytes;
    let progressed = false;
    for (const rt of res.topics) {
      for (const rp of rt.partitions) {
        const p = parts.find((x) => x.partition === rp.partition);
        if (rt.topic !== topic || !p) throw new ProtocolError(`Fetch answered ${rt.topic}/${rp.partition}, which was not asked for`);
        if (rp.errorCode !== 0) throw new KafkaError(rp.errorCode, `Fetch ${topic}/${rp.partition} at offset ${p.next}`);
        p.hwm = rp.highWatermark;
        const { batches, partial } = splitBatches(rp.records ?? Buffer.alloc(0));
        let counted = 0;
        for (const b of batches) {
          if (b.lastOffset < p.next) continue;
          if (b.baseOffset >= p.stop) {
            p.done = true;
            p.endedBy = 'window';
            break;
          }
          counted += 1;
          p.seenBytes += b.size;
          p.seenOffsets += b.lastOffset + 1 - b.baseOffset;
          p.next = b.lastOffset + 1;
          firstOffset ??= b.baseOffset;
          lastOffset = b.lastOffset;
          try {
            const d = decodeBatch(b.bytes);
            stats.batches += 1;
            bump(stats.by_codec, d.codec);
            bump(c.codecs, d.codec);
            c.batches += 1;
            c.wire_bytes += b.size;
            c.decoded_bytes += d.decodedBytes;
            if (d.isControl) {
              c.control_batches += 1;
            } else {
              for (const rec of d.records) {
                c.messages += 1;
                c.raw_bytes += rec.value ? rec.value.length : 0;
                firstTs ??= rec.timestamp;
                lastTs = rec.timestamp;
                if (onRecord) onRecord(rec, rp.partition);
              }
            }
          } catch (e) {
            if (!(e instanceof KafkaDecodeError)) throw e;
            stats.batches += 1;
            bump(stats.failures, e.kind);
            bump(stats.failed_by_codec, b.codec ?? `magic-${b.magic}`);
            c.failed_batches += 1;
            c.failed_wire_bytes += b.size;
            if (!c.first_failure) c.first_failure = `offset ${b.baseOffset}: ${e.message}`;
          }
          if (p.next >= p.stop) {
            p.done = true;
            p.endedBy = 'window';
            break;
          }
        }
        if (counted > 0) progressed = true;
        if (!p.done && counted === 0) {
          if (p.next >= p.hwm) {
            p.done = true;
            p.endedBy = 'head';
          } else if (batches.length === 0 && partial > 0) {
            throw new ProtocolError(`Fetch ${topic}/${rp.partition} at offset ${p.next} returned only ${partial} byte(s) of a partial batch`);
          }
        }
        if (p.done) progressed = true;
      }
    }
    empties = progressed ? 0 : empties + 1;
    if (empties >= 5) throw new ProtocolError(`Fetch ${topic} returned nothing below the high watermark five times in a row`);
  }
  const seconds = (performance.now() - t0) / 1000;
  const endedBy = wall ? 'wall' : parts.some((p) => p.endedBy === 'head') ? 'head' : 'window';
  const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
  return {
    topic,
    ranges: parts.map((p) => ({ partition: p.partition, start: p.start, stop: p.stop, next: p.next, high_watermark: p.hwm, ended_by: p.endedBy ?? 'wall' })),
    first_offset: firstOffset,
    last_offset: lastOffset,
    first_ts: iso(firstTs),
    last_ts: iso(lastTs),
    ...c,
    seconds: Math.round(seconds * 1000) / 1000,
    messages_per_second: seconds > 0 ? Math.round(c.messages / seconds) : null,
    mb_per_second: seconds > 0 ? Math.round((c.bytes / seconds / 1e6) * 1000) / 1000 : null,
    raw_mb_per_second: seconds > 0 ? Math.round((c.raw_bytes / seconds / 1e6) * 1000) / 1000 : null,
    ended_by: endedBy,
  };
}

// The [start, stop) ranges of a topic between two timestamps (ms): the offset
// of the first message at or after each. A stop past the newest message is the
// latest offset, so the read ends at the head.
export async function rangesBetween(client, topic, partitions, fromMs, toMs) {
  const t = [{ name: topic, partitions: partitions.map((p) => ({ partition: p })) }];
  const start = await offsetsAt(client, t, fromMs);
  const stop = await offsetsAt(client, t, toMs);
  const latest = await offsetsAt(client, t, LATEST);
  return partitions.map((p) => {
    const k = `${topic}/${p}`;
    const l = latest.get(k);
    const s = start.get(k) === -1 ? l : start.get(k);
    const e = stop.get(k) === -1 ? l : stop.get(k);
    return { partition: p, start: s, stop: Math.max(s, e) };
  });
}

// The [earliest, stop) ranges of a topic, stop being the first message at or
// after earliest + spanMs (the earliest message's own timestamp, earliestMs).
export async function rangesFromEarliest(client, topic, partitions, earliestMs, spanMs) {
  const t = [{ name: topic, partitions: partitions.map((p) => ({ partition: p })) }];
  const earliest = await offsetsAt(client, t, EARLIEST);
  const stop = await offsetsAt(client, t, earliestMs + spanMs);
  const latest = await offsetsAt(client, t, LATEST);
  return partitions.map((p) => {
    const k = `${topic}/${p}`;
    const e = stop.get(k) === -1 ? latest.get(k) : stop.get(k);
    return { partition: p, start: earliest.get(k), stop: Math.max(earliest.get(k), e) };
  });
}
