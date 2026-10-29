// packages/adapter/src/writer.ts — the in-memory SegmentWriter the harness and
// the adapters' tests use. DOM-017's pack writer and DOM-019's push tool supply
// the one that stores segments; nothing in a production path constructs this.
//
//   const w = memoryWriter();
//   const seg = await w.write(draft, records, raw);   // a Segment
//   w.written;                                        // [{ segment, records, raw }]
//
// It holds the writer contract a real writer holds: the draft is a valid
// segment identity, records arrive in strictly increasing key order with one
// record per key, and every record is plain JSON. `sha256` is the SHA-256 of
// the decoded record stream, here each record's canonical JSON and a newline;
// `bytes` is the length of that stream. The same records give the same digest
// whatever order a record's fields were built in.
import { canonicalJson, JsonError, sha256Hex, utf8 } from "./json.ts";
import { DATASETS, PRECISIONS, type RawInput, type Segment, type SegmentDraft, type SegmentRecord, type SegmentWriter } from "./types.ts";
import { ContractError, checkCursor, checkWindow, ID_GRAMMAR, validateSegment } from "./validate.ts";

export interface Written {
  readonly segment: Segment;
  readonly records: readonly SegmentRecord[];
  readonly raw: Uint8Array | null;
}

export interface MemoryWriter extends SegmentWriter {
  readonly written: readonly Written[];
}

async function collect(raw: RawInput): Promise<Uint8Array> {
  if (raw instanceof Uint8Array) return raw.slice();
  const parts: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of raw) {
    if (!(chunk instanceof Uint8Array)) throw new ContractError("draft", "a raw chunk is not a Uint8Array");
    parts.push(chunk);
    total += chunk.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

function checkDraft(draft: SegmentDraft): void {
  const what = `segment ${JSON.stringify(draft?.source)}`;
  if (typeof draft !== "object" || draft === null) throw new ContractError("draft", "the draft is not an object");
  if (typeof draft.source !== "string" || !ID_GRAMMAR.test(draft.source)) throw new ContractError("draft", `${what}: source is not an id`);
  if (!(DATASETS as readonly unknown[]).includes(draft.dataset)) throw new ContractError("draft", `${what}: dataset ${JSON.stringify(draft.dataset)} is not one of ${DATASETS.join(", ")}`);
  if (!(PRECISIONS as readonly unknown[]).includes(draft.precision)) throw new ContractError("draft", `${what}: precision ${JSON.stringify(draft.precision)} is not one of ${PRECISIONS.join(", ")}`);
  checkWindow(draft.window, draft.precision, what);
  checkCursor(draft.cursorBefore, `${what}: cursorBefore`);
  checkCursor(draft.cursorAfter, `${what}: cursorAfter`);
}

export function memoryWriter(): MemoryWriter {
  const written: Written[] = [];
  return {
    written,
    async write(draft, records, raw) {
      checkDraft(draft);
      const kept: SegmentRecord[] = [];
      const lines: string[] = [];
      let prev: string | null = null;
      for await (const r of records) {
        if (typeof r !== "object" || r === null || typeof r.key !== "string" || r.key === "") throw new ContractError("record", `record ${kept.length} has no key`);
        // Keys are ASCII ([a-z0-9_.-]), where code-unit order is byte order.
        if (prev !== null && r.key <= prev) throw new ContractError("record", `record ${kept.length} key ${JSON.stringify(r.key)} does not sort after ${JSON.stringify(prev)}`);
        let line: string;
        try {
          line = canonicalJson(r);
        } catch (err) {
          if (!(err instanceof JsonError)) throw err;
          throw new ContractError("record", `record ${kept.length}: ${err.message}`);
        }
        lines.push(line);
        kept.push(JSON.parse(line) as SegmentRecord);
        prev = r.key;
      }
      const stream = utf8(lines.map((l) => `${l}\n`).join(""));
      const rawBytes = raw === undefined ? null : await collect(raw);
      const json: Record<string, unknown> = {
        source: draft.source,
        dataset: draft.dataset,
        window: { start: draft.window.start, end: draft.window.end },
        cursorBefore: JSON.parse(canonicalJson(draft.cursorBefore)),
        cursorAfter: JSON.parse(canonicalJson(draft.cursorAfter)),
        count: kept.length,
        precision: draft.precision,
        bytes: stream.byteLength,
        sha256: await sha256Hex(stream),
      };
      if (rawBytes !== null) json.raw = { bytes: rawBytes.byteLength, sha256: await sha256Hex(rawBytes) };
      const segment = validateSegment(json, `segment of ${draft.source}`);
      written.push({ segment, records: kept, raw: rawBytes });
      return segment;
    },
  };
}
