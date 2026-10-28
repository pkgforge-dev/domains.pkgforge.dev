// scripts/measure/thc-lines.mjs — the one line reader and the one writer of the
// THC day measurement (DOM-009). Every stage reads and writes through these, so
// a fix to chunk boundaries or back-pressure reaches all of them.
//
// Lines are found in the bytes (`buf.indexOf(10)`), and a stage that works on
// bytes gets (buf, start, end) with no string made at all. A stage that wants a
// string gets a fresh latin1 string of the line: one byte is one UTF-16 code
// unit, so a JavaScript comparison of two lines is the bytewise comparison
// `LC_ALL=C sort` uses, and a byte above 0x7f stays a code unit above 0x7f
// instead of becoming U+FFFD. The string is a copy, never a slice of the chunk:
// a key a stage keeps does not keep the 1 MiB chunk it was read from alive.
//
// Usage: import { forEachLineBytes, forEachLine, forEachLineOfFile, createByteWriter } from './thc-lines.mjs'
// It is a module; it has no command line and no exit code.
import { once } from 'node:events';
import { createReadStream, createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const CHUNK = 1 << 20;
// The bytes a writer queues before write() asks the caller to wait: enough for
// the CPU work of the next chunks to overlap the disk write of the last ones.
const QUEUE = 16 << 20;

// Calls fn(buf, start, end) for every line of an async iterable of Buffers,
// [start, end) without the '\n'. A last line with no '\n' is still a line. When
// fn returns a promise (a writer that is full), the reader waits for it before
// the next line. Returns { lines, bytes, finalNewline }.
export async function forEachLineBytes(source, fn) {
  let rest = null;
  let lines = 0;
  let bytes = 0;
  for await (const chunk of source) {
    bytes += chunk.length;
    const buf = rest === null ? chunk : Buffer.concat([rest, chunk]);
    let start = 0;
    let at = buf.indexOf(10, start);
    while (at !== -1) {
      const wait = fn(buf, start, at);
      if (wait) await wait;
      lines += 1;
      start = at + 1;
      at = buf.indexOf(10, start);
    }
    rest = start < buf.length ? buf.subarray(start) : null;
  }
  const finalNewline = rest === null;
  if (!finalNewline) {
    const wait = fn(rest, 0, rest.length);
    if (wait) await wait;
    lines += 1;
  }
  return { lines, bytes, finalNewline };
}

// The same with fn(line) given a latin1 string of the line.
export function forEachLine(source, fn) {
  return forEachLineBytes(source, (buf, start, end) => fn(buf.toString('latin1', start, end)));
}

// Either reader over a file, gunzipped when gzip is true; bytes: true gives fn
// (buf, start, end). A truncated or corrupt gzip stream rejects (zlib checks the
// length and the CRC-32 of every member), so a short download never reads as a
// short day. The result's bytes counts the text bytes.
export async function forEachLineOfFile(path, fn, { gzip = false, bytes = false } = {}) {
  const read = bytes ? forEachLineBytes : forEachLine;
  const file = createReadStream(path, { highWaterMark: CHUNK });
  if (!gzip) return read(file, fn);
  let result = null;
  await pipeline(file, createGunzip({ chunkSize: CHUNK }), async (source) => {
    result = await read(source, fn);
  });
  return result;
}

// A file writer of Buffers. write(buf) returns a promise when the queue is full,
// and the caller awaits it; the writer keeps a reference to buf until it is
// written, so a caller never refills a Buffer it has passed. close() resolves
// with { bytes } once every byte is on disk, and rejects on any write error.
export function createByteWriter(path) {
  const out = createWriteStream(path, { highWaterMark: QUEUE });
  let failed = null;
  out.on('error', (err) => {
    failed = err;
  });
  return {
    write(buf) {
      if (failed) throw failed;
      return out.write(buf) ? null : once(out, 'drain');
    },
    async close() {
      if (failed) throw failed;
      out.end();
      await once(out, 'finish');
      return { bytes: out.bytesWritten };
    },
  };
}
