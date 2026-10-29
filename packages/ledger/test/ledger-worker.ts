// packages/ledger/test/ledger-worker.ts — the Worker the ledger workerd test
// runs. It proves packages/ledger/src runs in workerd under the pinned
// compatibility date and flags (no nodejs_compat): the key hash (Math.imul),
// the filter and delta bytes (DataView, BigInt, the CRC-32), first seen across
// precisions, the corpus state, and the aggregation of names with the PSL.
//
//   POST /ledger   the body is JSON: { keys, filter, delta, record, psl, names }:
//                  keys to hash and ask the filter and delta (given as hex),
//                  a domain record for first and last seen (bit 0 a day source,
//                  bit 5 a second source), the PSL text, and name records to
//                  aggregate. Answers what each gives.
// A LedgerError answers 422 with its code and message. Any other path or
// method answers 404.
import { loadPsl } from "@domains/names";
import { type DomainRecord, fromHex, type NameRecord } from "@domains/pack";
import { aggregateToDomains, BloomFilter, corpusState, firstSeen, HashDelta, hashHex, hashKey, LedgerError, lastSeen, ProvisionalFilter, precisionsOf } from "../src/index.ts";

interface Ask {
  keys: string[];
  filter: string;
  delta: string;
  record: DomainRecord;
  psl: string;
  names: NameRecord[];
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function ledger(request: Request): Promise<Response> {
  const ask = (await request.json()) as Ask;
  try {
    const seen = new ProvisionalFilter(BloomFilter.decode(fromHex(ask.filter)), HashDelta.decode(fromHex(ask.delta)));
    const precision = precisionsOf([
      { bit: 0, precision: "day" },
      { bit: 5, precision: "second" },
    ]);
    const domains: DomainRecord[] = [];
    for await (const d of aggregateToDomains(ask.names, await loadPsl(ask.psl))) domains.push(d);
    return json({
      hashes: ask.keys.map((k) => hashHex(hashKey(k))),
      has: ask.keys.map((k) => seen.has(hashKey(k))),
      delta: [...seen.delta.hashes()].map(hashHex),
      first: firstSeen(ask.record, precision),
      last: lastSeen(ask.record, precision),
      state: [corpusState("2026-11-29T23:59:59Z", "2026-09-01"), corpusState("2026-11-30", "2026-09-01")],
      domains,
    });
  } catch (error) {
    if (error instanceof LedgerError) return json({ code: error.code, message: error.message }, 422);
    throw error;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/ledger") return ledger(request);
    return new Response("not found", { status: 404 });
  },
};
