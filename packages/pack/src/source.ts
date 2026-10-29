// packages/pack/src/source.ts — where a reader gets bytes. A ByteSource is one
// object read by range (the index layer); a RangeSource is the parts of a pack
// read by range. In a Worker both are GHCR blobs behind signed URLs or R2
// objects; in Node they are files (packages/pack/node) or arrays.
//
// ⚠ A source may answer a range with fewer bytes than asked (a cut file, a
// short HTTP body). readExact and readPart count what arrived and refuse any
// other length with "short-read": a declared length is never trusted.
import { PackError } from "./errors.ts";

export interface ByteSource {
  // The bytes of the whole object.
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface RangeSource {
  read(part: number, offset: number, length: number): Promise<Uint8Array>;
}

export async function readExact(source: ByteSource, offset: number, length: number, what: string): Promise<Uint8Array> {
  const bytes = await source.read(offset, length);
  if (bytes.length !== length) throw new PackError("short-read", `${what}: asked ${length} B at ${offset}, the source answered ${bytes.length} B`);
  return bytes;
}

export async function readPart(source: RangeSource, part: number, offset: number, length: number, what: string): Promise<Uint8Array> {
  const bytes = await source.read(part, offset, length);
  if (bytes.length !== length) throw new PackError("short-read", `${what}: asked ${length} B at ${offset} of part ${part}, the source answered ${bytes.length} B`);
  return bytes;
}

// A ByteSource over an array held in memory. A range past the end answers the
// bytes that exist, as a cut object does.
export function bytesSource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    read: async (offset, length) => bytes.subarray(offset, offset + length),
  };
}

// A RangeSource over the parts of a pack held in memory.
export function partsSource(parts: readonly Uint8Array[]): RangeSource {
  return {
    read: async (part, offset, length) => {
      const bytes = parts[part];
      if (bytes === undefined) throw new PackError("short-read", `the pack has no part ${part}`);
      return bytes.subarray(offset, offset + length);
    },
  };
}
