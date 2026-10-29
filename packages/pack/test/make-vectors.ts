// packages/pack/test/make-vectors.ts — writes the three test vectors of
// docs/format.md into packages/pack/test/vectors/.
//
//   node packages/pack/test/make-vectors.ts          writes the vector files
//   node packages/pack/test/make-vectors.ts --check  writes nothing; exit 1 when a file differs
//
// Each vector holds its input records, the settings of the writer, the raw
// blocks as hex, the zlib-independent fields of each block entry, the SHA-256
// of the raw blocks, and the parts and the index as this writer wrote them,
// with the Node and zlib versions that wrote them. The raw blocks are taken
// from the written parts with node:zlib's inflateRawSync, not with the
// package's reader, so vectors.test.ts compares the reader with another
// decoder. The records are synthetic: the names and the times were chosen
// for the cases each vector holds, and no source observed them.
//
// The vectors are frozen bytes: run this when docs/format.md changes, which is
// a new version of the format, and never to make a failing test pass.
//
// Exit codes: 0 written, or equal with --check · 1 a file differs (--check) · 2 could not run.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { nodeCompress, writerId } from "../node/index.ts";
import { hex32, MemorySink, NAMES_CODEC, type NameRecord, toHex, writePack } from "../src/index.ts";

export const VECTOR_FORMAT = "domains.pack.vector.v1";
export const VECTOR_DIR = join(import.meta.dirname, "vectors");

export interface VectorSpec {
  readonly file: string;
  readonly title: string;
  readonly recordsPerBlock: number;
  readonly pageEntries: number;
  readonly records: readonly NameRecord[];
}

// 2026-10-26 is day 298 since 2026-01-01; its first second is 298 * 86,400.
const DAY = 298;
const SECOND = DAY * 86_400;

export const SPECS: readonly VectorSpec[] = [
  {
    file: "names-one-source.json",
    title: "three names, one day source; one block (the worked example of docs/format.md section 12)",
    recordsPerBlock: 4096,
    pageEntries: 64,
    records: [
      { key: "com.example", flags: 1, sources: [{ bit: 0, first: DAY, last: DAY }] },
      { key: "com.example.api", flags: 1, sources: [{ bit: 0, first: DAY, last: DAY }] },
      { key: "com.example.www", flags: 1, sources: [{ bit: 0, first: DAY, last: DAY }] },
    ],
  },
  {
    file: "names-flags.json",
    title: "the flags: exact, wildcard and both; two blocks of two, so front coding starts again in the second",
    recordsPerBlock: 2,
    pageEntries: 64,
    records: [
      { key: "net.example", flags: 1, sources: [{ bit: 0, first: DAY - 1, last: DAY }] },
      { key: "net.example.cdn", flags: 2, sources: [{ bit: 0, first: DAY, last: DAY }] },
      { key: "net.example.mail", flags: 3, sources: [{ bit: 0, first: DAY, last: DAY }] },
      { key: "org.example", flags: 1, sources: [{ bit: 0, first: DAY, last: DAY }] },
    ],
  },
  {
    file: "names-two-sources.json",
    title: "two sources, bit 0 by day and bit 9 by second; three blocks of two on two index pages of two",
    recordsPerBlock: 2,
    pageEntries: 2,
    records: [
      { key: "de.example", flags: 1, sources: [{ bit: 0, first: DAY - 3, last: DAY }] },
      { key: "de.example.shop", flags: 1, sources: [{ bit: 9, first: SECOND + 3_661, last: SECOND + 3_661 }] },
      {
        key: "de.example.www",
        flags: 3,
        sources: [
          { bit: 0, first: DAY, last: DAY },
          { bit: 9, first: SECOND + 120, last: SECOND + 86_399 },
        ],
      },
      { key: "np.com.example", flags: 1, sources: [{ bit: 9, first: SECOND, last: SECOND + 1 }] },
      {
        key: "np.com.example.api",
        flags: 1,
        sources: [
          { bit: 0, first: DAY - 30, last: DAY - 2 },
          { bit: 9, first: SECOND - 30 * 86_400, last: SECOND - 2 * 86_400 },
        ],
      },
    ],
  },
];

export interface VectorBlock {
  readonly key: string;
  readonly part: number;
  readonly raw: number;
  readonly records: number;
  readonly crc32: string;
}

export interface Vector {
  readonly format: string;
  readonly title: string;
  readonly synthetic: string;
  readonly dataset: number;
  readonly codec: number;
  readonly records_per_block: number;
  readonly page_entries: number;
  readonly records: readonly NameRecord[];
  readonly raw_blocks: readonly string[];
  readonly blocks: readonly VectorBlock[];
  readonly sha256: string;
  readonly written_by: string;
  readonly parts: readonly string[];
  readonly idx: string;
}

export async function makeVector(spec: VectorSpec): Promise<Vector> {
  const sink = new MemorySink();
  const summary = await writePack(spec.records, { codec: NAMES_CODEC, compress: nodeCompress, sink, recordsPerBlock: spec.recordsPerBlock, pageEntries: spec.pageEntries });
  const parts = sink.parts();
  const raw = summary.entries.map((e) => inflateRawSync(parts[e.part].subarray(e.offset, e.offset + e.packed)));
  return {
    format: VECTOR_FORMAT,
    title: spec.title,
    synthetic: "The names and times are synthetic, chosen for the cases this vector holds; no source observed them.",
    dataset: summary.dataset,
    codec: summary.codec,
    records_per_block: summary.recordsPerBlock,
    page_entries: summary.pageEntries,
    records: spec.records,
    raw_blocks: raw.map((r) => toHex(r)),
    blocks: summary.entries.map((e) => ({ key: e.key, part: e.part, raw: e.raw, records: e.records, crc32: hex32(e.crc) })),
    sha256: createHash("sha256").update(Buffer.concat(raw)).digest("hex"),
    written_by: writerId(),
    parts: parts.map((p) => toHex(p)),
    idx: toHex(summary.idx),
  };
}

export const vectorText = (v: Vector): string => `${JSON.stringify(v, null, 2)}\n`;

if (import.meta.main) {
  const check = process.argv.includes("--check");
  try {
    let differ = 0;
    for (const spec of SPECS) {
      const path = join(VECTOR_DIR, spec.file);
      const text = vectorText(await makeVector(spec));
      if (check) {
        if (!existsSync(path) || readFileSync(path, "utf8") !== text) {
          console.error(`differs: ${path}`);
          differ += 1;
        }
      } else writeFileSync(path, text);
    }
    if (!check) console.log(`wrote ${SPECS.length} vectors to ${VECTOR_DIR}`);
    process.exit(differ > 0 ? 1 : 0);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}
