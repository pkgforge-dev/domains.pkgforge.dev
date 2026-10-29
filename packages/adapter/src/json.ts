// packages/adapter/src/json.ts — canonical JSON, and the SHA-256 of bytes.
//
//   canonicalJson({ b: 1, a: [true, null] })  →  '{"a":[true,null],"b":1}'
//
// Object keys are sorted by code unit, so two equal values give one text, and a
// comparison or a hash of the text never depends on the order a writer built an
// object in. Only plain JSON is accepted: a value JSON.stringify would drop or
// change (undefined, a function, NaN, Infinity, a Date, a Map, a cycle) throws
// JsonError, never a silently different text.

export class JsonError extends Error {
  readonly path: string;
  constructor(path: string, message: string) {
    super(`${path || "value"}: ${message}`);
    this.name = "JsonError";
    this.path = path;
  }
}

// Deeper than any cursor, record or registry row; a cycle reaches it.
const MAX_DEPTH = 64;

function isPlainObject(v: object): boolean {
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function encode(v: unknown, path: string, depth: number): string {
  if (depth > MAX_DEPTH) throw new JsonError(path, `nested deeper than ${MAX_DEPTH} (a cycle?)`);
  if (v === null) return "null";
  switch (typeof v) {
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new JsonError(path, `${v} is not a JSON number`);
      return JSON.stringify(v);
    case "string":
      return JSON.stringify(v);
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x, i) => encode(x, `${path}[${i}]`, depth + 1)).join(",")}]`;
      if (!isPlainObject(v)) throw new JsonError(path, `a ${Object.prototype.toString.call(v).slice(8, -1)} is not plain JSON`);
      const keys = Object.keys(v).sort();
      const parts = keys.map((k) => `${JSON.stringify(k)}:${encode((v as Record<string, unknown>)[k], path ? `${path}.${k}` : k, depth + 1)}`);
      return `{${parts.join(",")}}`;
    }
    default:
      throw new JsonError(path, `a ${typeof v} is not JSON`);
  }
}

export function canonicalJson(v: unknown): string {
  return encode(v, "", 0);
}

// Equal as JSON values: the same canonical text.
export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

// Lowercase hex of the SHA-256 of bytes. Web Crypto, so it runs in workerd too.
// Web Crypto reads no SharedArrayBuffer: such bytes are copied first.
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const buf = bytes.buffer;
  const view = buf instanceof ArrayBuffer ? new Uint8Array(buf, bytes.byteOffset, bytes.byteLength) : bytes.slice();
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", view));
  let out = "";
  for (const b of digest) out += b.toString(16).padStart(2, "0");
  return out;
}
