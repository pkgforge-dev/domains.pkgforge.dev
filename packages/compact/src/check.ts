// packages/compact/src/check.ts — the second pass over the output of a merge.
//
//   const { records, distinct } = await checkMerged(inputs, output, codec);
//
// It walks the output once, in key order, beside one cursor on each input, and
// holds the output to the inputs with no merge of its own: every key of every
// input is in the output, every key of the output is in an input, and each
// output record is the merge (codec.merge, docs/format.md section 5.6) of the
// inputs' records of its key, compared as the bytes the codec encodes. It
// counts the distinct keys of the inputs as it goes, so the output's count is
// held to a number the merge did not compute. It shares no code with
// mergeRecords of @domains/pack: a defect there that drops or invents a key
// cannot hide from it. A fault is kept and the walk goes on, so the refusal
// names both counts and the first key that differs (CompactError count).
//
//   await checkRange(inputReaders, part.scan(), rangeOutput, codec);
//
// checkRange is the same pass over one range's part, over the keys that part
// holds (below).
//
// Runs in Node and in workerd alike: it imports nothing from `node:`.
import { ByteWriter, type DatasetCodec } from "@domains/pack";
import { CompactError } from "./errors.ts";

export interface MergeCheck {
  // The records of the output.
  readonly records: number;
  // The distinct keys across the inputs.
  readonly distinct: number;
  // The records of the inputs, summed: equal to `distinct` when no key is in two inputs.
  readonly inputRecords: number;
}

const shown = (key: string): string => JSON.stringify(key.length > 80 ? `${key.slice(0, 80)}...` : key);

function sameRecord<R>(codec: DatasetCodec<R>, a: R, b: R, scratch: ByteWriter): boolean {
  scratch.reset();
  codec.encodeRecord(null, a, scratch);
  const x = scratch.take();
  scratch.reset();
  codec.encodeRecord(null, b, scratch);
  const y = scratch.take();
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return false;
  return true;
}

export async function checkMerged<R>(inputs: readonly AsyncIterable<R>[], output: AsyncIterable<R>, codec: DatasetCodec<R>): Promise<MergeCheck> {
  const cursors = inputs.map((input) => input[Symbol.asyncIterator]());
  const heads: (R | undefined)[] = [];
  const headKeys: (string | undefined)[] = [];
  let inputRecords = 0;
  const pull = async (i: number): Promise<void> => {
    const next = await cursors[i].next();
    const record = next.done ? undefined : next.value;
    const key = record === undefined ? undefined : codec.key(record);
    const before = headKeys[i];
    if (key !== undefined && before !== undefined && !(key > before)) throw new CompactError("count", `input ${i}: the key ${shown(key)} is not above the key before it`);
    heads[i] = record;
    headKeys[i] = key;
    if (record !== undefined) inputRecords += 1;
  };
  const scratch = new ByteWriter(1024);
  let records = 0;
  let distinct = 0;
  let fault: string | null = null;
  let lastKey: string | null = null;
  const note = (why: string): void => {
    fault ??= why;
  };
  // The smallest key at the inputs' cursors, or undefined when every input is read.
  const lowest = (): string | undefined => {
    let m: string | undefined;
    for (const k of headKeys) if (k !== undefined && (m === undefined || k < m)) m = k;
    return m;
  };
  // Every input whose cursor holds `key` moves on: one distinct key.
  const passOver = async (key: string): Promise<void> => {
    distinct += 1;
    for (let i = 0; i < cursors.length; i += 1) if (headKeys[i] === key) await pull(i);
  };
  try {
    for (let i = 0; i < cursors.length; i += 1) await pull(i);
    for await (const out of output) {
      const key = codec.key(out);
      records += 1;
      if (lastKey !== null && !(key > lastKey)) note(`the output's key ${shown(key)} is not above the key before it`);
      lastKey = key;
      // Every input key below this output key is one the output lacks.
      for (let m = lowest(); m !== undefined && m < key; m = lowest()) {
        note(`the output lacks the key ${shown(m)} of its inputs`);
        await passOver(m);
      }
      let fold: R | null = null;
      for (let i = 0; i < cursors.length; i += 1) {
        if (headKeys[i] !== key) continue;
        const record = heads[i] as R;
        fold = fold === null ? record : codec.merge(fold, record);
      }
      if (fold === null) {
        note(`the output holds the key ${shown(key)}, which no input holds`);
        continue;
      }
      await passOver(key);
      if (!sameRecord(codec, fold, out, scratch)) note(`the output's record of ${shown(key)} is not the merge of the inputs' records of that key`);
    }
    for (let m = lowest(); m !== undefined; m = lowest()) {
      note(`the output lacks the key ${shown(m)} of its inputs, after its last key`);
      await passOver(m);
    }
  } finally {
    // A walk left early (a refusal of a reader) closes every input, so a
    // reader's scan releases the block it holds; its own error on close adds
    // nothing to the outcome.
    await Promise.all(cursors.map((c) => (typeof c.return === "function" ? Promise.resolve(c.return()).catch(() => undefined) : undefined)));
  }
  if (fault !== null || records !== distinct) throw new CompactError("count", `the output holds ${records} record(s) and its inputs ${distinct} distinct key(s): ${fault ?? "the counts differ"}`);
  return { records, distinct, inputRecords };
}

// What checkRange reads of a range's output (RangeOutput of range.ts).
export interface RangeKeys {
  readonly part: number | null;
  readonly first: string | null;
  readonly next: string | null;
}

// The second pass over one range's part, as a range job runs it
// (scripts/compact/range.mjs): checkMerged over the inputs' keys that the part
// holds. Those start at the first key of the key space for part 0, and at the
// part's first key for any other part; they end before `next`, the key after
// the part's last, or at the end of the key space. assembleRanges holds each
// part's first key to the `next` of the part before it, so the parts' checks
// together cover the whole key space, with no key in two: a key the merge
// drops before part 0's first key, or between two parts, is in one part's
// keys and fails that part's check. A check from part 0's own first key would
// pass over a first key the merge dropped.
export async function checkRange<R>(inputs: readonly { scan(lo?: string, hi?: string): AsyncIterable<R> }[], part: AsyncIterable<R>, out: RangeKeys, codec: DatasetCodec<R>): Promise<MergeCheck> {
  if (out.part === null || out.first === null) throw new CompactError("usage", "a range that writes no part has nothing to check");
  const lo = out.part === 0 ? undefined : out.first;
  const hi = out.next ?? undefined;
  return await checkMerged(
    inputs.map((input) => input.scan(lo, hi)),
    part,
    codec,
  );
}
