// packages/state/src/state.ts: state.json (domains.state.v1). A state reads
// back from its canonical bytes as it was written; each rule of the format is
// refused with its code (`format`, `schema`, `size`), the size before any
// parsing; sameState compares all but `updated`, with null as the state that
// holds nothing; owe adds a pack once, in order. All values are synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  cursorOf,
  emptyState,
  encodeState,
  HISTORY_DAYS,
  historyOf,
  type OwedItem,
  owe,
  parseState,
  STATE_FORMAT,
  STATE_MAX_BYTES,
  type State,
  StateError,
  sameState,
  validateState,
} from "../src/index.ts";

const D1 = `sha256:${"1".repeat(64)}`;
const D2 = `sha256:${"2".repeat(64)}`;
const D3 = `sha256:${"3".repeat(64)}`;
const D4 = `sha256:${"4".repeat(64)}`;
// The first 12 hex of the synthetic raw file of isc-new's day.
const SHA12 = "8a6ed92e6b78";
const NOW = "2026-10-30T08:30:12Z";

const owed = (ref: string, digest: string, dataset: OwedItem["dataset"], start: string, end: string): OwedItem => ({
  ref,
  digest,
  dataset,
  tier: dataset === "feed" ? "h" : "seg",
  start,
  end,
  since: NOW,
});

// A state with one of everything: a stream cursor and a day cursor, the
// history of a day source, and owed segments of both kinds and an hour pack.
function sample(): State {
  return {
    format: STATE_FORMAT,
    updated: NOW,
    cursors: { "oi-cs": { topics: { certstream_domains: { "0": 7 } }, through: "2026-10-30T08:20:00Z" }, "isc-new": { last_day: "2026-10-29" } },
    moved: { "oi-cs": { at: NOW, run: "40000000001" }, "isc-new": { at: "2026-10-30T06:00:05Z", run: "local" } },
    history: {
      "isc-new": [
        { day: "2026-10-28", count: 120, quarantined: false },
        { day: "2026-10-29", count: 123, quarantined: true },
      ],
    },
    owed: [
      owed(`obs:isc-new.20261029.${SHA12}`, D1, "names", "2026-10-29T00:00:00Z", "2026-10-30T00:00:00Z"),
      owed("feed:feed-h-2026103007", D2, "feed", "2026-10-30T07:00:00Z", "2026-10-30T08:00:00Z"),
      owed("obs:oi-cs.20261030t080000z.20261030t081000z", D3, "names", "2026-10-30T08:00:00Z", "2026-10-30T08:10:00Z"),
      owed("obs:oi-cs.20261030t080000z.20261030t081000z-d", D4, "domains", "2026-10-30T08:00:00Z", "2026-10-30T08:10:00Z"),
    ],
  };
}

function refuses(fn: () => unknown, code: string, message?: RegExp): StateError {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof StateError, `expected a StateError ${code}, got ${String(e)}`);
    assert.equal(e.code, code, e.message);
    if (message !== undefined) assert.match(e.message, message);
    return e;
  }
  assert.fail(`expected a StateError ${code}, and nothing was thrown`);
}

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
// `v` without the key `k`.
const without = (v: Record<string, unknown>, k: string): Record<string, unknown> => Object.fromEntries(Object.entries(v).filter(([key]) => key !== k));
// A copy of the sample as plain JSON, for planting one fault.
const plain = (): Record<string, unknown> => JSON.parse(JSON.stringify(sample())) as Record<string, unknown>;

test("state: the empty state is canonical JSON, keys sorted, with one newline, and reads back equal", () => {
  const empty = emptyState(NOW);
  const bytes = encodeState(empty);
  assert.equal(text(bytes), `{"cursors":{},"format":"domains.state.v1","history":{},"moved":{},"owed":[],"updated":"${NOW}"}\n`);
  assert.deepEqual(parseState(bytes), empty);
  assert.deepEqual(parseState(text(bytes)), empty);
  refuses(() => emptyState("2026-10-30T08:30:12.000Z"), "usage", /to the second/);
  refuses(() => emptyState("2026-10-30"), "usage");
  // The years a tag names, 1000 to 9999, and no other.
  refuses(() => emptyState("0999-12-31T23:59:59Z"), "usage");
  assert.equal(emptyState("1000-01-01T00:00:00Z").updated, "1000-01-01T00:00:00Z");
  assert.equal(emptyState("9999-12-31T23:59:59Z").updated, "9999-12-31T23:59:59Z");
});

test("state: a full state round-trips through its bytes, and the bytes do not depend on the order a writer built it in", () => {
  const s = sample();
  const bytes = encodeState(s);
  assert.deepEqual(parseState(bytes), s);
  assert.deepEqual(encodeState(parseState(bytes)), bytes);
  // The same state built with its keys in reverse order gives the same bytes.
  const reversed = Object.fromEntries(Object.entries(s).reverse()) as unknown as State;
  assert.deepEqual(encodeState(reversed), bytes);
  const t = text(bytes);
  assert.ok(t.endsWith("}\n") && !t.endsWith("\n\n"));
  assert.ok(
    t.startsWith(
      '{"cursors":{"isc-new":{"last_day":"2026-10-29"},"oi-cs":{"through":"2026-10-30T08:20:00Z","topics":{"certstream_domains":{"0":7}}}},"format":"domains.state.v1","history":{"isc-new":[{"count":120,',
    ),
  );
  assert.ok(!/\s/.test(t.slice(0, -1)), "no whitespace but the final newline");
});

test("state: each rule of state.json is refused with its code", () => {
  const cases: [string, (v: Record<string, unknown>) => unknown, string, RegExp][] = [
    ["not an object", () => [], "schema", /not an object/],
    ["another format", (v) => ({ ...v, format: "domains.state.v2" }), "format", /the format is "domains\.state\.v2"; this reader knows domains\.state\.v1/],
    ["no format", (v) => ({ ...v, format: undefined }), "format", /the format is nothing/],
    ["a key missing", (v) => without(v, "owed"), "schema", /owed missing/],
    ["a key unknown", (v) => ({ ...v, extra: 1 }), "schema", /unknown field extra/],
    ["updated off the second", (v) => ({ ...v, updated: "2026-10-30T08:30:12.5Z" }), "schema", /updated .* is not an ISO 8601 UTC time to the second/],
    ["updated not a calendar time", (v) => ({ ...v, updated: "2026-02-30T00:00:00Z" }), "schema", /updated/],
    // A time is of the years 1000 to 9999, which a tag names (stateRunTag of @domains/ghcr).
    ["updated in the year 999", (v) => ({ ...v, updated: "0999-12-31T23:59:59Z" }), "schema", /updated "0999-12-31T23:59:59Z" is not an ISO 8601 UTC time to the second/],
    ["updated in the year 1", (v) => ({ ...v, updated: "0001-01-01T00:00:00Z" }), "schema", /updated "0001-01-01T00:00:00Z"/],
    ["cursors a number", (v) => ({ ...v, cursors: 5 }), "schema", /^state\.json: cursors is not an object$/],
    ["cursors a list", (v) => ({ ...v, cursors: [] }), "schema", /^state\.json: cursors is not an object$/],
    ["moved a number", (v) => ({ ...v, moved: 5 }), "schema", /^state\.json: moved is not an object$/],
    ["moved a list", (v) => ({ ...v, moved: [] }), "schema", /^state\.json: moved is not an object$/],
    ["a moved item that is null", (v) => ({ ...v, moved: { ...(v.moved as object), "oi-cs": null } }), "schema", /^state\.json: moved\.oi-cs is not an object$/],
    ["history a number", (v) => ({ ...v, history: 5 }), "schema", /^state\.json: history is not an object$/],
    ["history a list", (v) => ({ ...v, history: [] }), "schema", /^state\.json: history is not an object$/],
    ["a history list that is an object", (v) => ({ ...v, history: { "isc-new": { day: "2026-10-29" } } }), "schema", /^state\.json: history\.isc-new is not a list$/],
    ["a history list that is a number", (v) => ({ ...v, history: { "isc-new": 7 } }), "schema", /^state\.json: history\.isc-new is not a list$/],
    ["a history item that is null", (v) => ({ ...v, history: { "isc-new": [null] } }), "schema", /^state\.json: history\.isc-new\[0\] is not an object$/],
    ["an owed item that is null", (v) => ({ ...v, owed: [null] }), "schema", /^state\.json: owed\[0\] is not an object$/],
    [
      "a moved run of 21 digits",
      (v) => ({ ...v, moved: { ...(v.moved as object), "oi-cs": { at: NOW, run: `1${"0".repeat(20)}` } } }),
      "schema",
      /moved\.oi-cs\.run "10{20}" is not a workflow run id nor "local"/,
    ],
    [
      "a cursor key off the id grammar",
      (v) => ({ ...v, cursors: { ...(v.cursors as object), Oi: 1 }, moved: { ...(v.moved as object), Oi: { at: NOW, run: "local" } } }),
      "schema",
      /cursors names "Oi"/,
    ],
    ["a cursor key over 63 characters", (v) => ({ ...v, cursors: { [`a${"-b".repeat(32)}`]: 1 }, moved: { [`a${"-b".repeat(32)}`]: { at: NOW, run: "local" } } }), "schema", /at most 63/],
    ["a cursor over 4 KiB", (v) => ({ ...v, cursors: { ...(v.cursors as object), "oi-cs": "x".repeat(5000) } }), "schema", /cursors\.oi-cs: \d+ bytes of JSON, over 4096/],
    ["moved without its cursor", (v) => ({ ...v, moved: { ...(v.moved as object), "ct-le": { at: NOW, run: "local" } } }), "schema", /each cursor has one moved/],
    ["a cursor without its moved", (v) => ({ ...v, moved: { "oi-cs": { at: NOW, run: "1" } } }), "schema", /each cursor has one moved/],
    ["moved run off the grammar", (v) => ({ ...v, moved: { ...(v.moved as object), "oi-cs": { at: NOW, run: "0123" } } }), "schema", /moved\.oi-cs\.run "0123"/],
    ["moved at off the second", (v) => ({ ...v, moved: { ...(v.moved as object), "oi-cs": { at: "2026-10-30", run: "1" } } }), "schema", /moved\.oi-cs\.at/],
    ["moved with an unknown field", (v) => ({ ...v, moved: { ...(v.moved as object), "oi-cs": { at: NOW, run: "1", by: "x" } } }), "schema", /moved\.oi-cs: unknown field by/],
    ["a history key off the id grammar", (v) => ({ ...v, history: { "isc.new": [{ day: "2026-10-29", count: 1, quarantined: false }] } }), "schema", /history names "isc\.new"/],
    ["an empty history list", (v) => ({ ...v, history: { "isc-new": [] } }), "schema", /history\.isc-new is empty/],
    [
      "a history day twice",
      (v) => ({
        ...v,
        history: {
          "isc-new": [
            { day: "2026-10-29", count: 1, quarantined: false },
            { day: "2026-10-29", count: 2, quarantined: false },
          ],
        },
      }),
      "schema",
      /history lists 2026-10-29 twice/,
    ],
    [
      "a history out of day order",
      (v) => ({
        ...v,
        history: {
          "isc-new": [
            { day: "2026-10-29", count: 1, quarantined: false },
            { day: "2026-10-28", count: 2, quarantined: false },
          ],
        },
      }),
      "schema",
      /not sorted by day/,
    ],
    ["a history day off the calendar", (v) => ({ ...v, history: { "isc-new": [{ day: "2026-02-30", count: 1, quarantined: false }] } }), "schema", /is not YYYY-MM-DD/],
    ["a history count not whole", (v) => ({ ...v, history: { "isc-new": [{ day: "2026-10-29", count: 1.5, quarantined: false }] } }), "schema", /count 1\.5 is not a whole number/],
    ["a history count below 0", (v) => ({ ...v, history: { "isc-new": [{ day: "2026-10-29", count: -1, quarantined: false }] } }), "schema", /count -1 is not a finite number of at least 0/],
    ["a history item with an unknown field", (v) => ({ ...v, history: { "isc-new": [{ day: "2026-10-29", count: 1, quarantined: false, run: "1" }] } }), "schema", /unknown field run/],
    [
      "more history days than kept",
      (v) => ({
        ...v,
        history: { "isc-new": Array.from({ length: HISTORY_DAYS + 1 }, (_, i) => ({ day: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10), count: 1, quarantined: false })) },
      }),
      "schema",
      /holds 91 days, over 90/,
    ],
    ["owed not a list", (v) => ({ ...v, owed: {} }), "schema", /owed is not a list/],
  ];
  // Faults of one owed item: index 2 is oi-cs's names segment of 08:00 to 08:10.
  const item = (patch: Record<string, unknown>) => (v: Record<string, unknown>) => ({
    ...v,
    owed: (v.owed as Record<string, unknown>[]).map((o, i) => (i === 2 ? Object.fromEntries(Object.entries({ ...o, ...patch }).filter(([, x]) => x !== undefined)) : o)),
  });
  const owedCases: [string, Record<string, unknown>, RegExp][] = [
    ["an owed field missing", { since: undefined }, /owed\[2\]: since missing/],
    ["an owed field unknown", { source: "oi-cs" }, /owed\[2\]: unknown field source/],
    ["a ref that is not PACKAGE:TAG", { ref: "oi-cs.20261030t080000z.20261030t081000z" }, /is not a ref PACKAGE:TAG/],
    ["a ref of no package", { ref: "obj:oi-cs.20261030t080000z.20261030t081000z" }, /not one of the packages/],
    ["a ref of another package", { ref: "names:names-d-20261030", dataset: "names", tier: "seg" }, /is of the package names; an owed pack is a segment of obs or an hour pack of feed/],
    ["a tag off the grammar", { ref: "obs:OI-cs.20261030t080000z.20261030t081000z" }, /is not a tag/],
    ["a digest off its form", { digest: D3.replace("sha256:", "sha512:") }, /digest .* is not sha256: and 64 lowercase hex digits/],
    ["a digest with a character after", { digest: `${D3}z` }, /digest .* is not sha256: and 64 lowercase hex digits/],
    ["a digest with a character before", { digest: `x${D3}` }, /digest .* is not sha256: and 64 lowercase hex digits/],
    ["a ref that is a number", { ref: 5 }, /owed\[2\]\.ref: 5 is not a ref PACKAGE:TAG/],
    // A LayoutError of a tag is the state's schema refusal, never its own class.
    ["a segment of a source id of 64 characters", { ref: `obs:a${"-b".repeat(31)}c.20261030t080000z.20261030t081000z` }, /owed\[2\]\.ref: .* has no tag: .* is not a source id/],
    ["a segment of tier h", { tier: "h" }, /is a segment of obs, so tier seg and dataset names or domains/],
    ["a segment of dataset feed", { dataset: "feed" }, /is a segment of obs, so tier seg/],
    ["a start off the second", { start: "2026-10-30T08:00:00.000Z" }, /owed\[2\]\.start/],
    ["a since that is not a time", { since: "yesterday" }, /owed\[2\]\.since/],
    ["a start not before its end", { end: "2026-10-30T08:00:00Z" }, /start 2026-10-30T08:00:00Z is not before end/],
    [
      "a window the tag does not name",
      { end: "2026-10-30T08:20:00Z" },
      /is not the tag of a names segment of oi-cs from 2026-10-30T08:00:00Z to 2026-10-30T08:20:00Z, which is oi-cs\.20261030t080000z\.20261030t082000z/,
    ],
    ["a domains segment under the names tag", { dataset: "domains" }, /is not the tag of a domains segment of oi-cs .* which is oi-cs\.20261030t080000z\.20261030t081000z-d/],
  ];
  for (const [name, patch, re] of owedCases) cases.push([name, item(patch), "schema", re]);
  const hourItem = (patch: Record<string, unknown>) => (v: Record<string, unknown>) => ({ ...v, owed: (v.owed as Record<string, unknown>[]).map((o, i) => (i === 1 ? { ...o, ...patch } : o)) });
  cases.push(
    ["an hour pack of tier seg", hourItem({ tier: "seg" }), "schema", /is an hour pack of feed, so tier h and dataset feed/],
    [
      "an hour pack of another hour",
      hourItem({ start: "2026-10-30T06:00:00Z", end: "2026-10-30T07:00:00Z" }),
      "schema",
      /feed-h-2026103007 spans the hour from 2026-10-30T07:00:00Z, not 2026-10-30T06:00:00Z to 2026-10-30T07:00:00Z/,
    ],
    ["an hour pack longer than its hour", hourItem({ end: "2026-10-30T09:00:00Z" }), "schema", /spans the hour from 2026-10-30T07:00:00Z, not/],
    ["a feed pack of another tier", hourItem({ ref: "feed:feed-d-20261030" }), "schema", /feed-d-20261030 is a feed pack of tier d, not an hour pack of feed/],
    ["an hour pack of dataset names", hourItem({ dataset: "names" }), "schema", /is an hour pack of feed, so tier h and dataset feed; it says tier "h" and dataset "names"/],
    ["a names hour pack under feed", hourItem({ ref: "feed:names-h-2026103007" }), "schema", /names-h-2026103007 is a names pack of tier h, not an hour pack of feed/],
    ["a feed tag that is no tier tag", hourItem({ ref: "feed:feed-x" }), "schema", /owed\[1\]\.ref: feed-x is not a tier tag/],
    [
      "a file segment of another day",
      (v) => ({ ...v, owed: (v.owed as Record<string, unknown>[]).map((o, i) => (i === 0 ? { ...o, ref: `obs:isc-new.20261028.${SHA12}` } : o)) }),
      "schema",
      /which is isc-new\.20261029\.8a6ed92e6b78/,
    ],
    ["an owed ref twice", (v) => ({ ...v, owed: [...(v.owed as unknown[]), (v.owed as unknown[])[3]] }), "schema", /owed lists obs:oi-cs\.20261030t080000z\.20261030t081000z-d twice/],
    ["owed out of order", (v) => ({ ...v, owed: [...(v.owed as unknown[])].reverse() }), "schema", /owed is not sorted by start, then ref/],
    [
      "owed of one start out of ref order",
      (v) => {
        const o = [...(v.owed as unknown[])];
        [o[2], o[3]] = [o[3], o[2]];
        return { ...v, owed: o };
      },
      "schema",
      /owed is not sorted by start, then ref: obs:oi-cs\.20261030t080000z\.20261030t081000z from/,
    ],
  );
  for (const [name, plant, code, re] of cases) {
    const v = plant(plain());
    const e = refuses(() => validateState(v), code, re);
    assert.ok(e.message.startsWith("state.json: "), `${name}: ${e.message}`);
    // The same fault in bytes is refused alike.
    if (v !== undefined) refuses(() => parseState(JSON.stringify(v)), code, re);
  }
  // The sample itself passes every rule.
  assert.deepEqual(validateState(plain()), sample());
});

test("state: bytes over 1 MiB are refused as size before they are parsed, and bytes that are not UTF-8 JSON as format", () => {
  // Not JSON at all, and one byte over: the size is what is refused.
  refuses(() => parseState(new Uint8Array(STATE_MAX_BYTES + 1).fill(0x7b)), "size", /^state\.json is 1048577 bytes, over 1048576$/);
  refuses(() => parseState("{".repeat(STATE_MAX_BYTES + 1)), "size");
  // Two UTF-8 bytes a character: a string under the limit in units, over it in bytes.
  refuses(() => parseState("é".repeat(STATE_MAX_BYTES / 2 + 1)), "size", /1048578 bytes/);
  refuses(() => parseState(new Uint8Array([0x7b, 0xff, 0x7d])), "format", /not UTF-8/);
  refuses(() => parseState("{"), "format", /not JSON/);
  refuses(() => parseState(""), "format", /not JSON/);
  refuses(() => parseState(7 as unknown as string), "usage");
  // A byte order mark is no part of JSON: bytes with one read as the same text does, refused.
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encodeState(sample())]);
  refuses(() => parseState(bom), "format", /not JSON/);
  refuses(() => parseState(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bom)), "format", /not JSON/);
  // Well-formed JSON that is no state, read or written, is refused by the rules of the header.
  refuses(() => parseState('{"format":"x"}'), "format");
  refuses(() => parseState("[]"), "schema", /not an object/);
  refuses(() => encodeState({ ...sample(), updated: "bad" }), "schema", /updated "bad"/);
  refuses(() => encodeState({ ...sample(), format: "domains.state.v2" } as unknown as State), "format");
  // A state whose encoding is over the limit is refused when written.
  const big = sample();
  const cursors: Record<string, string> = {};
  const moved: Record<string, { at: string; run: string }> = {};
  for (let i = 0; i < 300; i++) {
    cursors[`a${i}`] = "x".repeat(4000);
    moved[`a${i}`] = { at: NOW, run: "local" };
  }
  refuses(() => encodeState({ ...big, cursors, moved }), "size", /^state\.json is \d+ bytes, over 1048576$/);
  // Exactly at the limit reads.
  const exact = encodeState(sample());
  const padded = new Uint8Array(STATE_MAX_BYTES).fill(0x20);
  padded.set(exact);
  assert.deepEqual(parseState(padded), sample());
});

test("state: sameState compares all but updated, and null equals a state with no cursor, history or owed item", () => {
  const s = sample();
  assert.ok(sameState(s, { ...s, updated: "2026-10-31T00:00:00Z" }));
  assert.ok(!sameState(s, { ...s, cursors: { ...s.cursors, "oi-cs": { offset: 1 } } }));
  assert.ok(!sameState(s, { ...s, moved: { ...s.moved, "oi-cs": { at: NOW, run: "2" } } }));
  assert.ok(!sameState(s, { ...s, history: {} }));
  assert.ok(!sameState(s, { ...s, owed: s.owed.slice(1) }));
  assert.ok(sameState(null, null));
  assert.ok(sameState(null, emptyState(NOW)));
  assert.ok(sameState(emptyState("2026-01-01T00:00:00Z"), null));
  assert.ok(!sameState(null, s));
  assert.ok(!sameState(null, { ...emptyState(NOW), owed: s.owed }));
  assert.ok(!sameState(null, { ...emptyState(NOW), history: s.history }));
});

test("state: cursorOf and historyOf answer the stored value, and null and none for an adapter or source the state lacks", () => {
  const s = sample();
  assert.deepEqual(cursorOf(s, "isc-new"), { last_day: "2026-10-29" });
  assert.equal(cursorOf(s, "ct-le"), null);
  assert.equal(cursorOf(null, "isc-new"), null);
  // A key of Object.prototype is no adapter.
  assert.equal(cursorOf(s, "constructor"), null);
  assert.deepEqual(historyOf(s, "isc-new"), s.history["isc-new"]);
  assert.deepEqual(historyOf(s, "oi-cs"), []);
  assert.deepEqual(historyOf(null, "isc-new"), []);
  assert.deepEqual(historyOf(s, "toString"), []);
});

test("state: owe adds a pack in its order and sets updated, keeps a state that owes the ref, and refuses the ref under another digest", () => {
  const s = sample();
  const later = "2026-10-30T09:00:00Z";
  const hour = owed("feed:feed-h-2026103008", D1, "feed", "2026-10-30T08:00:00Z", "2026-10-30T09:00:00Z");
  const next = owe(s, hour, later);
  assert.equal(next.updated, later);
  assert.deepEqual(
    next.owed.map((o) => o.ref),
    [s.owed[0]!.ref, s.owed[1]!.ref, "feed:feed-h-2026103008", s.owed[2]!.ref, s.owed[3]!.ref],
  );
  assert.deepEqual(validateState(next), next);
  // The input is not changed.
  assert.equal(s.owed.length, 4);
  // A ref owed already: the state as it was, the first `since` kept.
  assert.equal(owe(next, { ...hour, since: later }, "2026-10-30T10:00:00Z"), next);
  refuses(() => owe(next, { ...hour, digest: D2 }, later), "schema", /feed:feed-h-2026103008 is owed as .*sha256:1{64}.*, and this item says .*sha256:2{64}/);
  refuses(() => owe(s, { ...hour, tier: "seg" }, later), "schema", /is an hour pack of feed/);
  refuses(() => owe(s, hour, "2026-10-30T09:00:00.000Z"), "usage");
});

test("state: the package exports the values of DOM-024's binding surface, with the run and time grammars the scripts share, and nothing else", async () => {
  const surface = await import("../src/index.ts");
  assert.deepEqual(Object.keys(surface).sort(), [
    "HISTORY_DAYS",
    "LANES",
    "OWED_DAYS",
    "PROPOSAL_FORMAT",
    "PROPOSAL_MAX_BYTES",
    "RUN_ID",
    "STATE_FORMAT",
    "STATE_MAX_BYTES",
    "STATE_MEDIA_TYPE",
    "STATE_TITLE",
    "StateError",
    "advance",
    "cursorOf",
    "emptyState",
    "encodeProposal",
    "encodeState",
    "guard",
    "historyOf",
    "isSecond",
    "owe",
    "parseProposal",
    "parseState",
    "proposalFile",
    "propose",
    "proposedRefs",
    "sameState",
    "settle",
    "validateProposal",
    "validateState",
  ]);
  assert.deepEqual([surface.STATE_FORMAT, surface.PROPOSAL_FORMAT, surface.STATE_TITLE, surface.STATE_MEDIA_TYPE], ["domains.state.v1", "domains.proposal.v1", "state.json", "application/json"]);
  assert.deepEqual([surface.STATE_MAX_BYTES, surface.PROPOSAL_MAX_BYTES, surface.HISTORY_DAYS, surface.OWED_DAYS], [1_048_576, 1_048_576, 90, 7]);
  const e = new surface.StateError("stale", "x");
  assert.deepEqual([e.name, e.code, e.message, e instanceof Error], ["StateError", "stale", "x", true]);
});
