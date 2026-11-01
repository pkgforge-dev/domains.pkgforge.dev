// packages/compact/src/facts.ts — the certificate facts of the segments as
// the feed's confidence reads them (DOM-026, docs/format.md section 19). A
// domain record holds no certificate age, so the hour and the day builds take
// it from the layer facts.json of each segment, or of a domains day pack, and
// hand it to buildFeedHour and buildFeedDay beside each record
// (EventFacts.certAges of @domains/feed).
//
//   const facts = eventFactsOf([parseFacts(a), parseFacts(b)]);   key → { certAges: [{ bit, seconds }] }, or undefined
//   await buildHour(readers, membership, { ..., facts });
//
// The layer's format, its reader and the merge are @domains/adapter's
// (parseFacts, mergeFacts): one reader of facts.json. A fact's bit is the bit
// of the segment it came from, and its key a key of that segment, so the
// record the merge of the segments gives for the key holds the bit, which
// confidenceOf of @domains/feed requires. A caller holds each table's bits to
// its pack's sources before it gets here (scripts/compact/hour.mjs, day.mjs).
//
// It imports nothing from `node:` and is type-checked as Worker code
// (tsconfig.worker.json); no test runs it in workerd.
import { type FactsTable, mergeFacts } from "@domains/adapter";
import type { CertAge, EventFacts } from "@domains/feed";
import { CompactError } from "./errors.ts";

// The facts of a key, as buildFeedHour and buildFeedDay read them: the
// minimum cert_age of each source bit over `tables`, so a fresh event of a
// domain clears an old certificate's age (the Time bullet of DOM-026). A key
// none of the tables names, or whose facts hold no cert_age, has none
// (undefined), and its row is judged on its record alone. One table is its
// own minimum and is read as it is: a merged or parsed table of a day is
// 400,000 keys and more (settled S1 of DOM-026), and mergeFacts would copy it.
export function eventFactsOf(tables: readonly FactsTable[]): (key: string) => EventFacts | undefined {
  if (!Array.isArray(tables)) throw new CompactError("usage", "eventFactsOf: the tables are not a list");
  const table = tables.length === 1 && tables[0] instanceof Map ? tables[0] : mergeFacts(tables);
  return (key) => {
    const bits = table.get(key);
    if (bits === undefined) return undefined;
    const certAges: CertAge[] = [];
    for (const [bit, facts] of bits) if (facts.cert_age !== undefined) certAges.push({ bit, seconds: facts.cert_age });
    return certAges.length === 0 ? undefined : { certAges };
  };
}
