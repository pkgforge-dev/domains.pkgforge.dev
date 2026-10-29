// packages/pack/test/plant.ts — how a test plants a fault in a written index
// and makes sure only the check under test can refuse it.
//
// layout() walks an index by the tables of docs/format.md section 6, not by
// src/idx.ts. fixCrcs() and fixHead() compute the CRCs again with node:zlib,
// not with src/crc32.ts, so a fault meant for a check behind a CRC reaches that
// check. A fault meant for a CRC changes a byte that every other check accepts.
import assert from "node:assert/strict";
import { crc32 } from "node:zlib";
import { PackError } from "../src/errors.ts";

export const view = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

export interface Layout {
  readonly parts: number;
  readonly pages: number;
  readonly headBytes: number;
  readonly top: readonly { at: number; offset: number; bytes: number; crcAt: number }[];
  // The offset of each second-level entry, and of its fields after the key.
  readonly entries: readonly { at: number; fields: number }[];
}

export function layout(idx: Uint8Array): Layout {
  const dv = view(idx);
  const parts = dv.getUint16(10, true);
  const pages = dv.getUint32(28, true);
  const headBytes = dv.getUint32(32, true);
  let at = 64 + 16 * parts;
  at += 2 + dv.getUint16(at, true);
  at += 2 + dv.getUint16(at, true);
  const top: { at: number; offset: number; bytes: number; crcAt: number }[] = [];
  for (let p = 0; p < pages; p += 1) {
    const start = at;
    at += 2 + dv.getUint16(at, true);
    const offset = Number(dv.getBigUint64(at, true));
    const bytes = dv.getUint32(at + 8, true);
    top.push({ at: start, offset, bytes, crcAt: at + 12 });
    at += 16;
  }
  const entries: { at: number; fields: number }[] = [];
  for (const page of top) {
    let e = headBytes + page.offset;
    while (e < headBytes + page.offset + page.bytes) {
      const fields = e + 2 + dv.getUint16(e, true);
      entries.push({ at: e, fields });
      e = fields + 2 + 8 + 4 + 4 + 2 + 4;
    }
  }
  return { parts, pages, headBytes, top, entries };
}

// The head CRC: the head with bytes 60 to 63 read as zero.
function headCrc(idx: Uint8Array, headBytes: number): number {
  let c = crc32(idx.subarray(0, 60));
  c = crc32(new Uint8Array(4), c);
  return crc32(idx.subarray(64, headBytes), c);
}

// The head CRC computed again; the page CRCs are left as they are.
export function fixHead(idx: Uint8Array): Uint8Array {
  const out = idx.slice();
  view(out).setUint32(60, headCrc(out, view(out).getUint32(32, true)), true);
  return out;
}

// Every page CRC, then the head CRC, computed again.
export function fixCrcs(idx: Uint8Array): Uint8Array {
  const out = idx.slice();
  const dv = view(out);
  const l = layout(out);
  for (const page of l.top) dv.setUint32(page.crcAt, crc32(out.subarray(l.headBytes + page.offset, l.headBytes + page.offset + page.bytes)), true);
  dv.setUint32(60, headCrc(out, l.headBytes), true);
  return out;
}

// Second-level entry fields, from the start of the fields after the key.
export const FIELD = Object.freeze({ part: 0, offset: 2, packed: 10, raw: 14, records: 18, crc: 20 });

// Rejects with PackError of `code`, its message matching `pattern`.
export const refusedWith = async (fn: () => unknown, code: string, pattern: RegExp): Promise<void> =>
  assert.rejects(
    async () => fn(),
    (e: unknown) => {
      assert.ok(e instanceof PackError, String(e));
      assert.equal(e.code, code, e.message);
      assert.match(e.message, pattern);
      return true;
    },
  );
