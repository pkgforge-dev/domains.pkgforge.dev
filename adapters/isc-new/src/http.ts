import { type AdapterContext, isIsoUtc, sha256Hex } from "@domains/adapter";

export const ISC_FEEDS = "https://isc.sans.edu/feeds/";
// The first archive file measured 16,740,910 B. This also bounds the bytes
// kept for hashing and the raw artifact when a response omits its length.
export const MAX_GZIP_BYTES = 64 * 1024 ** 2;
const READ_DEADLINE_MS = 120_000;
const HEAD_DEADLINE_MS = 20_000;
const BLOCK_BYTES = 1024 ** 2;

export type FaultCode = "http" | "timeout" | "length" | "size" | "encoding" | "gzip" | "format" | "date";

export class IscFault extends Error {
  readonly code: FaultCode;

  constructor(code: FaultCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "IscFault";
    this.code = code;
  }
}

export function isDay(value: unknown): value is string {
  return typeof value === "string" && value.length === 10 && isIsoUtc(`${value}T00:00:00Z`);
}

export function datedUrl(day: string): string {
  if (!isDay(day)) throw new IscFault("date", "ISC archive paths require a real YYYY-MM-DD day");
  return `${ISC_FEEDS}domaindata.${day}.json.gz`;
}

export interface Validators {
  readonly etag?: string;
  readonly lastModified?: string;
}

interface SnapshotLocation {
  readonly url: string;
  // The advertised archive path date. The response decides its own data day.
  readonly pathDay: string | null;
  readonly validators: Validators;
}

export interface SnapshotFile extends SnapshotLocation {
  readonly kind: "file";
  readonly raw: Uint8Array;
  readonly sha256: string;
}

export type Snapshot = SnapshotFile | (SnapshotLocation & { readonly kind: "unchanged" | "missing" });
export type SnapshotHead = SnapshotLocation & { readonly kind: "present" | "unchanged" | "missing"; readonly bytes: number | null };

export interface SnapshotRequest {
  readonly day?: string;
  // Callers supply the validators observed on this URL, never the alias's
  // validators on a dated URL (or the reverse).
  readonly validators?: Validators;
}

const readValidators = (headers: Headers): Validators => {
  const etag = headers.get("etag");
  const lastModified = headers.get("last-modified");
  return { ...(etag === null ? {} : { etag }), ...(lastModified === null ? {} : { lastModified }) };
};

function transportFault(url: string, signal: AbortSignal, cause: unknown, limit = READ_DEADLINE_MS): IscFault {
  return signal.aborted
    ? new IscFault("timeout", `${url}: the response did not finish within ${limit / 1000} s`, { cause })
    : new IscFault("http", `${url}: the request or body read failed`, { cause });
}

async function drop(body: ReadableStream | null): Promise<void> {
  await body?.cancel().catch(() => {
    // The HTTP status or integrity failure takes precedence over cancellation.
  });
}

function declaredSize(response: Response, url: string): number | null {
  const length = response.headers.get("content-length");
  if (length === null) return null;
  const bytes = Number(length);
  if (!/^\d+$/.test(length) || !Number.isSafeInteger(bytes)) throw new IscFault("length", `${url}: invalid Content-Length`);
  if (bytes > MAX_GZIP_BYTES) throw new IscFault("size", `${url}: Content-Length exceeds ${MAX_GZIP_BYTES} B`);
  return bytes;
}

async function readBody(response: Response, url: string, signal: AbortSignal): Promise<Uint8Array> {
  let length: number | null;
  try {
    const encoding = response.headers.get("content-encoding");
    if (encoding !== null && encoding.toLowerCase() !== "identity") throw new IscFault("encoding", `${url}: expected the publisher's gzip bytes with identity HTTP encoding`);
    length = declaredSize(response, url);
  } catch (error) {
    await drop(response.body);
    throw error;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) throw new IscFault("length", `${url}: HTTP 200 carried no body`);
  const bytes = length === null ? null : new Uint8Array(length);
  // Bound the number of retained buffers even when the network sends many
  // tiny reads, or when a response gives no Content-Length.
  const blocks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      const chunk = part.value;
      const next = total + chunk.byteLength;
      if (next > MAX_GZIP_BYTES) throw new IscFault("size", `${url}: response exceeds ${MAX_GZIP_BYTES} B`);
      if (length !== null && next > length) throw new IscFault("length", `${url}: body exceeds its Content-Length of ${length} B`);
      if (bytes !== null) bytes.set(chunk, total);
      else {
        for (let at = 0; at < chunk.byteLength; ) {
          const offset = (total + at) % BLOCK_BYTES;
          if (offset === 0) blocks.push(new Uint8Array(BLOCK_BYTES));
          const count = Math.min(BLOCK_BYTES - offset, chunk.byteLength - at);
          blocks.at(-1)!.set(chunk.subarray(at, at + count), offset);
          at += count;
        }
      }
      total = next;
    }
  } catch (error) {
    await reader.cancel().catch(() => {
      // The timeout or integrity failure is the error to report.
    });
    if (error instanceof IscFault) throw error;
    throw transportFault(url, signal, error);
  } finally {
    reader.releaseLock();
  }
  if (length !== null && total !== length) throw new IscFault("length", `${url}: received ${total} B, expected ${length} B`);
  if (bytes !== null) return bytes;
  const raw = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    const chunk = block.subarray(0, Math.min(BLOCK_BYTES, total - offset));
    raw.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return raw;
}

type HttpContext = Pick<AdapterContext, "fetch" | "userAgent">;
type ResponseRead = SnapshotLocation & {
  readonly kind: "present" | "unchanged" | "missing";
  readonly response: Response;
  readonly signal: AbortSignal;
};

async function getResponse(ctx: HttpContext, request: SnapshotRequest, method: "GET" | "HEAD"): Promise<ResponseRead> {
  const pathDay = request.day ?? null;
  const url = pathDay === null ? `${ISC_FEEDS}domaindata.json.gz` : datedUrl(pathDay);
  const headers = new Headers({ "user-agent": ctx.userAgent, "accept-encoding": "identity" });
  const previous = request.validators;
  if (previous?.etag !== undefined) headers.set("if-none-match", previous.etag);
  else if (previous?.lastModified !== undefined) headers.set("if-modified-since", previous.lastModified);
  const conditional = headers.has("if-none-match") || headers.has("if-modified-since");
  const limit = method === "HEAD" ? HEAD_DEADLINE_MS : READ_DEADLINE_MS;
  const signal = AbortSignal.timeout(limit);
  let response: Response;
  try {
    response = await ctx.fetch(url, { method, headers, signal, redirect: "error" });
  } catch (error) {
    throw transportFault(url, signal, error, limit);
  }
  const validators = readValidators(response.headers);
  const read = { url, pathDay, validators, response, signal };
  if (response.status === 200) return { ...read, kind: "present" };
  await drop(response.body);
  if (response.status === 304 && conditional) return { ...read, kind: "unchanged", validators: { ...previous, ...validators } };
  if (response.status === 404) return { ...read, kind: "missing" };
  throw new IscFault("http", `${url}: ${method} answered ${response.status}`);
}

export async function fetchSnapshot(ctx: HttpContext, request: SnapshotRequest = {}): Promise<Snapshot> {
  const { kind, url, pathDay, validators, response, signal } = await getResponse(ctx, request, "GET");
  if (kind !== "present") return { kind, url, pathDay, validators };
  const raw = await readBody(response, url, signal);
  return { kind: "file", url, pathDay, validators, raw, sha256: await sha256Hex(raw) };
}

export async function headSnapshot(ctx: HttpContext, request: SnapshotRequest = {}): Promise<SnapshotHead> {
  const { kind, url, pathDay, validators, response } = await getResponse(ctx, request, "HEAD");
  await drop(response.body);
  return { kind, url, pathDay, validators, bytes: kind === "present" ? declaredSize(response, url) : null };
}
