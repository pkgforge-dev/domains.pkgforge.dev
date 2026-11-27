import { IscFault } from "./http.ts";

// The 2025-10-26 file was 178,998,505 B inflated and had a 288-character
// longest row. Stream the list so the archive verifier holds no row array.
const MAX_INFLATED_BYTES = 512 * 1024 ** 2;
const MAX_ROW_CHARS = 8 * 1024;
const INPUT_SLICE_BYTES = 32 * 1024;

type Phase = "start" | "first" | "after-comma" | "row" | "separator" | "end";

function whitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

// Frame the array's objects across chunks. JSON.parse still checks each
// object's complete syntax, including everything only kept in the raw layer.
class ArrayRows {
  private readonly url: string;
  private phase: Phase = "start";
  private carry = "";
  private depth = 0;
  private quoted = false;
  private escaped = false;

  constructor(url: string) {
    this.url = url;
  }

  private append(piece: string): void {
    if (this.carry.length + piece.length > MAX_ROW_CHARS) throw new IscFault("size", `${this.url}: a feed row exceeds ${MAX_ROW_CHARS} UTF-16 code units`);
    this.carry += piece;
  }

  *read(text: string): Generator<string, void> {
    let rowStart = 0;
    for (let at = 0; at < text.length; at += 1) {
      const c = text.charCodeAt(at);
      if (this.phase === "row") {
        if (this.escaped) this.escaped = false;
        else if (this.quoted) {
          if (c === 92) this.escaped = true;
          else if (c === 34) this.quoted = false;
        } else if (c === 34) this.quoted = true;
        else if (c === 123) this.depth += 1;
        else if (c === 125) {
          this.depth -= 1;
          if (this.depth === 0) {
            this.append(text.slice(rowStart, at + 1));
            const row = this.carry;
            this.carry = "";
            this.phase = "separator";
            yield row;
          }
        }
        continue;
      }
      if (whitespace(c)) continue;
      if (this.phase === "start" && c === 91) this.phase = "first";
      else if ((this.phase === "first" || this.phase === "after-comma") && c === 123) {
        this.phase = "row";
        this.depth = 1;
        rowStart = at;
      } else if ((this.phase === "first" || this.phase === "separator") && c === 93) this.phase = "end";
      else if (this.phase === "separator" && c === 44) this.phase = "after-comma";
      else throw new IscFault("format", `${this.url}: expected a JSON array of objects with nothing after it`);
    }
    if (this.phase === "row") this.append(text.slice(rowStart));
  }

  finish(): void {
    if (this.phase !== "end") throw new IscFault("format", `${this.url}: the JSON array ended before its closing bracket`);
  }
}

// The byte shapes common to Worker and Node types. The input is an object
// stream so subarrays reaching the transform leave the raw bytes attached.
interface GzipTransform {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<ArrayBuffer | ArrayBufferView>;
}

export async function* jsonRows(raw: Uint8Array, url: string): AsyncGenerator<string, void> {
  const gzip: GzipTransform = new DecompressionStream("gzip");
  let offset = 0;
  const source = new ReadableStream<ArrayBuffer | ArrayBufferView>({
    pull(controller) {
      if (offset === raw.byteLength) {
        controller.close();
        return;
      }
      const end = Math.min(offset + INPUT_SLICE_BYTES, raw.byteLength);
      controller.enqueue(raw.subarray(offset, end));
      offset = end;
    },
  });
  const reader = source.pipeThrough(gzip).getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const scanner = new ArrayRows(url);
  let size = 0;
  let done = false;
  const decode = (chunk?: Uint8Array): string => {
    try {
      // The transform supplies regular ArrayBuffers, never shared buffers.
      return chunk === undefined ? decoder.decode() : decoder.decode(chunk as Uint8Array<ArrayBuffer>, { stream: true });
    } catch (error) {
      throw new IscFault("encoding", `${url}: the inflated feed is not UTF-8`, { cause: error });
    }
  };
  try {
    for (;;) {
      const chunk = await reader.read().catch((error: unknown) => {
        throw new IscFault("gzip", `${url}: ${raw.byteLength} B do not form a complete gzip file`, { cause: error });
      });
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > MAX_INFLATED_BYTES) throw new IscFault("size", `${url}: the inflated feed exceeds ${MAX_INFLATED_BYTES} B`);
      yield* scanner.read(decode(chunk.value));
    }
    done = true;
    yield* scanner.read(decode());
    scanner.finish();
  } finally {
    if (!done) {
      await reader.cancel().catch(() => {
        // A parse or integrity error already records why this read ended.
      });
    }
    reader.releaseLock();
  }
}
