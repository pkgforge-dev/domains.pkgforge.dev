// packages/adapter/src/writer.ts — the in-memory SegmentWriter the harness and
// the adapters' tests use. DOM-017's pack writer and DOM-019's push tool supply
// the one that stores segments; nothing in a production path constructs this.
//
//   const w = memoryWriter();                         // or memoryWriter({ sources }): urls held to the rows
//   const seg = await w.write(draft, records, raw);   // a Segment
//   w.written;                                        // [{ segment, records, raw, rawMember, facts, url }]
//
// It holds the writer contract a real writer holds: the draft is a valid
// segment identity, records arrive in strictly increasing key order with one
// record per key, and every record is plain JSON. `sha256` is the SHA-256 of
// the decoded record stream, here each record's canonical JSON and a newline;
// `bytes` is the length of that stream. The same records give the same digest
// whatever order a record's fields were built in.
//
// The draft's raw lane member fields, facts and url are held to the rules the
// disk writer of scripts/ingest holds them to (checkRawMember,
// checkRawMemberBytes, factsProblem, factKeysWalk, checkDraftUrl of
// validate.ts), each refusal ContractError `draft`, and recorded as given. The
// url is held to its source row's urls when the writer is given the sources
// (the harness passes the adapter's), else to the URL rules alone. Segment.facts is factsRef of facts.ts, as the
// disk writer computes it. The layer facts.json is keyed by a source bit, which
// this writer does not know: it holds the facts to FACTS_MAX_BYTES as the layer
// of the widest bit (MAX_BIT, two digits) would be, so a draft it takes is a
// draft the disk writer takes.
import { encodeFacts, FactsError, factsOfRows, factsRef } from "./facts.ts";
import { canonicalJson, JsonError, sha256Hex, utf8 } from "./json.ts";
import { DATASETS, type FactRow, PRECISIONS, type RawInput, type Segment, type SegmentDraft, type SegmentRecord, type SegmentWriter, type Source } from "./types.ts";
import { ContractError, checkCursor, checkDraftUrl, checkRawMember, checkRawMemberBytes, checkWindow, factKeysWalk, factsProblem, ID_GRAMMAR, MAX_BIT, validateSegment } from "./validate.ts";

export interface Written {
  readonly segment: Segment;
  readonly records: readonly SegmentRecord[];
  readonly raw: Uint8Array | null;
  // The draft's rawMember and facts as JSON copies, or null when it gave none.
  readonly rawMember: Readonly<Record<string, string | number>> | null;
  readonly facts: readonly FactRow[] | null;
  // The draft's url, or null when it gave none.
  readonly url: string | null;
}

export interface MemoryWriterOptions {
  // The adapter's sources: a draft's url is then held to its row's urls.
  readonly sources?: readonly Source[];
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

function checkDraft(draft: SegmentDraft, sources: readonly Source[] | null): void {
  const what = `segment ${JSON.stringify(draft?.source)}`;
  if (typeof draft !== "object" || draft === null) throw new ContractError("draft", "the draft is not an object");
  if (typeof draft.source !== "string" || !ID_GRAMMAR.test(draft.source)) throw new ContractError("draft", `${what}: source is not an id`);
  if (draft.url !== undefined) {
    const row = sources === null ? null : (sources.find((s) => s.id === draft.source) ?? null);
    if (sources !== null && row === null)
      throw new ContractError("draft", `${what}: the source is not one of the adapter's (${sources.map((s) => s.id).join(", ")}), so its url has no row to lie under`);
    checkDraftUrl(draft.url, row === null ? null : row.urls, what);
  }
  if (!(DATASETS as readonly unknown[]).includes(draft.dataset)) throw new ContractError("draft", `${what}: dataset ${JSON.stringify(draft.dataset)} is not one of ${DATASETS.join(", ")}`);
  if (!(PRECISIONS as readonly unknown[]).includes(draft.precision)) throw new ContractError("draft", `${what}: precision ${JSON.stringify(draft.precision)} is not one of ${PRECISIONS.join(", ")}`);
  checkWindow(draft.window, draft.precision, what);
  checkCursor(draft.cursorBefore, `${what}: cursorBefore`);
  checkCursor(draft.cursorAfter, `${what}: cursorAfter`);
  checkRawMember(draft.rawMember, draft.precision, what);
  const problem = factsProblem(draft.facts);
  if (problem !== null) throw new ContractError("draft", `${what}: ${problem}`);
  if (draft.facts !== undefined && draft.facts.length > 0) {
    try {
      encodeFacts(factsOfRows(draft.facts, MAX_BIT));
    } catch (err) {
      if (!(err instanceof FactsError)) throw err;
      throw new ContractError("draft", `${what}: facts: ${err.message}`);
    }
  }
}

export function memoryWriter(options: MemoryWriterOptions = {}): MemoryWriter {
  const written: Written[] = [];
  const sources = options.sources ?? null;
  return {
    written,
    async write(draft, records, raw) {
      checkDraft(draft, sources);
      const what = `segment ${JSON.stringify(draft.source)}`;
      // Copied once the draft is checked, before the first await: what is recorded is what was checked.
      const facts = draft.facts === undefined ? null : (JSON.parse(canonicalJson(draft.facts)) as FactRow[]);
      const rawMember = draft.rawMember === undefined ? null : (JSON.parse(canonicalJson(draft.rawMember)) as Record<string, string | number>);
      const url = draft.url ?? null;
      const walk = factKeysWalk(facts ?? []);
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
        walk.see(r.key);
        prev = r.key;
      }
      const unwritten = walk.problem();
      if (unwritten !== null) throw new ContractError("draft", `${what}: facts: ${unwritten}`);
      const stream = utf8(lines.map((l) => `${l}\n`).join(""));
      const rawBytes = raw === undefined ? null : await collect(raw);
      checkRawMemberBytes(rawMember ?? undefined, rawBytes === null ? null : rawBytes.byteLength, what);
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
      if (facts !== null && facts.length > 0) json.facts = await factsRef(facts);
      const segment = validateSegment(json, `segment of ${draft.source}`);
      written.push({ segment, records: kept, raw: rawBytes, rawMember, facts, url });
      return segment;
    },
  };
}
