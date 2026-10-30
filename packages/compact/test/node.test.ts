// packages/compact/node: the packs of a compaction on disk. Each refusal is
// planted alone, in a temporary directory.
//
//   node scripts/test.mjs packages/compact --name node
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { IDX_TITLE, NAMES_CODEC } from "@domains/pack";
import { CompactError } from "../src/index.ts";
import { DirPartsSink, FileSink, fileDigest, openCopy } from "../node/index.ts";
import { memPack, nameRecords, keys } from "./helpers.ts";

async function inTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "compact-node-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("node: a FileSink holds one part number, and a file that exists is not written again", () =>
  inTmp(async (dir) => {
    const path = join(dir, "part.003");
    const sink = new FileSink(path);
    await sink.write(3, new Uint8Array([1, 2]));
    await assert.rejects(
      async () => sink.write(4, new Uint8Array([3])),
      (e: unknown) => e instanceof CompactError && e.code === "span" && /holds part 3, and part 4 was written to it/.test(e.message),
    );
    await sink.close();
    assert.deepEqual([...readFileSync(path)], [1, 2]);
    await assert.rejects(
      async () => new FileSink(path).write(3, new Uint8Array([9])),
      (e: unknown) => (e as { code?: string }).code === "EEXIST",
    );
    assert.deepEqual(await fileDigest(path), { digest: "sha256:a12871fee210fb8619291eaea194581cbd2531e4b23759d225f6806923f63222", size: 2 });
  }));

test("node: a DirPartsSink writes the parts in order, and refuses a number skipped", () =>
  inTmp(async (dir) => {
    const sink = new DirPartsSink(dir, "time");
    await sink.write(0, new Uint8Array([1]));
    await assert.rejects(
      async () => sink.write(2, new Uint8Array([2])),
      (e: unknown) => e instanceof CompactError && e.code === "usage" && /part 2 written after part 0/.test(e.message),
    );
    await sink.close();
    assert.deepEqual(sink.files, [join(dir, "time.part.000")]);
  }));

test("node: openCopy reads a pack of a directory, held to the sizes of its files", () =>
  inTmp(async (dir) => {
    const p = await memPack(nameRecords(keys(5, 30), 0, 298), NAMES_CODEC);
    for (const [i, bytes] of p.parts.entries()) writeFileSync(join(dir, `part.${String(i).padStart(3, "0")}`), bytes);
    await assert.rejects(
      async () => openCopy(dir, "key", NAMES_CODEC),
      (e: unknown) => e instanceof CompactError && e.code === "usage" && /holds no idx/.test(e.message),
    );
    writeFileSync(join(dir, IDX_TITLE), p.summary.idx);
    const opened = await openCopy(dir, "key", NAMES_CODEC);
    const keysRead: string[] = [];
    for await (const r of opened.reader.scan()) keysRead.push(r.key);
    await opened.close();
    assert.deepEqual(keysRead, keys(5, 30));
  }));
