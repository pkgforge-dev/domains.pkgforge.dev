// @domains/compact/node — the packs of a compaction on disk, for the CLIs of
// scripts/compact/. It sits outside src/, so no Worker imports node:fs.
//
//   const pack = await openCopy(dir, "key", NAMES_CODEC)    idx and part.NNN of a directory, as a PackReader
//   const time = await openCopy(dir, "time", FEED_TIME_CODEC)   time.idx and time.part.NNN of the same directory
//   const sink = new FileSink(path)                          one part, written to one new file
//   const { digest, size } = await fileDigest(path)          the OCI digest of a file, read in chunks
//
// A directory holds a pack as its layers are titled (docs/format.md section 2):
// `idx` and `part.000` up, and its time copy `time.idx` and `time.part.000`
// up, as `oras pull` names the files of a manifest. Each file is read by range
// through its own handle, never whole, and a range a file does not hold
// answers short, which the reader refuses (short-read).
//
// ⚠ readAt repeats the private one of packages/pack/node/index.ts and readAt of
// scripts/verify-pack.mjs (TODO/storage.md DOM-023, the Found of
// 2026-10-29T15:30Z): openPackFiles there reads `idx` and `part.NNN` alone,
// and a time copy's files carry the prefix `time.`.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { type DatasetCodec, IDX_TITLE, type Idx, PackError, PackReader, type PackSink, partTitle, type RangeSource, readIdx, TIME_IDX_TITLE, timePartTitle } from "@domains/pack";
import { CompactError } from "../src/errors.ts";

export type Copy = "key" | "time";

export const titlesOf = (copy: Copy): { readonly idx: string; readonly part: (n: number) => string } =>
  copy === "key" ? { idx: IDX_TITLE, part: partTitle } : { idx: TIME_IDX_TITLE, part: timePartTitle };

interface OpenFile {
  readonly handle: FileHandle;
  readonly size: number;
}

async function readAt(file: OpenFile, offset: number, length: number): Promise<Uint8Array> {
  const n = Math.max(0, Math.min(length, file.size - offset));
  const out = new Uint8Array(n);
  let at = 0;
  while (at < n) {
    const { bytesRead } = await file.handle.read(out, at, n - at, offset + at);
    if (bytesRead === 0) break;
    at += bytesRead;
  }
  return out.subarray(0, at);
}

export interface OpenedCopy<R> {
  readonly reader: PackReader<R>;
  readonly idxBytes: Uint8Array;
  readonly partSizes: readonly number[];
  readonly parts: RangeSource;
  close(): Promise<void>;
}

// True when `dir` holds the index of `copy`.
export const hasCopy = (dir: string, copy: Copy): boolean => readdirSync(dir).includes(titlesOf(copy).idx);

// The pack of `copy` in `dir`: its index read whole, its parts by range, the
// part sizes the files hold given to the reader (partSizes), so no read
// trusts a length only the index claims.
export async function openCopy<R>(dir: string, copy: Copy, codec: DatasetCodec<R>): Promise<OpenedCopy<R>> {
  const titles = titlesOf(copy);
  const names = new Set(readdirSync(dir));
  if (!names.has(titles.idx)) throw new CompactError("usage", `${dir} holds no ${titles.idx}`);
  const idxBytes = new Uint8Array(readFileSync(join(dir, titles.idx)));
  const partSizes: number[] = [];
  while (names.has(titles.part(partSizes.length))) partSizes.push(statSync(join(dir, titles.part(partSizes.length))).size);
  const files = new Map<number, OpenFile>();
  const parts: RangeSource = {
    read: async (part, offset, length) => {
      let file = files.get(part);
      if (file === undefined) {
        const title = titles.part(part);
        if (!names.has(title)) throw new PackError("short-read", `${dir} holds no ${title}`);
        const handle = await open(join(dir, title), "r");
        file = { handle, size: (await handle.stat()).size };
        files.set(part, file);
      }
      return readAt(file, offset, length);
    },
  };
  const reader = await PackReader.open(idxBytes, parts, codec, { partSizes });
  return {
    reader,
    idxBytes,
    partSizes,
    parts,
    close: async () => {
      await Promise.all([...files.values()].map((f) => f.handle.close()));
      files.clear();
    },
  };
}

// An index file read whole and checked (readIdx of @domains/pack).
export const readIdxFile = (path: string): Idx => readIdx(new Uint8Array(readFileSync(path)));

// A RangeSource over part files that sit apart, by part number.
export function filesSource(paths: readonly string[]): { readonly source: RangeSource; readonly sizes: readonly number[]; close(): Promise<void> } {
  const sizes = paths.map((p) => statSync(p).size);
  const files = new Map<number, OpenFile>();
  return {
    sizes,
    source: {
      read: async (part, offset, length) => {
        const path = paths[part];
        if (path === undefined) throw new PackError("short-read", `no file holds part ${part}`);
        let file = files.get(part);
        if (file === undefined) {
          const handle = await open(path, "r");
          file = { handle, size: (await handle.stat()).size };
          files.set(part, file);
        }
        return readAt(file, offset, length);
      },
    },
    close: async () => {
      await Promise.all([...files.values()].map((f) => f.handle.close()));
      files.clear();
    },
  };
}

// One part, written to one new file (flag "wx": a part is written once). The
// writer's part number is held: a second number is refused.
export class FileSink implements PackSink {
  readonly path: string;
  #part: number | null = null;
  #handle: FileHandle | null = null;
  #bytes = 0;

  constructor(path: string) {
    this.path = path;
  }

  get bytes(): number {
    return this.#bytes;
  }

  async write(part: number, bytes: Uint8Array): Promise<void> {
    if (this.#part !== null && part !== this.#part) throw new CompactError("span", `${this.path} holds part ${this.#part}, and part ${part} was written to it`);
    if (this.#handle === null) {
      this.#part = part;
      this.#handle = await open(this.path, "wx");
    }
    let at = 0;
    while (at < bytes.length) {
      const { bytesWritten } = await this.#handle.write(bytes, at, bytes.length - at);
      at += bytesWritten;
    }
    this.#bytes += bytes.length;
  }

  async close(): Promise<void> {
    const h = this.#handle;
    this.#handle = null;
    if (h !== null) await h.close();
  }
}

// Each part to a file of its own in `dir`, titled by `copy` (part.NNN or
// time.part.NNN), in part order; every file new.
export class DirPartsSink implements PackSink {
  readonly dir: string;
  readonly copy: Copy;
  readonly files: string[] = [];
  #sink: FileSink | null = null;
  #part = -1;

  constructor(dir: string, copy: Copy) {
    this.dir = dir;
    this.copy = copy;
  }

  async write(part: number, bytes: Uint8Array): Promise<void> {
    if (part !== this.#part) {
      if (part !== this.#part + 1) throw new CompactError("usage", `part ${part} written after part ${this.#part}`);
      await this.close();
      const path = join(this.dir, titlesOf(this.copy).part(part));
      this.#sink = new FileSink(path);
      this.files.push(path);
      this.#part = part;
    }
    await (this.#sink as FileSink).write(part, bytes);
  }

  async close(): Promise<void> {
    const s = this.#sink;
    this.#sink = null;
    if (s !== null) await s.close();
  }
}

// The OCI digest and size of a file, read in chunks of 4 MiB.
export async function fileDigest(path: string): Promise<{ readonly digest: string; readonly size: number }> {
  const handle = await open(path, "r");
  try {
    const hash = createHash("sha256");
    const chunk = new Uint8Array(4 * 1024 * 1024);
    let size = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, size);
      if (bytesRead === 0) break;
      hash.update(chunk.subarray(0, bytesRead));
      size += bytesRead;
    }
    return { digest: `sha256:${hash.digest("hex")}`, size };
  } finally {
    await handle.close();
  }
}
