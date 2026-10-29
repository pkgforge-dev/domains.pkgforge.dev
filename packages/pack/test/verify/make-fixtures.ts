// packages/pack/test/verify/make-fixtures.ts — writes the verifier's fixtures
// into this directory, every record synthetic (synthetic.ts):
//   clean.part.000, clean.idx     600 names (seed 18), 64 records a block, 4
//                                 entries a page: 10 blocks in 3 pages, one part
//   clean.annotations.json        that pack's annotations: packAnnotations, the
//                                 psl of the pinned list, its two sources, its span
//   truncated.part.000            the first half of the bytes of clean.part.000
//   pair.part.000, pair.idx       a pack of 2 names (seed 2)
//   registry.json                 a synthetic config/sources.json of the two sources
//
// The compressed bytes depend on the zlib build that wrote them (docs/format.md
// section 8). verify.test.ts holds the committed files to synthetic.ts by their
// decoded records and their SHA-256, which no zlib build changes, so a rebuild
// with another zlib changes no test.
//
// Usage: node packages/pack/test/verify/make-fixtures.ts
// Exit codes: 0 written · 1 a fixture did not write (the error is printed).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadPsl } from "@domains/names";
import { nodeCompress, writerId } from "../../node/index.ts";
import { MemorySink, NAMES_CODEC, type NameRecord, packAnnotations, writePack } from "../../src/index.ts";
import { VERIFY_ANNOTATIONS } from "../../src/verify.ts";
import { CLEAN_COUNT, CLEAN_SEED, PAGE_ENTRIES, PAIR_SEED, PSL_FILE, RECORDS_PER_BLOCK, SOURCES, SPAN, syntheticNames, syntheticRegistry } from "./synthetic.ts";

const DIR = import.meta.dirname;

async function write(records: NameRecord[]) {
  const sink = new MemorySink();
  const summary = await writePack(records, { codec: NAMES_CODEC, compress: nodeCompress, sink, recordsPerBlock: RECORDS_PER_BLOCK, pageEntries: PAGE_ENTRIES });
  const parts = sink.parts();
  if (parts.length !== 1) throw new Error(`a fixture pack has ${parts.length} parts, not 1`);
  return { summary, part: parts[0] };
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

async function main(): Promise<void> {
  const psl = await loadPsl(readFileSync(PSL_FILE));
  const clean = await write(syntheticNames(CLEAN_COUNT, CLEAN_SEED));
  writeFileSync(join(DIR, "clean.part.000"), clean.part);
  writeFileSync(join(DIR, "clean.idx"), clean.summary.idx);
  writeFileSync(
    join(DIR, "clean.annotations.json"),
    json({
      "org.opencontainers.image.description": "Synthetic: the clean pack of the verifier's tests (packages/pack/test/verify/make-fixtures.ts).",
      ...packAnnotations(clean.summary, writerId()),
      [VERIFY_ANNOTATIONS.psl]: psl.sha256,
      [VERIFY_ANNOTATIONS.source]: SOURCES.join(","),
      [VERIFY_ANNOTATIONS.spanStart]: SPAN.start,
      [VERIFY_ANNOTATIONS.spanEnd]: SPAN.end,
    }),
  );
  writeFileSync(join(DIR, "truncated.part.000"), clean.part.subarray(0, Math.floor(clean.part.length / 2)));
  const pair = await write(syntheticNames(2, PAIR_SEED));
  writeFileSync(join(DIR, "pair.part.000"), pair.part);
  writeFileSync(join(DIR, "pair.idx"), pair.summary.idx);
  writeFileSync(join(DIR, "registry.json"), json(syntheticRegistry()));
  console.log(`clean: ${clean.summary.records} records, ${clean.summary.blocks} blocks, ${clean.summary.bytes} B, sha256 ${clean.summary.sha256}`);
  console.log(`pair: ${pair.summary.records} records, ${pair.summary.bytes} B`);
}

try {
  await main();
} catch (error) {
  console.error(`make-fixtures: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
