// adapters/thc-ct/src/sorter.ts — an external merge sort of keys with web APIs
// alone, so it runs in a Worker as in Node (DOM-029, design D4). A THC day is
// 40 to 130 million lines; one Array.prototype.sort of every key would hold
// about 22 GB of strings for a September day [E, design M7].
//
//   const s = new RunSorter(runKeys);
//   s.add(key, flags);                 // at runKeys distinct keys: sort, fold, seal
//   if (s.pending > 2) await s.drain(2);
//   for await (const { key, flags } of s.finish()) ...   // ascending, one per key, flags ORed
//
// A run gathers distinct keys in a Map, their flags ORed. At runKeys keys it
// is sealed: its keys sorted with Array.prototype.sort, front-coded as
// [shared u8][rest length u8][flags u8][rest bytes] (a key is at most 253
// ASCII bytes, docs/architecture.md section 3.1, so each length fits a byte),
// and compressed with CompressionStream('deflate-raw') into one Uint8Array,
// off the JavaScript heap. The compression runs while the caller goes on;
// drain(n) waits until at most n seals are in flight. finish() seals the last
// run and merges every run with a binary heap over each run's decoder, folding
// equal keys across runs, its flags ORed. A decoder decodes one decompressed
// chunk at a time, so the heap awaits only when a run's batch runs out.
//
// The keys are ASCII ([a-z0-9_.-] after @domains/names), where `<` on strings
// is byte order. A key that is not ASCII, longer than 253, or flags outside 0
// to 255 is a RangeError: the caller's defect, never a record written wrong.
// A run that decodes to other keys than it sealed (a count or an order that
// differs) is an Error, so a fault of the codec never writes a pack.

export const MAX_KEY = 253;
// The slice fed to a decompressor at a time: what one read can make waits in
// memory, never a whole run.
const FEED_BYTES = 64 << 10;
const EMPTY = new Uint8Array(0);

// The shape both type sets (Node's and the Workers runtime's) give
// CompressionStream and DecompressionStream, as packages/pack/src/reader.ts names it.
interface ByteTransform {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<ArrayBuffer | ArrayBufferView>;
}

export interface Keyed {
  readonly key: string;
  readonly flags: number;
}

interface Sealed {
  readonly bytes: Uint8Array;
  readonly count: number;
}

// The bytes a stream's readable side gives, joined.
async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = readable.getReader();
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
    total += r.value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

// Writes `bytes` to a stream's writable side in slices, each awaited, then
// closes it. A failure of the stream reaches its readable side, which the
// caller reads, so the writer's own rejection is caught here.
function feed(writable: WritableStream<ArrayBuffer | ArrayBufferView>, bytes: Uint8Array): void {
  const w = writable.getWriter();
  const pump = async (): Promise<void> => {
    for (let at = 0; at < bytes.byteLength; at += FEED_BYTES) await w.write(bytes.subarray(at, at + FEED_BYTES));
    await w.close();
  };
  pump().catch(() => {
    // Deliberately empty: the same error rejects the readable side's read.
  });
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const cs: ByteTransform = new CompressionStream("deflate-raw");
  feed(cs.writable, raw);
  return collect(cs.readable);
}

// The front-coded bytes of sorted, distinct keys and their flags.
function frontCode(keys: readonly string[], flagsOf: ReadonlyMap<string, number>): Uint8Array {
  let buf = new Uint8Array(Math.max(1024, keys.length * 24));
  let at = 0;
  let prev = "";
  for (const k of keys) {
    const n = k.length;
    if (n === 0 || n > MAX_KEY) throw new RangeError(`RunSorter: a key of ${n} characters; a key is 1 to ${MAX_KEY}`);
    const m = Math.min(n, prev.length);
    let p = 0;
    while (p < m && prev.charCodeAt(p) === k.charCodeAt(p)) p += 1;
    const rest = n - p;
    if (at + 3 + rest > buf.length) {
      const grown = new Uint8Array(Math.max(buf.length * 2, at + 3 + rest));
      grown.set(buf.subarray(0, at));
      buf = grown;
    }
    buf[at] = p;
    buf[at + 1] = rest;
    buf[at + 2] = flagsOf.get(k)!;
    at += 3;
    for (let i = p; i < n; i++) {
      const c = k.charCodeAt(i);
      if (c > 0x7f) throw new RangeError(`RunSorter: the key ${JSON.stringify(k)} is not ASCII`);
      buf[at++] = c;
    }
    prev = k;
  }
  return buf.slice(0, at);
}

// One sealed run, decoded a decompressed chunk at a time.
class RunReader {
  keys: string[] = [];
  flags: number[] = [];
  at = 0;
  read = 0;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly run: Sealed;
  private readonly index: number;
  private carry: Uint8Array = EMPTY;
  private prev = "";

  constructor(run: Sealed, index: number) {
    this.run = run;
    this.index = index;
    const ds: ByteTransform = new DecompressionStream("deflate-raw");
    feed(ds.writable, run.bytes);
    this.reader = ds.readable.getReader();
  }

  get key(): string {
    return this.keys[this.at]!;
  }

  // The next batch: true when it holds a key, false at the run's end.
  async fill(): Promise<boolean> {
    this.keys = [];
    this.flags = [];
    this.at = 0;
    for (;;) {
      const r = await this.reader.read();
      if (r.done) {
        if (this.carry.byteLength > 0) throw new Error(`RunSorter: run ${this.index} ends inside a record`);
        if (this.read !== this.run.count) throw new Error(`RunSorter: run ${this.index} decodes to ${this.read} keys; it sealed ${this.run.count}`);
        return false;
      }
      this.parse(r.value);
      if (this.keys.length > 0) return true;
    }
  }

  private parse(chunk: Uint8Array): void {
    let b = chunk;
    if (this.carry.byteLength > 0) {
      b = new Uint8Array(this.carry.byteLength + chunk.byteLength);
      b.set(this.carry);
      b.set(chunk, this.carry.byteLength);
    }
    let at = 0;
    let prev = this.prev;
    while (at + 3 <= b.byteLength) {
      const shared = b[at]!;
      const rest = b[at + 1]!;
      if (at + 3 + rest > b.byteLength) break;
      const k = prev.slice(0, shared) + String.fromCharCode.apply(null, b.subarray(at + 3, at + 3 + rest) as unknown as number[]);
      if (shared > prev.length || k <= prev) throw new Error(`RunSorter: run ${this.index} decodes ${JSON.stringify(k)} after ${JSON.stringify(prev)}`);
      this.keys.push(k);
      this.flags.push(b[at + 2]!);
      prev = k;
      at += 3 + rest;
    }
    this.read += this.keys.length;
    this.prev = prev;
    this.carry = at === b.byteLength ? EMPTY : b.slice(at);
  }
}

export class RunSorter {
  private readonly runKeys: number;
  private gathering = new Map<string, number>();
  private readonly sealed: (Sealed | null)[] = [];
  private readonly inFlight = new Set<Promise<void>>();
  private failure: { readonly error: unknown } | null = null;
  private stored = 0;
  private finished = false;

  constructor(runKeys: number) {
    if (!Number.isSafeInteger(runKeys) || runKeys < 1) throw new RangeError(`RunSorter: runKeys ${runKeys} is not a whole number from 1`);
    this.runKeys = runKeys;
  }

  add(key: string, flags: number): void {
    if (this.finished) throw new Error("RunSorter: add after finish");
    if (!Number.isInteger(flags) || flags < 0 || flags > 255) throw new RangeError(`RunSorter: flags ${flags} are not 0 to 255`);
    const m = this.gathering;
    const was = m.get(key);
    m.set(key, was === undefined ? flags : was | flags);
    if (m.size >= this.runKeys) this.seal();
  }

  // The seals still compressing.
  get pending(): number {
    return this.inFlight.size;
  }

  // The runs sealed so far, and their compressed bytes once each finished.
  get runs(): number {
    return this.sealed.length;
  }

  get storedBytes(): number {
    return this.stored;
  }

  // Waits until at most maxInFlight seals are compressing; a seal that failed throws here.
  async drain(maxInFlight = 2): Promise<void> {
    while (this.inFlight.size > maxInFlight) await Promise.race(this.inFlight);
    if (this.failure !== null) throw this.failure.error;
  }

  private seal(): void {
    const m = this.gathering;
    this.gathering = new Map();
    const keys = [...m.keys()].sort();
    const raw = frontCode(keys, m);
    const slot = this.sealed.length;
    this.sealed.push(null);
    const done: Promise<void> = deflate(raw).then(
      (bytes) => {
        this.sealed[slot] = { bytes, count: keys.length };
        this.stored += bytes.byteLength;
        this.inFlight.delete(done);
      },
      (error: unknown) => {
        this.failure ??= { error };
        this.inFlight.delete(done);
      },
    );
    this.inFlight.add(done);
  }

  // Every key added, ascending, once, its flags the OR of every add.
  async *finish(): AsyncGenerator<Keyed, void, undefined> {
    if (this.finished) throw new Error("RunSorter: finish called twice");
    this.finished = true;
    if (this.gathering.size > 0) this.seal();
    await this.drain(0);
    const heap: RunReader[] = [];
    for (let i = 0; i < this.sealed.length; i++) {
      const r = new RunReader(this.sealed[i]!, i);
      // A reader holds its run's bytes until its feed ends.
      this.sealed[i] = null;
      if (await r.fill()) heap.push(r);
    }
    for (let i = (heap.length >> 1) - 1; i >= 0; i--) siftDown(heap, i);
    let last: string | null = null;
    while (heap.length > 0) {
      const top = heap[0]!;
      const key = top.key;
      let flags = top.flags[top.at]!;
      await advance(heap);
      while (heap.length > 0 && heap[0]!.key === key) {
        flags |= heap[0]!.flags[heap[0]!.at]!;
        await advance(heap);
      }
      if (last !== null && key <= last) throw new Error(`RunSorter: the merge gives ${JSON.stringify(key)} after ${JSON.stringify(last)}`);
      last = key;
      yield { key, flags };
    }
  }
}

// Moves the top reader past its key and restores the heap.
async function advance(heap: RunReader[]): Promise<void> {
  const top = heap[0]!;
  top.at += 1;
  if (top.at >= top.keys.length && !(await top.fill())) {
    const tail = heap.pop()!;
    if (heap.length === 0) return;
    heap[0] = tail;
  }
  siftDown(heap, 0);
}

function siftDown(heap: RunReader[], from: number): void {
  const n = heap.length;
  let i = from;
  for (;;) {
    const l = 2 * i + 1;
    const r = l + 1;
    let m = i;
    if (l < n && heap[l]!.key < heap[m]!.key) m = l;
    if (r < n && heap[r]!.key < heap[m]!.key) m = r;
    if (m === i) return;
    const t = heap[i]!;
    heap[i] = heap[m]!;
    heap[m] = t;
    i = m;
  }
}
