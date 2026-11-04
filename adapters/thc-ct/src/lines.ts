// adapters/thc-ct/src/lines.ts — the lines of one gzip file held as chunks
// (DOM-029, design D4).
//
//   for await (const batch of linesOf(chunks, counts)) for (const line of batch) ...
//
// The chunks go to DecompressionStream('gzip') through its writer, a slice at
// a time, never through a byte ReadableStream: that would detach them, and the
// day's two writes pass the same chunks as their raw layer (design M28). The
// text is decoded with TextDecoder('utf-8') in streaming mode, so a character
// split across two chunks is whole; a byte that is not UTF-8 becomes U+FFFD,
// which the names package refuses, and a leading BOM is dropped. Lines split
// on "\n"; one trailing "\r" is stripped and counted (a line ending is not
// part of a name), and an empty line is skipped and counted. A batch is the
// lines of one decompressed chunk: an async step per line costs 0.786 us
// against 0.309 us per batch (design M27).
//
// DecompressionStream throws a TypeError for a truncated stream, trailing
// junk, a second gzip member or an input that is not gzip (design M6, M21);
// linesOf throws it on as GzipError. A valid empty gzip gives no line.

// The slice of a chunk written to the decompressor at a time: what one read
// can make waits in memory, never a whole chunk's output.
const FEED_BYTES = 1 << 20;

export interface LineCounts {
  // Every line read, empty ones among them.
  lines: number;
  empty: number;
  crlf: number;
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
  let done = false;
  try {
    for (;;) {
      const r = await reader.read().catch((err: unknown) => {
        if (err instanceof TypeError) throw new GzipError(`the gzip stream does not decode: ${err.message}`, { cause: err });
        throw err;
      });
      if (r.done) break;
      // A decompressor's chunk is backed by an ArrayBuffer of its own, never a SharedArrayBuffer.
      const parts = (tail + dec.decode(r.value as Uint8Array<ArrayBuffer>, { stream: true })).split("\n");
      tail = parts.pop()!;
      const batch = clean(parts, counts);
      if (batch.length > 0) yield batch;
    }
    done = true;
    const last = tail + dec.decode();
    // A last line with no "\n" after it is a line.
    if (last.length > 0) {
      const batch = clean([last], counts);
      if (batch.length > 0) yield batch;
    }
  } finally {
    if (!done)
      await reader.cancel().catch(() => {
        // Deliberately empty: the stream is abandoned, and the error that ended the read is the one thrown.
      });
  }
}
