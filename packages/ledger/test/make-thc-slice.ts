// packages/ledger/test/make-thc-slice.ts — writes test/fixtures/thc-slice.json,
// the measured input of replay.test.ts: the first lines of several THC day
// files, exactly as published.
//
// TODO/storage.md, DOM-021's Found of DOM-009: DOM-009's per-day artifacts hold
// 1 hash in 16 and no name, and expire after a day, so the replay reads this
// slice instead. Each day is the start of the day's gzip file read by Range
// from offset 0 (206), decompressed up to the cut; the last line, which the cut
// may split, is dropped, and the first `lines` complete lines are kept verbatim:
// no normalisation, no sort, upper case and `*.` as the file has them. A THC
// file's lines run in name order from `0`, so the slices of two days cover
// overlapping name ranges and share domains.
//
// Usage: node packages/ledger/test/make-thc-slice.ts MANIFEST.json OUT.json
// MANIFEST.json: { "lines": N, "days": [{ "day", "file", "url", "range", "read",
// "status", "content_range", "last_modified", "etag" }] }, `file` being the
// bytes the Range read saved. The manifest's fields go into OUT.json beside the
// lines, with the SHA-256 of each file.
// Exit codes: 0 written · 2 usage, or a file that is not a gzip prefix of UTF-8
// text holding N complete lines.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { constants, gunzipSync } from "node:zlib";

export const FORMAT = "domains.test.thc-slice.v1";

interface ManifestDay {
  readonly day: string;
  readonly file: string;
  readonly url: string;
  readonly range: string;
  readonly read: string;
  readonly status: number;
  readonly content_range: string;
  readonly last_modified: string;
  readonly etag: string;
}

// The complete lines of the gzip prefix `bytes`: decompressed up to the cut,
// decoded as UTF-8 (refused when it is not), the last, possibly cut, line dropped.
export function linesOfPrefix(bytes: Uint8Array): string[] {
  const raw = gunzipSync(bytes, { finishFlush: constants.Z_SYNC_FLUSH });
  const lines = raw.toString("utf8").split("\n");
  // A cut can split a UTF-8 sequence only in the dropped last line.
  new TextDecoder("utf-8", { fatal: true }).decode(raw.subarray(0, raw.lastIndexOf(10) + 1));
  lines.pop();
  return lines;
}

function main(argv: readonly string[]): number {
  if (argv.length !== 2) {
    console.error("usage: node packages/ledger/test/make-thc-slice.ts MANIFEST.json OUT.json");
    return 2;
  }
  const manifest = JSON.parse(readFileSync(argv[0], "utf8")) as { lines: number; days: ManifestDay[] };
  const days = manifest.days.map((d) => {
    const bytes = readFileSync(d.file);
    const lines = linesOfPrefix(bytes);
    if (lines.length < manifest.lines) throw new Error(`${d.day}: ${lines.length} complete lines, fewer than ${manifest.lines}`);
    const { file: _file, ...provenance } = d;
    return { ...provenance, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), complete_lines: lines.length, lines: lines.slice(0, manifest.lines) };
  });
  const out = {
    format: FORMAT,
    measured: true,
    what: `The first ${manifest.lines} complete lines of THC's daily CT name dump for each day below, as published: the start of the gzip file read by HTTP Range from offset 0 with the contact User-Agent of scripts/lib/user-agent.mjs, decompressed up to the cut. A measured slice, not synthetic. Written by packages/ledger/test/make-thc-slice.ts.`,
    lines_a_day: manifest.lines,
    days,
  };
  writeFileSync(argv[1], `${JSON.stringify(out, null, 1)}\n`);
  return 0;
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`make-thc-slice: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 2;
  }
}
