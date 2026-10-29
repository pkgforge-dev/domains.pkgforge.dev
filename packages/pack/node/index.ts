// @domains/pack/node — the Node side of the pack format: the production
// compressor and the files of a pack on disk. It sits outside src/ so that no
// Worker imports node:zlib or node:fs (tsconfig.worker.json reads
// packages/*/src only).
//
//   nodeCompress                 node:zlib at level 9, each block decompressed and compared before it is kept
//   writerId()                   the value of the annotation dev.pkgforge.domains.writer
//   writePackFiles(records, dir, options)   part.000 and up, then idx, into a new directory
//   openPackFiles(dir)           the idx ByteSource and the parts RangeSource of such a directory
//
// ⚠ Node's zlib output is the same bytes only for one zlib build (TODO/storage.md,
// DOM-017's premise); .node-version pins the build in CI. The identity of a pack
// is the SHA-256 of its raw blocks, which no zlib build changes.
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync, gunzipSync, gzipSync, inflateRawSync } from "node:zlib";
import {
  type ByteSource,
  CODEC_DEFLATE_RAW,
  CODEC_GZIP,
  type Compress,
  IDX_TITLE,
  PackError,
  type PackSink,
  type PackSummary,
  packAnnotations,
  partTitle,
  type RangeSource,
  type WriterOptions,
  writePack,
} from "../src/index.ts";

// The level of every block this writer compresses; memory level, window and
// strategy are zlib's defaults.
export const WRITER_LEVEL = 9;

const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && Buffer.compare(a, b) === 0;

// Compresses a raw block with node:zlib at level 9, then decompresses the
// result and refuses it unless it gives the raw block back byte for byte.
export const nodeCompress: Compress = (codec, raw) => {
  let packed: Buffer;
  let back: Buffer;
  if (codec === CODEC_DEFLATE_RAW) {
    packed = deflateRawSync(raw, { level: WRITER_LEVEL });
    back = inflateRawSync(packed);
  } else if (codec === CODEC_GZIP) {
    packed = gzipSync(raw, { level: WRITER_LEVEL });
    back = gunzipSync(packed);
  } else throw new PackError("codec", `nodeCompress: codec ${codec} is not 1 (deflate-raw) or 2 (gzip)`);
  if (!sameBytes(back, raw)) throw new PackError("inflate", `nodeCompress: a block of ${raw.length} B did not decompress to itself`);
  return new Uint8Array(packed.buffer, packed.byteOffset, packed.byteLength);
};

export const writerId = (): string => `node ${process.version}, zlib ${process.versions.zlib}`;

// Writes the parts of a pack as files part.000 and up in `dir`. A file that
// exists is refused (flag "wx"): a pack is written once, into a new directory.
export class DirSink implements PackSink {
  readonly dir: string;
  readonly files: string[] = [];
  #handle: FileHandle | null = null;
  #part = -1;

  constructor(dir: string) {
    this.dir = dir;
  }

  async write(part: number, bytes: Uint8Array): Promise<void> {
    if (part !== this.#part) {
      if (part !== this.#part + 1) throw new PackError("usage", `part ${part} written after part ${this.#part}`);
      await this.close();
      const path = join(this.dir, partTitle(part));
      this.#handle = await open(path, "wx");
      this.files.push(path);
      this.#part = part;
    }
    const handle = this.#handle;
    if (handle === null) throw new PackError("usage", "the sink is closed");
    let at = 0;
    while (at < bytes.length) {
      const { bytesWritten } = await handle.write(bytes, at, bytes.length - at);
      at += bytesWritten;
    }
  }

  async close(): Promise<void> {
    const handle = this.#handle;
    this.#handle = null;
    if (handle !== null) await handle.close();
  }
}

export interface WrittenPack {
  readonly summary: PackSummary;
  // The part files in order, then the idx file.
  readonly files: readonly string[];
  readonly annotations: Record<string, string>;
}

// Writes a pack into `dir`, which must not hold a pack already: the parts
// first, then `idx` last, so a directory with an idx file holds a whole pack.
export async function writePackFiles<R>(records: Iterable<R> | AsyncIterable<R>, dir: string, options: Omit<WriterOptions<R>, "sink" | "compress"> & { compress?: Compress }): Promise<WrittenPack> {
  mkdirSync(dir, { recursive: true });
  const sink = new DirSink(dir);
  let summary: PackSummary;
  try {
    summary = await writePack(records, { ...options, compress: options.compress ?? nodeCompress, sink });
  } finally {
    await sink.close();
  }
  const idxPath = join(dir, IDX_TITLE);
  const handle = await open(idxPath, "wx");
  try {
    await handle.writeFile(summary.idx);
  } finally {
    await handle.close();
  }
  for (const [i, path] of sink.files.entries()) {
    const size = statSync(path).size;
    if (size !== summary.parts[i].bytes) throw new PackError("short-read", `${path} holds ${size} B, the index says ${summary.parts[i].bytes} B`);
  }
  return { summary, files: [...sink.files, idxPath], annotations: packAnnotations(summary, writerId()) };
}

export interface PackFiles {
  readonly idx: ByteSource;
  readonly parts: RangeSource;
  // The bytes of part.000 and up, in order, as the directory holds them: the
  // partSizes of PackIndex.open and PackReader.open.
  readonly partSizes: readonly number[];
  close(): Promise<void>;
}

interface OpenFile {
  readonly handle: FileHandle;
  readonly size: number;
}

// The bytes [offset, offset + length) of a file, cut at its end. The buffer is
// the size of what the file holds, never of what was asked, so a length that
// only an index claims allocates nothing past the file. A file shorter than
// the range answers what it holds; the reader refuses the short answer
// ("short-read").
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

async function openFile(path: string): Promise<OpenFile> {
  const handle = await open(path, "r");
  return { handle, size: (await handle.stat()).size };
}

// The index and the parts of a pack written by writePackFiles, or of any
// directory that holds `idx` and part.000 and up.
export async function openPackFiles(dir: string): Promise<PackFiles> {
  const names = new Set(readdirSync(dir));
  if (!names.has(IDX_TITLE)) throw new PackError("usage", `${dir} holds no ${IDX_TITLE}`);
  const partSizes: number[] = [];
  while (names.has(partTitle(partSizes.length))) partSizes.push(statSync(join(dir, partTitle(partSizes.length))).size);
  const files = new Map<number, OpenFile>();
  const idxFile = await openFile(join(dir, IDX_TITLE));
  const idx: ByteSource = { size: idxFile.size, read: (offset, length) => readAt(idxFile, offset, length) };
  const parts: RangeSource = {
    read: async (part, offset, length) => {
      let file = files.get(part);
      if (file === undefined) {
        const title = partTitle(part);
        if (!names.has(title)) throw new PackError("short-read", `${dir} holds no ${title}`);
        file = await openFile(join(dir, title));
        files.set(part, file);
      }
      return readAt(file, offset, length);
    },
  };
  return {
    idx,
    parts,
    partSizes,
    close: async () => {
      await Promise.all([idxFile, ...files.values()].map((f) => f.handle.close()));
      files.clear();
    },
  };
}
