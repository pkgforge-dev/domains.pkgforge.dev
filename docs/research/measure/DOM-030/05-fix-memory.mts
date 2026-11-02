// DOM-030 instrument, copied from .tmp/dom030/fix-memory.mts as it ran, with its import and
// output paths moved to docs/research/measure/DOM-030/. Run from the
// repository root.
// scratch (DOM-030 fix of F2): heap held by one decoded block of 8,192 records,
// the Worker's new bound on recordsPerBlock, at the shapes that amplified most
// in the door sweep (long keys that share a prefix). Node, --expose-gc.
//   node --expose-gc docs/research/measure/DOM-030/05-fix-memory.mts
import { bytesSource, DOMAINS_CODEC, FEED_CODEC, MemorySink, NAMES_CODEC, PackReader, writePack, type DomainRecord, type FeedRecord, type NameRecord } from "../../../../packages/pack/src/index.ts";
import { nodeCompress } from "../../../../packages/pack/node/index.ts";

const gc = (globalThis as unknown as { gc?: () => void }).gc;
if (gc === undefined) throw new Error("run with --expose-gc");
const MIB = 1024 * 1024;
const N = 8192;
const seen = [{ bit: 0, first: 1000, last: 1000 }];

function letters(seed: number, n: number): string {
  let x = seed >>> 0;
  let out = "";
  for (let i = 0; i < n; i += 1) {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
    out += String.fromCharCode(97 + ((x >>> 27) % 26));
  }
  return out;
}

async function measure(label: string, codec: unknown, records: unknown[]): Promise<void> {
  const sink = new MemorySink();
  // biome-ignore lint/suspicious/noExplicitAny: scratch
  const summary = await writePack(records as any, { codec: codec as any, compress: nodeCompress, sink, recordsPerBlock: N });
  const e = summary.entries[0]!;
  const parts = sink.parts();
  const part = parts[0]!;
  const src = { read: async (_p: number, off: number, len: number) => part.slice(off, off + len) };
  const reader = await PackReader.open(bytesSource(summary.idx), src, undefined, { partSizes: parts.map((p) => p.byteLength), maxRawBlockBytes: MIB });
  const entry = await reader.index.entry(0);
  gc();
  await new Promise((r) => setTimeout(r, 50));
  gc();
  const before = process.memoryUsage();
  const raw = await reader.readBlock(entry);
  const decoded = reader.decodeBlock(raw, entry);
  gc();
  const after = process.memoryUsage();
  const heap = after.heapUsed - before.heapUsed;
  const ab = after.arrayBuffers - before.arrayBuffers;
  if (decoded.length !== e.records) throw new Error("count");
  console.log(`${label.padEnd(40)} records ${e.records} raw ${e.raw} B -> retained ${(heap / MIB).toFixed(2)} MiB heap + ${(ab / MIB).toFixed(2)} MiB buffers; x6 = ${((6 * (heap + ab)) / MIB).toFixed(1)} MiB`);
}

const PREFIX = `a.${letters(7, 239)}.`;
const key = (i: number): string => `${PREFIX}${i.toString(36).padStart(4, "0")}`;
await measure("names: 8,192 keys 245 B, shared prefix", NAMES_CODEC, Array.from({ length: N }, (_, i): NameRecord => ({ key: key(i), flags: 1, sources: seen })));
await measure("domains: 8,192 keys 245 B + 5 evidence", DOMAINS_CODEC, Array.from({ length: N }, (_, i): DomainRecord => ({ key: key(i), flags: 1, sources: seen, evidence: Array.from({ length: 5 }, (_, b) => ({ tier: [1, 1, 2, 2, 3][b]!, basis: b, source: 0, at: 1, confidence: 1 })) })));
await measure("feed: 8,192 keys 245 B", FEED_CODEC, Array.from({ length: N }, (_, i): FeedRecord => ({ key: key(i), flags: 1, firstSeen: 1000 + i, sources: [0], basis: 0, confidence: 0, feedFlags: 0 })));
// domains near the raw bound: 8,192 records, each with enough evidence to bring the block close to 1 MiB raw.
for (const per of [6, 12]) {
  await measure(`domains: 8,192 keys + ${per} evidence`, DOMAINS_CODEC, Array.from({ length: N }, (_, i): DomainRecord => ({ key: key(i), flags: 1, sources: seen, evidence: Array.from({ length: per }, (_, b) => ({ tier: 1, basis: 0, source: b, at: 1_767_225_600 + b, confidence: b % 11 })) })));
}
