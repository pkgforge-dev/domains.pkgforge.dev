// adapters/thc-ct/src/lines.ts — the lines of one gzip file held as chunks.
//
//   for await (const batch of linesOf(chunks, counts)) for (const line of batch) ...
//
// The chunks go to DecompressionStream('gzip') through its writer, a slice at
// a time, never through a byte ReadableStream: that would detach them, and the
// day's two writes pass the same chunks as their raw layer. The
// text is decoded with TextDecoder('utf-8') in streaming mode, so a character
// split across two chunks is whole; a byte that is not UTF-8 becomes U+FFFD,
// which the names package refuses, and a leading BOM is dropped. Lines split
// on "\n"; one trailing "\r" is stripped and counted (a line ending is not
// part of a name), and an empty line is skipped and counted. Batching avoids
// an async step per line (12-asyncgen-cost.out of the THC research report).
//
// DecompressionStream throws a TypeError for a truncated stream, trailing
// junk, a second gzip member or an input that is not gzip. A valid empty
// gzip gives no line (09-trunc-gzip.out and 10-empty-gzip.out of the report).

// The slice of a chunk written to the decompressor at a time: what one read
// can make waits in memory, never a whole chunk's output.
const FEED_BYTES = 1 << 20;
// Bound the raw line before IDNA mapping. Normalised names are at most 253
// ASCII characters. This leaves room for Unicode, the wildcard and end dot.
// Discard the rest of an oversized line while still reading to its end.
const MAX_LINE_CHARS = 4096;
const UPPER = /[A-Z]/;

export interface LineCounts {
  // Every line read, empty ones among them.
  lines: number;
  empty: number;
  crlf: number;
  upper: number;
  oversize: number;
}

export class GzipError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "GzipError";
  }
}

function clean(parts: readonly string[], counts: LineCounts): string[] {
  const out: string[] = [];
  for (let line of parts) {
    counts.lines += 1;
    if (line.length > 0 && line.charCodeAt(line.length - 1) === 13) {
      line = line.slice(0, -1);
      counts.crlf += 1;
    }
    if (line.length === 0) {
      counts.empty += 1;
      continue;
    }
    if (UPPER.test(line)) counts.upper += 1;
    if (line.length > MAX_LINE_CHARS) {
      counts.oversize += 1;
      continue;
    }
    out.push(line);
  }
  return out;
}

// The shape both type sets (Node's and the Workers runtime's) give
// DecompressionStream, as packages/pack/src/reader.ts names it.
interface ByteTransform {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<ArrayBuffer | ArrayBufferView>;
}

export async function* linesOf(chunks: readonly Uint8Array[], counts: LineCounts): AsyncGenerator<string[], void, undefined> {
  const ds: ByteTransform = new DecompressionStream("gzip");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();
  const pump = async (): Promise<void> => {
    for (const c of chunks) for (let at = 0; at < c.byteLength; at += FEED_BYTES) await writer.write(c.subarray(at, at + FEED_BYTES));
    await writer.close();
  };
  pump().catch(() => {
    // Deliberately empty: a fault of the stream rejects the reader's read,
    // which throws it below; a consumer that stops early cancels the reader.
  });
  const dec = new TextDecoder("utf-8", { fatal: false, ignoreBOM: false });
  let tail = "";
  let skipping = false;
  let skippedUpper = false;
  let skippedCR = false;
  const batchOf = (text: string, eof = false): string[] => {
    if (skipping) {
      const end = text.indexOf("\n");
      const continuation = end === -1 ? text : text.slice(0, end);
      skippedUpper ||= UPPER.test(continuation);
      if (continuation.length > 0) skippedCR = continuation.endsWith("\r");
      if (end === -1 && !eof) return [];
      counts.lines += 1;
      counts.oversize += 1;
      if (skippedUpper) counts.upper += 1;
      if (skippedCR) counts.crlf += 1;
      skipping = false;
      if (end === -1) return [];
      text = text.slice(end + 1);
    }
    const parts = (tail + text).split("\n");
    tail = parts.pop()!;
    if (eof) {
      if (tail.length > 0) parts.push(tail);
    } else if (tail.length > MAX_LINE_CHARS + 1) {
      // Allow for the final CR before applying the limit to the line itself.
      skipping = true;
      skippedUpper = UPPER.test(tail);
      skippedCR = tail.endsWith("\r");
      tail = "";
    }
    return clean(parts, counts);
  };
  let done = false;
  try {
    for (;;) {
      const r = await reader.read().catch((err: unknown) => {
        if (err instanceof TypeError) throw new GzipError(err.message ? `the gzip stream does not decode: ${err.message}` : "the gzip stream does not decode", { cause: err });
        throw err;
      });
      if (r.done) break;
      // A decompressor's chunk is backed by an ArrayBuffer of its own, never a SharedArrayBuffer.
      const batch = batchOf(dec.decode(r.value as Uint8Array<ArrayBuffer>, { stream: true }));
      if (batch.length > 0) yield batch;
    }
    done = true;
    // A last line with no "\n" after it is a line.
    const batch = batchOf(dec.decode(), true);
    if (batch.length > 0) yield batch;
  } finally {
    if (!done)
      await reader.cancel().catch(() => {
        // Deliberately empty: the stream is abandoned, and the error that ended the read is the one thrown.
      });
  }
}
