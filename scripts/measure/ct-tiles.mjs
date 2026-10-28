// scripts/measure/ct-tiles.mjs — the static CT API client of the names-tile
// measurement (DOM-011, TODO/ingest.md): tile paths, the checkpoint, the names
// tile, and one GET with the project's User-Agent, timed, keeping the headers
// and the start of the body of any answer other than 200.
//
// The API (the static CT API and the names tiles of Sunlight's logs): a log's
// monitoring URL serves `checkpoint`, a signed note whose line 1 is the origin,
// line 2 the tree size in decimal and line 3 the root hash in base64; and
// `tile/names/<N>`, the names of the 256 entries of data tile N, one JSON
// object a line: {"Timestamp":<ms>,"Subject":{...},"DNS":[...]}. <N> is written
// in groups of three digits from the right, each group but the last prefixed
// `x` (4,074,091 is x004/x074/091; 91 is 091). The last size % 256 entries are
// the partial tile `<N>.p/<W>`, W its width.
//
// Every request sends USER_AGENT (feed-poll.mjs; TODO/RULES.md section 5,
// ruling 11): a Geomys host answers 429 to a client with no email address in
// its User-Agent (DOM-011's premise, MEASURED 2026-10-27T08:24:26Z). Every
// request asks for gzip, as design A's reads did, so `gz_bytes` (the
// Content-Length) is the size on the wire and `bytes` the decoded size.
//
// A 429 is retried only when the caller asks (a window read does, a round of
// the availability probe does not: there a 429 is the measurement), after the
// Retry-After the host states, capped, and at most `retry429` times.
//
// The hosts come from the log list, so each is held to bounds: a body is read
// through its stream and cancelled past BODY_MAX_BYTES decoded bytes (far
// above a names tile of 256 entries, a checkpoint or the log list), which
// makes it an answer with an error; and a redirect is followed, as a fetcher
// of the tiles would follow it, with the host it ended at recorded as
// `redirected_to`, so an answer is never credited to the log's own host
// unseen.
//
// Usage: import { tilePath, partialPath, parseCheckpoint, parseNamesTile, createClient } from './ct-tiles.mjs'
// It is a module; it has no command line and no exit code.
import { USER_AGENT } from './feed-poll.mjs';

export { USER_AGENT };

export const TILE_WIDTH = 256;
export const TIMEOUT_MS = 20_000;
export const PER_HOST = 4;
// A Retry-After above this is not waited for: the request stays a 429.
export const RETRY_AFTER_MAX_S = 60;
export const BODY_MAX_BYTES = 8 * 1024 * 1024;
const TEXT_MAX = 200;
const HEADERS_MAX = 24;

export class CtError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CtError';
  }
}

// The path of names tile n below `tile/names/`.
export function tilePath(n) {
  if (!Number.isSafeInteger(n) || n < 0) throw new CtError(`a tile number must be a non-negative integer, got ${n}`);
  const groups = [];
  let rest = n;
  do {
    groups.unshift(String(rest % 1000).padStart(3, '0'));
    rest = Math.floor(rest / 1000);
  } while (rest > 0);
  return groups.map((g, i) => (i < groups.length - 1 ? `x${g}` : g)).join('/');
}

// The path of the partial tile n of width w (1 to 255).
export function partialPath(n, w) {
  if (!Number.isInteger(w) || w < 1 || w >= TILE_WIDTH) throw new CtError(`a partial tile is 1 to 255 entries wide, got ${w}`);
  return `${tilePath(n)}.p/${w}`;
}

// The monitoring URL with exactly one trailing slash.
export const baseOf = (mon) => mon.replace(/\/*$/, '/');

// The tiles of a tree of `size` entries: the last full tile (or -1) and the
// width of the partial tile after it (0 when there is none).
export function tilesOf(size) {
  return { last: Math.floor(size / TILE_WIDTH) - 1, partial: size % TILE_WIDTH };
}

// { origin, size, root } of a checkpoint body. Throws a CtError on any other
// shape, so a page that is not a checkpoint never reads as a tree size.
export function parseCheckpoint(text) {
  const lines = String(text).split('\n');
  if (lines.length < 3) throw new CtError('a checkpoint has at least three lines');
  const [origin, size, root] = lines;
  if (origin.trim() === '') throw new CtError('the checkpoint has no origin line');
  if (!/^\d{1,16}$/.test(size)) throw new CtError(`the checkpoint's size line is not a decimal number: ${JSON.stringify(size.slice(0, 40))}`);
  const n = Number(size);
  if (!Number.isSafeInteger(n)) throw new CtError(`the checkpoint's size ${size} is not a safe integer`);
  if (!/^[A-Za-z0-9+/]+=*$/.test(root)) throw new CtError('the checkpoint has no base64 root hash line');
  return { origin, size: n, root };
}

// The entries of a names tile: [{ ts, dns }]. Each line must be a JSON object
// with a numeric Timestamp; DNS, when present, an array of strings. With
// `expected`, the count must be that. Throws a CtError otherwise.
export function parseNamesTile(text, expected = null) {
  const lines = String(text).split('\n');
  if (lines.at(-1) === '') lines.pop();
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    let j;
    try {
      j = JSON.parse(lines[i]);
    } catch {
      throw new CtError(`line ${i + 1} of the names tile is not JSON`);
    }
    if (j === null || typeof j !== 'object' || typeof j.Timestamp !== 'number' || !Number.isFinite(j.Timestamp)) throw new CtError(`line ${i + 1} of the names tile has no numeric Timestamp`);
    const dns = j.DNS ?? [];
    if (!Array.isArray(dns) || dns.some((d) => typeof d !== 'string')) throw new CtError(`line ${i + 1} of the names tile has a DNS that is not an array of strings`);
    out.push({ ts: j.Timestamp, dns });
  }
  if (expected !== null && out.length !== expected) throw new CtError(`the names tile holds ${out.length} entries, not ${expected}`);
  return out;
}

const clip = (s) => (s.length > TEXT_MAX ? `${s.slice(0, TEXT_MAX)}...` : s);
// Printable ASCII only, so a body snippet in a JSON line stays readable.
const printable = (s) => clip(s.replace(/[^\x20-\x7e]+/g, ' ').trim());

export function errorText(e) {
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'timeout';
  const code = e?.cause?.code;
  return clip(code ? `${code}: ${e.message}` : String(e?.message ?? e));
}

// Every header but set-cookie, each value clipped, at most HEADERS_MAX.
export function pickHeaders(headers) {
  const out = {};
  let n = 0;
  for (const [k, v] of headers) {
    if (k === 'set-cookie') continue;
    if (n++ >= HEADERS_MAX) break;
    out[k] = clip(v);
  }
  return out;
}

const lengthOf = (headers) => {
  const v = headers.get('content-length');
  return v !== null && /^\d+$/.test(v) ? Number(v) : null;
};

// Seconds from a Retry-After header in its delta form, else null.
export function retryAfterSeconds(value) {
  return value !== null && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null;
}

// The body of `res`, read through its stream and cancelled past `cap` bytes,
// so a large or endlessly inflating answer never fills the memory.
async function readCapped(res, cap) {
  if (res.body === null || res.body === undefined) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const parts = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return Buffer.concat(parts, n);
    n += value.byteLength;
    if (n > cap) {
      await reader.cancel().catch(() => {});
      throw new CtError(`the body passed ${cap} B`);
    }
    parts.push(value);
  }
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
};

// A client: get(url, { retry429 }) resolves to an observation, never rejects:
//   { status, ms, gz_bytes, bytes, text (200 only), headers and body (other
//     than 200), redirected_to (the host a redirect ended at), tries,
//     throttled (429s seen), error (no answer, or a body over maxBytes) }
// At most `perHost` requests to one host are in flight; `signal` ends every
// request (a round's deadline). `sleep` is the wait before a retry.
export function createClient({
  fetchFn = globalThis.fetch,
  clock = Date.now,
  timeoutMs = TIMEOUT_MS,
  perHost = PER_HOST,
  signal = null,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  userAgent = USER_AGENT,
  maxBytes = BODY_MAX_BYTES,
} = {}) {
  const hosts = new Map();
  const counts = { requests: 0, throttled: 0, failed: 0 };

  async function slot(host) {
    let h = hosts.get(host);
    if (!h) hosts.set(host, (h = { active: 0, queue: [] }));
    if (h.active >= perHost) await new Promise((r) => h.queue.push(r));
    h.active += 1;
    return () => {
      h.active -= 1;
      h.queue.shift()?.();
    };
  }

  async function once(url) {
    const at = clock();
    const release = await slot(new URL(url).host);
    counts.requests += 1;
    try {
      const signals = [AbortSignal.timeout(timeoutMs)];
      if (signal) signals.push(signal);
      const res = await fetchFn(url, { headers: { 'user-agent': userAgent, 'accept-encoding': 'gzip' }, signal: AbortSignal.any(signals) });
      const buf = await readCapped(res, maxBytes);
      const o = { status: res.status, ms: clock() - at, gz_bytes: lengthOf(res.headers), bytes: buf.length };
      if (res.redirected) o.redirected_to = hostOf(res.url);
      if (res.status === 200) o.text = buf.toString('utf8');
      else {
        o.headers = pickHeaders(res.headers);
        o.body = printable(buf.subarray(0, 512).toString('latin1'));
      }
      return o;
    } catch (e) {
      counts.failed += 1;
      return { status: null, ms: clock() - at, error: errorText(e) };
    } finally {
      release();
    }
  }

  async function get(url, { retry429 = 0 } = {}) {
    let tries = 0;
    let throttled = 0;
    for (;;) {
      const o = await once(url);
      tries += 1;
      if (o.status === 429) {
        throttled += 1;
        counts.throttled += 1;
        const after = retryAfterSeconds(o.headers?.['retry-after'] ?? null);
        if (tries <= retry429 && (after === null || after <= RETRY_AFTER_MAX_S) && !signal?.aborted) {
          await sleep((after ?? 2 * tries) * 1000);
          continue;
        }
      }
      return { ...o, tries, throttled };
    }
  }

  return { get, counts };
}

// The observation without its body text, as a round records it.
export function brief(o) {
  const { text, ...rest } = o;
  return rest;
}
