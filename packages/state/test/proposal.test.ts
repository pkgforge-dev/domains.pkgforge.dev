// packages/state/src/proposal.ts: the cursor proposal of one adapter run
// (domains.proposal.v1). propose sorts what a run met in any order into one
// text, and refuses each rule with `proposal`; a reader refuses another
// format with `format` and bytes over 1 MiB with `size` before parsing. All
// values are synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { encodeProposal, LANES, PROPOSAL_FORMAT, PROPOSAL_MAX_BYTES, type ProposeInput, parseProposal, propose, proposalFile, proposedRefs, StateError, validateProposal } from "../src/index.ts";

const D = (c: string): string => `sha256:${c.repeat(64)}`;
const T0 = "2026-10-30T08:00:00Z";
const T1 = "2026-10-30T08:10:00Z";

// A stream run of two windows with raw bytes, and a day run with its history.
function input(): ProposeInput {
  return {
    adapter: "oi-cs",
    lane: "kafka",
    run: "40000000001",
    attempt: 1,
    at: "2026-10-30T08:20:00Z",
    before: { offset: 100 },
    after: { offset: 300 },
    // Out of ref order, as a run may meet them.
    segments: [
      { ref: "obs:oi-cs.20261030t081000z.20261030t082000z", digest: D("3"), source: "oi-cs", dataset: "names", start: T1, end: "2026-10-30T08:20:00Z", count: 2, quarantined: false },
      { ref: "obs:oi-cs.20261030t080000z.20261030t081000z-d", digest: D("2"), source: "oi-cs", dataset: "domains", start: T0, end: T1, count: 1, quarantined: false },
      { ref: "obs:oi-cs.20261030t080000z.20261030t081000z", digest: D("1"), source: "oi-cs", dataset: "names", start: T0, end: T1, count: 194303, quarantined: true },
    ],
    raw: [
      { ref: "obs:raw-oi-cs.20261030t081000z.20261030t082000z", digest: D("5"), source: "oi-cs", start: T1, end: "2026-10-30T08:20:00Z" },
      { ref: "obs:raw-oi-cs.20261030t080000z.20261030t081000z", digest: D("4"), source: "oi-cs", start: T0, end: T1 },
    ],
    history: [],
  };
}

function dayInput(): ProposeInput {
  const seg = { digest: D("6"), source: "isc-new", start: "2026-10-29T00:00:00Z", end: "2026-10-30T00:00:00Z", count: 123, quarantined: false };
  return {
    adapter: "isc-new",
    lane: "feeds",
    run: "local",
    attempt: 1,
    at: "2026-10-30T06:00:05Z",
    before: null,
    after: { last_day: "2026-10-29" },
    segments: [
      { ...seg, ref: "obs:isc-new.20261029.8a6ed92e6b78", dataset: "names" },
      { ...seg, ref: "obs:isc-new.20261029.8a6ed92e6b78-d", dataset: "domains", digest: D("7") },
    ],
    raw: [],
    history: [{ source: "isc-new", day: "2026-10-29", count: 123, quarantined: false }],
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

test("proposal: propose sorts segments and raw by ref and history by source and day, and the bytes read back as the proposal", () => {
  const p = propose(input());
  assert.equal(p.format, PROPOSAL_FORMAT);
  assert.deepEqual(
    p.segments.map((s) => s.ref),
    ["obs:oi-cs.20261030t080000z.20261030t081000z", "obs:oi-cs.20261030t080000z.20261030t081000z-d", "obs:oi-cs.20261030t081000z.20261030t082000z"],
  );
  assert.deepEqual(
    p.raw.map((r) => r.ref),
    ["obs:raw-oi-cs.20261030t080000z.20261030t081000z", "obs:raw-oi-cs.20261030t081000z.20261030t082000z"],
  );
  const bytes = encodeProposal(p);
  const text = new TextDecoder().decode(bytes);
  assert.ok(
    text.startsWith('{"adapter":"oi-cs","after":{"offset":300},"at":"2026-10-30T08:20:00Z","attempt":1,"before":{"offset":100},"format":"domains.proposal.v1","history":[],"lane":"kafka","raw":['),
  );
  assert.ok(text.endsWith("}\n") && !text.endsWith("\n\n"));
  assert.deepEqual(parseProposal(bytes), p);
  assert.deepEqual(parseProposal(text), p);
  // The same run met in another order gives the same bytes.
  const shuffled = input();
  assert.deepEqual(encodeProposal(propose({ ...shuffled, segments: [...shuffled.segments].reverse(), raw: [...shuffled.raw].reverse() })), bytes);
  const two = dayInput();
  const other = { ...two.history[0]!, source: "isc-old" };
  const withOther = { ...two, segments: [...two.segments, { ...two.segments[0]!, ref: "obs:isc-old.20261029.8a6ed92e6b78", source: "isc-old", digest: D("8") }] };
  assert.deepEqual(
    propose({ ...withOther, history: [other, two.history[0]!] }).history.map((h) => h.source),
    ["isc-new", "isc-old"],
  );
  // Two days of one source, met in either order, give one order: by day.
  const day28 = { ...two.segments[0]!, ref: "obs:isc-new.20261028.8a6ed92e6b78", start: "2026-10-28T00:00:00Z", end: "2026-10-29T00:00:00Z", digest: D("9") };
  const twoDays = { ...two, segments: [...two.segments, day28] };
  const h28 = { ...two.history[0]!, day: "2026-10-28" };
  for (const history of [
    [two.history[0]!, h28],
    [h28, two.history[0]!],
  ]) {
    assert.deepEqual(
      propose({ ...twoDays, history }).history.map((h) => h.day),
      ["2026-10-28", "2026-10-29"],
    );
  }
  assert.deepEqual(LANES, ["kafka", "tiles", "feeds"]);
  assert.ok(Object.isFrozen(LANES));
});

test("proposal: propose refuses each rule of a proposal with the code proposal", () => {
  const seg0 = input().segments[0]!;
  const cases: [string, (p: ProposeInput) => unknown, RegExp][] = [
    ["an empty proposal", (p) => ({ ...p, segments: [], raw: [], after: p.before }), /oi-cs names no segment and keeps its cursor \{"offset":100\}: an empty proposal moves nothing/],
    ["an empty first proposal", (p) => ({ ...p, segments: [], raw: [], before: null, after: null }), /an empty proposal moves nothing/],
    ["an adapter off the id grammar", (p) => ({ ...p, adapter: "OI-cs" }), /adapter "OI-cs" is not an adapter id/],
    ["a lane of no lane", (p) => ({ ...p, lane: "stream" }), /lane "stream" is not one of kafka, tiles, feeds, nor null/],
    ["a run off the grammar", (p) => ({ ...p, run: "0" }), /run "0" is not a workflow run id nor "local"/],
    ["a run as a number", (p) => ({ ...p, run: 40000000001 }), /run 40000000001 is not a workflow run id/],
    ["attempt 0", (p) => ({ ...p, attempt: 0 }), /attempt 0 is not a whole number of at least 1/],
    ["at off the second", (p) => ({ ...p, at: "2026-10-30T08:20:00.000Z" }), /at "2026-10-30T08:20:00\.000Z" is not an ISO 8601 UTC time to the second/],
    ["a cursor over 4 KiB", (p) => ({ ...p, after: { pad: "x".repeat(5000) } }), /after: \d+ bytes of JSON, over 4096/],
    ["a before that is not JSON", (p) => ({ ...p, before: { at: new Date(0) } }), /cursor: before: at: a Date is not plain JSON/],
    ["a field unknown", (p) => ({ ...p, source: "oi-cs" }), /unknown field source/],
    ["a field missing", (p) => Object.fromEntries(Object.entries(p).filter(([k]) => k !== "raw")), /raw missing/],
    ["segments not a list", (p) => ({ ...p, segments: {} }), /segments is not a list/],
    ["a segment of another package", (p) => ({ ...p, segments: [{ ...seg0, ref: "feed:feed-h-2026103008" }] }), /segments\[0\]\.ref feed:feed-h-2026103008 is of the package feed, not obs/],
    [
      "a segment whose tag is not its window's",
      (p) => ({ ...p, segments: [{ ...seg0, start: T0 }] }),
      /is not the tag of a names segment of oi-cs from 2026-10-30T08:00:00Z to 2026-10-30T08:20:00Z, which is oi-cs\.20261030t080000z\.20261030t082000z/,
    ],
    ["a segment whose tag is another source's", (p) => ({ ...p, segments: [{ ...seg0, source: "oi-cz" }] }), /which is oi-cz\.20261030t081000z\.20261030t082000z/],
    ["a domains segment without -d", (p) => ({ ...p, segments: [{ ...seg0, dataset: "domains" }] }), /which is oi-cs\.20261030t081000z\.20261030t082000z-d/],
    ["a names segment with -d", (p) => ({ ...p, segments: [{ ...seg0, ref: `${seg0.ref}-d` }] }), /is not the tag of a names segment/],
    ["a segment of dataset feed", (p) => ({ ...p, segments: [{ ...seg0, dataset: "feed" }] }), /segments\[0\]\.dataset "feed" is not names or domains/],
    ["a segment count below 0", (p) => ({ ...p, segments: [{ ...seg0, count: -1 }] }), /count -1 is not a whole number of at least 0/],
    ["a segment count not whole", (p) => ({ ...p, segments: [{ ...seg0, count: 1.5 }] }), /count 1\.5 is not a whole number/],
    ["a segment not true or false quarantined", (p) => ({ ...p, segments: [{ ...seg0, quarantined: 1 }] }), /quarantined is not true or false/],
    ["a segment digest off its form", (p) => ({ ...p, segments: [{ ...seg0, digest: D("A") }] }), /digest .* is not sha256: and 64 lowercase hex digits/],
    ["a segment window backwards", (p) => ({ ...p, segments: [{ ...seg0, start: "2026-10-30T08:20:00Z", end: T1 }] }), /start 2026-10-30T08:20:00Z is not before end 2026-10-30T08:10:00Z/],
    ["a segment with an unknown field", (p) => ({ ...p, segments: [{ ...seg0, precision: "second" }] }), /segments\[0\]: unknown field precision/],
    ["a segment named twice", (p) => ({ ...p, segments: [seg0, seg0] }), /segments is not sorted by ref, one each/],
    [
      "a raw ref that is not its window's raw tag",
      (p) => ({ ...p, raw: [{ ...p.raw[0]!, ref: "obs:oi-cs.20261030t081000z.20261030t082000z" }] }),
      /raw\[0\]\.ref: .* is not the raw lane object of oi-cs from 2026-10-30T08:10:00Z to 2026-10-30T08:20:00Z, which is raw-oi-cs\.20261030t081000z\.20261030t082000z/,
    ],
    ["a raw object of another source", (p) => ({ ...p, raw: [{ ...p.raw[0]!, source: "oi-cz" }] }), /which is raw-oi-cz\./],
    ["a segment ref as a raw ref", (p) => ({ ...p, raw: [{ ...p.raw[0]!, ref: seg0.ref, digest: seg0.digest }] }), /is not the raw lane object/],
    // No source id starts raw-, so no segment takes the raw lane tag of another source's window.
    [
      "a segment under a raw lane tag",
      (p) => ({ ...p, segments: [{ ...seg0, ref: "obs:raw-oi-cs.20261030t080000z.20261030t081000z", source: "raw-oi-cs", start: T0, end: T1 }], raw: [p.raw[1]!] }),
      /segments\[0\]\.ref: .* has no tag: "raw-oi-cs" is not a source id: raw- begins the raw lane's tags/,
    ],
    ["the same raw ref twice", (p) => ({ ...p, raw: [p.raw[1]!, p.raw[1]!] }), /obs:raw-oi-cs\.20261030t080000z\.20261030t081000z is named twice/],
    ["a raw item with an unknown field", (p) => ({ ...p, raw: [{ ...p.raw[0]!, extra: 1 }] }), /raw\[0\]: unknown field extra/],
    ["a run of 21 digits", (p) => ({ ...p, run: `1${"0".repeat(20)}` }), /run "10{20}" is not a workflow run id/],
    ["attempt not whole", (p) => ({ ...p, attempt: 1.5 }), /attempt 1\.5 is not a whole number of at least 1/],
    ["attempt a word", (p) => ({ ...p, attempt: "abc" }), /attempt "abc" is not a whole number of at least 1/],
    ["a digest with a character after", (p) => ({ ...p, segments: [{ ...seg0, digest: `${D("3")}z` }] }), /digest .* is not sha256: and 64 lowercase hex digits/],
    ["a digest with a character before", (p) => ({ ...p, segments: [{ ...seg0, digest: `x${D("3")}` }] }), /digest .* is not sha256: and 64 lowercase hex digits/],
    ["a segment that is null", (p) => ({ ...p, segments: [null] }), /^proposal: segments\[0\] is not an object$/],
    ["a raw object that is null", (p) => ({ ...p, raw: [null] }), /^proposal: raw\[0\] is not an object$/],
    ["a history day that is null", (p) => ({ ...p, history: [null] }), /^proposal: history\[0\] is not an object$/],
  ];
  for (const [name, plant, re] of cases) {
    const e = refuses(() => propose(plant(input()) as ProposeInput), "proposal", re);
    assert.ok(e.message.startsWith("proposal: "), `${name}: ${e.message}`);
  }
  const day = dayInput();
  const dayCases: [string, (p: ProposeInput) => unknown, RegExp][] = [
    ["a history day twice", (p) => ({ ...p, history: [p.history[0]!, { ...p.history[0]!, count: 7 }] }), /history lists isc-new on 2026-10-29 twice/],
    [
      "a history day with no segment of its day",
      (p) => ({ ...p, history: [{ ...p.history[0]!, day: "2026-10-28" }] }),
      /no segment of isc-new spans that day from 2026-10-28T00:00:00Z to 2026-10-29T00:00:00Z/,
    ],
    ["a history day of another source", (p) => ({ ...p, history: [{ ...p.history[0]!, source: "isc-old" }] }), /no segment of isc-old spans that day/],
    ["a history day off the calendar", (p) => ({ ...p, history: [{ ...p.history[0]!, day: "2026-02-30" }] }), /history\[0\]: the day\.day "2026-02-30" is not YYYY-MM-DD/],
    ["a history count below 0", (p) => ({ ...p, history: [{ ...p.history[0]!, count: -5 }] }), /history\[0\]: the day\.count -5 is not a finite number of at least 0/],
    ["a history item with an unknown field", (p) => ({ ...p, history: [{ ...p.history[0]!, metric: "count" }] }), /history\[0\]: unknown field metric/],
    [
      "a file segment of another day",
      (p) => ({ ...p, segments: [{ ...p.segments[0]!, start: "2026-10-28T00:00:00Z", end: "2026-10-29T00:00:00Z" }, p.segments[1]!] }),
      /which is isc-new\.20261028\.8a6ed92e6b78/,
    ],
    // A file segment's tag names its start alone: its window is still held to the second.
    [
      "a file segment ending at no time",
      (p) => ({ ...p, segments: [{ ...p.segments[0]!, end: "zzz" }, p.segments[1]!] }),
      /segments\[0\]: start .* and end "zzz" are not ISO 8601 UTC times to the second/,
    ],
    [
      "a file segment starting at a day",
      (p) => ({ ...p, segments: [{ ...p.segments[0]!, start: "2026-10-29" }, p.segments[1]!] }),
      /segments\[0\]: start "2026-10-29" .* are not ISO 8601 UTC times to the second/,
    ],
    ["a history count not whole", (p) => ({ ...p, history: [{ ...p.history[0]!, count: 1.5 }] }), /history\[0\]\.count 1\.5 is not a whole number/],
    // A day of history is backed by a segment of exactly that day.
    [
      "a history day backed by a segment of two days",
      (p) => ({ ...p, segments: p.segments.map((s) => ({ ...s, end: "2026-10-31T00:00:00Z" })) }),
      /no segment of isc-new spans that day from 2026-10-29T00:00:00Z to 2026-10-30T00:00:00Z/,
    ],
    [
      "a history day backed by a segment that starts a day early",
      (p) => ({
        ...p,
        segments: p.segments.map((s) => ({ ...s, start: "2026-10-28T00:00:00Z", end: "2026-10-30T00:00:00Z", ref: s.ref.replace("20261029", "20261028") })),
        history: [{ ...p.history[0]!, day: "2026-10-29" }],
      }),
      /no segment of isc-new spans that day from 2026-10-29T00:00:00Z to 2026-10-30T00:00:00Z/,
    ],
    // The day carries its segment's verdict (D18 of DOM-024): a quarantined segment's day is quarantined, and a clean one's is not.
    [
      "a clean history day of a quarantined segment",
      (p) => ({ ...p, segments: p.segments.map((s) => ({ ...s, quarantined: true })) }),
      /history lists isc-new on 2026-10-29 with quarantined false, and its names segment of that day has quarantined true/,
    ],
    [
      "a quarantined history day of a clean segment",
      (p) => ({ ...p, history: [{ ...p.history[0]!, quarantined: true }] }),
      /history lists isc-new on 2026-10-29 with quarantined true, and its names segment of that day has quarantined false/,
    ],
    // With a names and a domains segment of different verdicts, the day is the names segment's, both ways.
    [
      "a quarantined history day of a clean names segment and a quarantined domains segment",
      (p) => ({ ...p, segments: [p.segments[0]!, { ...p.segments[1]!, quarantined: true }], history: [{ ...p.history[0]!, quarantined: true }] }),
      /history lists isc-new on 2026-10-29 with quarantined true, and its names segment of that day has quarantined false/,
    ],
    [
      "a clean history day of a quarantined names segment and a clean domains segment",
      (p) => ({ ...p, segments: [{ ...p.segments[0]!, quarantined: true }, p.segments[1]!] }),
      /history lists isc-new on 2026-10-29 with quarantined false, and its names segment of that day has quarantined true/,
    ],
    // With a domains segment alone, the day is its.
    [
      "a clean history day of a quarantined domains segment alone",
      (p) => ({ ...p, segments: [{ ...p.segments[1]!, quarantined: true }] }),
      /history lists isc-new on 2026-10-29 with quarantined false, and its domains segment of that day has quarantined true/,
    ],
  ];
  for (const [name, plant, re] of dayCases) {
    const e = refuses(() => propose(plant(day) as ProposeInput), "proposal", re);
    assert.ok(e.message.startsWith("proposal: "), `${name}: ${e.message}`);
  }
  // The clean inputs pass.
  propose(input());
  propose(day);
  // A day whose names segment is clean and domains segment quarantined carries the names segment's verdict (run.mjs).
  const mixed = { ...day, segments: [day.segments[0]!, { ...day.segments[1]!, quarantined: true }] };
  assert.equal(propose(mixed).history[0]!.quarantined, false);
  const quarantined = { ...day, segments: day.segments.map((s) => ({ ...s, quarantined: true })), history: [{ ...day.history[0]!, quarantined: true }] };
  assert.equal(propose(quarantined).history[0]!.quarantined, true);
  const namesQuarantined = { ...day, segments: [{ ...day.segments[0]!, quarantined: true }, day.segments[1]!], history: [{ ...day.history[0]!, quarantined: true }] };
  assert.equal(propose(namesQuarantined).history[0]!.quarantined, true);
  const domainsAlone = { ...day, segments: [{ ...day.segments[1]!, quarantined: true }], history: [{ ...day.history[0]!, quarantined: true }] };
  assert.equal(propose(domainsAlone).history[0]!.quarantined, true);
  // A backfill names segments and keeps its cursor: not empty.
  assert.equal(propose({ ...input(), after: { offset: 100 } }).segments.length, 3);
  // A run that moved its cursor and wrote nothing: not empty either.
  assert.equal(propose({ ...input(), segments: [], raw: [] }).segments.length, 0);
});

test("proposal: a reader refuses another format with format, bytes over 1 MiB with size before parsing, and bytes that are not UTF-8 JSON with format", () => {
  const p = propose(input());
  refuses(() => validateProposal({ ...p, format: "domains.proposal.v2" }), "format", /^proposal: the format is "domains\.proposal\.v2"; this reader knows domains\.proposal\.v1$/);
  refuses(() => validateProposal(null), "proposal", /not an object/);
  refuses(() => parseProposal(new Uint8Array(PROPOSAL_MAX_BYTES + 1).fill(0x5b)), "size", /^proposal is 1048577 bytes, over 1048576$/);
  refuses(() => parseProposal(new Uint8Array([0xc3, 0x28])), "format", /not UTF-8/);
  refuses(() => parseProposal("{"), "format", /not JSON/);
  // A byte order mark is no part of JSON: bytes with one are refused as the same text is.
  const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...encodeProposal(p)]);
  refuses(() => parseProposal(bom), "format", /not JSON/);
  refuses(() => parseProposal(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bom)), "format", /not JSON/);
  // Well-formed JSON that is no proposal is refused, as is a proposal that breaks a rule, read or written.
  refuses(() => parseProposal('{"format":"x"}'), "format");
  refuses(() => parseProposal("[]"), "proposal", /not an object/);
  refuses(() => parseProposal(JSON.stringify({ ...p, run: "zz" })), "proposal", /run "zz"/);
  refuses(() => encodeProposal({ ...p, run: "zz" }), "proposal", /run "zz"/);
  refuses(() => encodeProposal({ ...p, attempt: 0 }), "proposal", /attempt 0/);
  // Unsorted segments in a file are refused; propose is what sorts them.
  refuses(() => validateProposal({ ...p, segments: [...p.segments].reverse() }), "proposal", /segments is not sorted by ref/);
  const bigCursor = { k: "x".repeat(4000) };
  const many = Array.from({ length: 4000 }, (_, i) => {
    const start = new Date(Date.UTC(2026, 9, 1) + i * 600_000).toISOString().replace(".000Z", "Z");
    const end = new Date(Date.UTC(2026, 9, 1) + (i + 1) * 600_000).toISOString().replace(".000Z", "Z");
    const stamp = (t: string) => t.replace(/[-:]/g, "").toLowerCase();
    return { ref: `obs:oi-cs.${stamp(start)}.${stamp(end)}`, digest: D("1"), source: "oi-cs", dataset: "names" as const, start, end, count: 1, quarantined: false };
  });
  refuses(() => encodeProposal(propose({ ...input(), before: bigCursor, segments: many, raw: [] })), "size", /^proposal is \d+ bytes, over 1048576$/);
});

test("proposal: proposalFile names proposal.<adapter>.json, and proposedRefs lists the segments, then the raw objects", () => {
  assert.equal(proposalFile("oi-cs"), "proposal.oi-cs.json");
  refuses(() => proposalFile("../oi-cs"), "usage");
  refuses(() => proposalFile("oi.cs"), "usage");
  refuses(() => proposalFile(""), "usage");
  const p = propose(input());
  assert.deepEqual(proposedRefs(p), [
    { ref: "obs:oi-cs.20261030t080000z.20261030t081000z", digest: D("1") },
    { ref: "obs:oi-cs.20261030t080000z.20261030t081000z-d", digest: D("2") },
    { ref: "obs:oi-cs.20261030t081000z.20261030t082000z", digest: D("3") },
    { ref: "obs:raw-oi-cs.20261030t080000z.20261030t081000z", digest: D("4") },
    { ref: "obs:raw-oi-cs.20261030t081000z.20261030t082000z", digest: D("5") },
  ]);
});
