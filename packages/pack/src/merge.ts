// packages/pack/src/merge.ts — the k-way merge by key of sorted records.
//
//   const summary = await writePack(mergePacks([a, b, c], NAMES_CODEC), { codec: NAMES_CODEC, compress, sink });
//
// mergeRecords takes sorted inputs and yields one sorted stream in which the
// records of one key across inputs become one record through codec.merge
// (docs/format.md section 5.6). It holds the head record of each input and
// nothing more; mergePacks feeds it the scans of pack readers, which hold one
// block each. Each input must ascend by key with no key twice, and the merge
// refuses one that does not ("order"): a merge never repairs an input.
//
// The heap orders the heads by key, then by input number, so the records of
// one key fold in input order. codec.merge is commutative and associative, so
// that order never changes the output; it only makes the work the same on
// every run.
import type { DatasetCodec } from "./codec.ts";
import { PackError } from "./errors.ts";
import type { PackReader } from "./reader.ts";

interface Head<R> {
  readonly key: string;
  readonly record: R;
  readonly input: number;
}

const below = <R>(a: Head<R>, b: Head<R>): boolean => a.key < b.key || (a.key === b.key && a.input < b.input);

class Heap<R> {
  readonly items: Head<R>[] = [];

  push(item: Head<R>): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!below(a[i], a[parent])) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }

  pop(): Head<R> | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && below(a[l], a[m])) m = l;
        if (r < a.length && below(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }

  peek(): Head<R> | undefined {
    return this.items[0];
  }
}

function iteratorOf<R>(input: AsyncIterable<R> | Iterable<R>): AsyncIterator<R> | Iterator<R> {
  if (Symbol.asyncIterator in input) return (input as AsyncIterable<R>)[Symbol.asyncIterator]();
  return (input as Iterable<R>)[Symbol.iterator]();
}

export async function* mergeRecords<R>(inputs: readonly (AsyncIterable<R> | Iterable<R>)[], codec: DatasetCodec<R>): AsyncGenerator<R> {
  const iterators = inputs.map(iteratorOf);
  const lastKeys: (string | null)[] = inputs.map(() => null);
  const heap = new Heap<R>();
  const pull = async (input: number): Promise<void> => {
    const next = await iterators[input].next();
    if (next.done) return;
    const key = codec.key(next.value);
    const before = lastKeys[input];
    if (before !== null && !(key > before)) throw new PackError("order", `merge input ${input}: a key is not above the key before it`);
    lastKeys[input] = key;
    heap.push({ key, record: next.value, input });
  };
  try {
    for (let i = 0; i < iterators.length; i += 1) await pull(i);
    for (;;) {
      const top = heap.pop();
      if (top === undefined) return;
      await pull(top.input);
      let record = top.record;
      for (let same = heap.peek(); same !== undefined && same.key === top.key; same = heap.peek()) {
        heap.pop();
        record = codec.merge(record, same.record);
        await pull(same.input);
      }
      yield record;
    }
  } finally {
    // An input left early (the caller stopped, or one input failed) is closed,
    // so a reader's scan releases what it holds. Its own error on close adds
    // nothing to the outcome.
    await Promise.all(iterators.map((it) => (typeof it.return === "function" ? Promise.resolve(it.return()).catch(() => undefined) : undefined)));
  }
}

// The merge of packs of one dataset: every reader must hold the codec's dataset.
export function mergePacks<R>(readers: readonly PackReader<R>[], codec: DatasetCodec<R>): AsyncGenerator<R> {
  for (const [i, reader] of readers.entries()) {
    if (reader.index.header.dataset !== codec.id) throw new PackError("dataset", `merge input ${i} is dataset ${reader.index.header.dataset}, the codec ${codec.name} is dataset ${codec.id}`);
  }
  return mergeRecords(
    readers.map((r) => r.scan()),
    codec,
  );
}
