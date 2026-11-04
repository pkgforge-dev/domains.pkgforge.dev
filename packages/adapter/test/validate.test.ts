// packages/adapter/src/validate.ts on synthetic inputs: one valid source, then
// each fault planted alone, which must give exactly its own problem. The bit map
// here is a synthetic two-id map, not config/source-bits.json (bits.test.ts
// reads that file).
import assert from "node:assert/strict";
import { test } from "node:test";
import { BITS_FORMAT, REGISTRY_FORMAT, SOURCE_FORMAT, type Source } from "../src/types.ts";
import {
  bitsAppendOnly,
  buildRegistry,
  ContractError,
  checkCursor,
  checkDraftUrl,
  checkGaps,
  checkRawMember,
  checkRawMemberBytes,
  factKeysWalk,
  factsProblem,
  MAX_CURSOR_BYTES,
  MAX_GAPS,
  MAX_ID,
  MAX_RAW_MEMBER_BYTES,
  MAX_URLS_CHARS,
  parseDuration,
  REGISTRY_COMMENT,
  renderRegistry,
  SourceError,
  validateBits,
  validateRegistry,
  validateSegment,
  validateSource,
  validateSourceFile,
} from "../src/validate.ts";

const BITS = validateBits({ format: BITS_FORMAT, bits: { "thc-ct": 0, "oi-nrd": 1 } });

// Synthetic: the shape of a THC row, not an adapter's file.
const GOOD = {
  id: "thc-ct",
  bit: 0,
  family: "ct",
  datasets: ["names", "domains"],
  precision: "day",
  kind: "ct_name",
  basis: ["ct-first"],
  cadence: "P1D",
  band: { metric: "bytes", min: 0.4, max: 2.5, relative: true },
  urls: ["https://feed.example.test/{date}.txt.gz"],
  retention: "unknown",
  parser: "thc-lines/1",
  failure_modes: ["A file is late or missing."],
};

// The [at, code] pairs of a source's problems, or [] when it is valid.
function problems(json: unknown, bits = BITS): [string, string][] {
  try {
    validateSource(json, bits);
    return [];
  } catch (err) {
    assert.ok(err instanceof SourceError, String(err));
    return err.problems.map((p) => [p.at, p.code]);
  }
}

const without = (field: string): Record<string, unknown> => {
  const { [field]: _, ...rest } = GOOD as Record<string, unknown>;
  return rest;
};

test("adapter validate: a valid source passes and comes back as a copy, fields in registry order", () => {
  const s = validateSource(Object.fromEntries(Object.entries(GOOD).reverse()), BITS);
  assert.deepEqual(Object.keys(s), ["id", "bit", "family", "datasets", "precision", "kind", "basis", "cadence", "band", "urls", "retention", "parser", "failure_modes"]);
  assert.deepEqual(s, GOOD);
  assert.notEqual(s.datasets, GOOD.datasets);
  assert.notEqual(s.band, GOOD.band);
});

test("adapter validate: a source.json with a reused bit is refused as bit-taken", () => {
  assert.deepEqual(problems({ ...GOOD, id: "oi-nrd", bit: 0 }), [["bit", "bit-taken"]]);
  assert.deepEqual(problems({ ...GOOD, id: "new-feed", bit: 1 }), [["bit", "bit-taken"]]);
});

test("adapter validate: a bit other than the map's, or an id the map lacks, is refused", () => {
  assert.deepEqual(problems({ ...GOOD, bit: 5 }), [["bit", "bit-mismatch"]]);
  assert.deepEqual(problems({ ...GOOD, id: "new-feed", bit: 7 }), [["bit", "bit-unknown"]]);
  assert.deepEqual(problems({ ...GOOD, bit: null }), [["bit", "bit-mismatch"]]);
  assert.deepEqual(problems({ ...GOOD, bit: 64 }), [["bit", "range"]]);
  assert.deepEqual(problems({ ...GOOD, bit: 1.5 }), [["bit", "type"]]);
});

test("adapter validate: no bit is allowed only for a source that feeds no masked dataset", () => {
  const rdns = { ...GOOD, id: "thc-rdns", bit: null, family: "dns", kind: "dns", basis: [], datasets: ["rev"] };
  assert.deepEqual(problems(rdns), []);
  assert.deepEqual(problems({ ...rdns, datasets: ["rev", "names"] }), [["bit", "bit-required"]]);
});

test("adapter validate: a source that writes no newness evidence lists no basis", () => {
  assert.deepEqual(problems({ ...GOOD, basis: [] }), []);
  assert.deepEqual(validateSource({ ...GOOD, basis: [] }, BITS).basis, []);
  // The other lists still need a value.
  assert.deepEqual(problems({ ...GOOD, basis: [], datasets: [] }), [["datasets", "empty"]]);
});

test("adapter validate: a URL that carries a credential, in its user part, its query or its fragment, is refused", () => {
  const credential = (url: string) => problems({ ...GOOD, urls: [url] });
  for (const url of [
    "https://feed.example.test/zone.csv?apikey=x",
    "https://feed.example.test/zone.csv?api_key=x",
    "https://feed.example.test/zone.csv?access_token=x",
    "https://feed.example.test/zone.csv?token=x",
    "https://feed.example.test/zone.csv?client_secret=x",
    "https://feed.example.test/zone.csv?sig=x",
    "https://feed.example.test/zone.csv?X-Amz-Signature=x",
    "https://feed.example.test/zone.csv?X-Amz-Credential=x",
    "https://feed.example.test/zone.csv?AWSAccessKeyId=x",
    "https://feed.example.test/zone.csv?auth=x",
    "https://feed.example.test/zone.csv?pwd=x",
    "https://feed.example.test/zone.csv?day=1#access_token=x",
    "https://feed.example.test/zone.csv#",
    "kafka://kafka.example.test:9092/t?sasl.password=x",
    "kafka://kafka.example.test:9092/t?sasl.mechanism=PLAIN",
    "kafka://kafka.example.test:9092/t?password=x",
  ])
    assert.deepEqual(credential(url), [["urls[0]", "credential"]], url);
  // A parameter whose name only contains a credential word is not one.
  for (const url of ["https://feed.example.test/x?keyword=a&author=b&design=c&day={date}", "kafka://kafka.example.test:9092/t?client.id=domains"]) assert.deepEqual(credential(url), [], url);
});

test("adapter validate: a missing failure_modes is refused, and so is an empty or blank one", () => {
  assert.deepEqual(problems(without("failure_modes")), [["failure_modes", "missing"]]);
  assert.deepEqual(problems({ ...GOOD, failure_modes: [] }), [["failure_modes", "empty"]]);
  assert.deepEqual(problems({ ...GOOD, failure_modes: ["  "] }), [["failure_modes[0]", "empty"]]);
  assert.deepEqual(problems({ ...GOOD, failure_modes: ["late", "late"] }), [["failure_modes[1]", "duplicate"]]);
});

test("adapter validate: every field is required", () => {
  for (const field of Object.keys(GOOD)) {
    const got = problems(without(field));
    assert.ok(
      got.some(([at, code]) => at === field && code === "missing"),
      `${field}: ${JSON.stringify(got)}`,
    );
  }
});

// The labels the older Premises of TODO/ingest.md wrote (DOM-026, DOM-048,
// DOM-051, DOM-057), each refused, and the labels docs/sources.md uses now.
test("adapter validate: the labels of the old Premises are refused, and the bases that replace them pass", () => {
  for (const basis of ["nrd-ct", "zone-list", "zone-walk"]) assert.deepEqual(problems({ ...GOOD, basis: [basis] }), [["basis[0]", "enum"]], basis);
  for (const basis of ["nrd-list", "zone"]) assert.deepEqual(problems({ ...GOOD, basis: [basis] }), [], basis);
  assert.deepEqual(problems({ ...GOOD, status: "reserved" }), [["status", "runtime-field"]]);
  assert.deepEqual(problems({ ...GOOD, partial: true }), [["partial", "unknown-field"]]);
});

test("adapter validate: each field's own fault gives its own problem", () => {
  const cases: [Record<string, unknown>, [string, string][]][] = [
    [{ id: "THC_ct" }, [["id", "grammar"]]],
    [{ id: "thc--ct" }, [["id", "grammar"]]],
    [{ id: `a${"-b".repeat(32)}` }, [["id", "grammar"]]],
    // raw- begins the raw lane's tags, which no source id takes.
    [{ id: "raw-ct" }, [["id", "grammar"]]],
    [{ licence: "x" }, [["licence", "unknown-field"]]],
    [{ through: "2026-10-27T00:00:00Z" }, [["through", "runtime-field"]]],
    [{ status: "ok" }, [["status", "runtime-field"]]],
    [{ fetched: "2026-10-27T00:00:00Z" }, [["fetched", "runtime-field"]]],
    [{ family: "cert" }, [["family", "enum"]]],
    [{ datasets: [] }, [["datasets", "empty"]]],
    [{ datasets: ["names", "names"] }, [["datasets[1]", "duplicate"]]],
    [{ datasets: ["nope"] }, [["datasets[0]", "enum"]]],
    [{ precision: "hour" }, [["precision", "enum"]]],
    [{ kind: "ct" }, [["kind", "enum"]]],
    [{ basis: "ct-first" }, [["basis", "type"]]],
    [{ basis: ["ct"] }, [["basis[0]", "enum"]]],
    [{ cadence: "P1M" }, [["cadence", "grammar"]]],
    [{ cadence: "PT" }, [["cadence", "grammar"]]],
    [{ cadence: "PT0S" }, [["cadence", "range"]]],
    [{ band: { metric: "rows", min: 0.4, max: 2.5, relative: true } }, [["band.metric", "enum"]]],
    [{ band: { metric: "bytes", min: 0.4, max: 2.5 } }, [["band.relative", "missing"]]],
    [{ band: { metric: "bytes", min: 0.4, max: 2.5, relative: "yes" } }, [["band.relative", "type"]]],
    [{ band: { metric: "bytes", min: 0.5, max: 0.4, relative: false } }, [["band.max", "range"]]],
    [{ band: { metric: "bytes", min: 1.2, max: 3, relative: true } }, [["band.min", "range"]]],
    // A relative band whose ceiling is below the median, one with max equal to min, and one with no finite max.
    [{ band: { metric: "bytes", min: 0.2, max: 0.9, relative: true } }, [["band.min", "range"]]],
    [{ band: { metric: "bytes", min: 0.5, max: 0.5, relative: false } }, [["band.max", "range"]]],
    [{ band: { metric: "bytes", min: 0.4, max: Number.POSITIVE_INFINITY, relative: true } }, [["band.max", "range"]]],
    [{ bit: -1 }, [["bit", "range"]]],
    [{ band: { metric: "bytes", min: -1, max: 3, relative: false } }, [["band.min", "range"]]],
    [{ band: { metric: "bytes", min: 0.4, max: 2.5, relative: true, floor: 1 } }, [["band.floor", "unknown-field"]]],
    [{ urls: [] }, [["urls", "empty"]]],
    [{ urls: ["ftp://feed.example.test/x"] }, [["urls[0]", "url"]]],
    [{ urls: ["not a url"] }, [["urls[0]", "url"]]],
    // A user name alone, and a password alone: either is refused.
    [{ urls: ["https://reader@feed.example.test/x"] }, [["urls[0]", "credential"]]],
    [{ urls: ["kafka://:pw@kafka.example.test:9092/t"] }, [["urls[0]", "credential"]]],
    // The urls joined by a space are one annotation of at most 1024 characters.
    [{ urls: [`https://feed.example.test/${"a".repeat(574)}`, `https://feed.example.test/${"b".repeat(574)}`] }, [["urls", "range"]]],
    [{ retention: "forever" }, [["retention", "grammar"]]],
    [{ retention: "PT0S" }, [["retention", "grammar"]]],
    [{ parser: "thc-lines" }, [["parser", "grammar"]]],
    [{ parser: "thc-lines/0" }, [["parser", "grammar"]]],
  ];
  for (const [change, want] of cases) assert.deepEqual(problems({ ...GOOD, ...change }), want, JSON.stringify(change));
  // Exactly 1024 characters joined is taken: two urls of 26 + 485 and the space.
  const edge = [`https://feed.example.test/${"a".repeat(485)}`, `https://feed.example.test/${"b".repeat(486)}`];
  assert.equal(edge.join(" ").length, MAX_URLS_CHARS);
  assert.deepEqual(problems({ ...GOOD, urls: edge }), []);
  assert.deepEqual(problems({ ...GOOD, urls: [...edge.slice(0, 1), `${edge[1]}c`] }), [["urls", "range"]]);
});

test("adapter validate: the accepted forms of each field pass", () => {
  for (const change of [
    { cadence: "PT10M" },
    { cadence: "P1DT6H" },
    { retention: "P13D" },
    { retention: "unbounded" },
    { urls: ["kafka://kafka.example.test:9092/newly_registered_domain", "wss://feed.example.test/ws/x"] },
    { band: { metric: "count", min: 100, max: 5000, relative: false } },
    { basis: ["nrd-ct+rdap", "zone"] },
  ]) {
    assert.deepEqual(problems({ ...GOOD, ...change }), [], JSON.stringify(change));
  }
});

test("adapter validate: every problem of one source is listed, not only the first", () => {
  assert.deepEqual(problems({ ...GOOD, id: "Bad", family: "x", parser: "y" }), [
    ["id", "grammar"],
    ["family", "enum"],
    ["parser", "grammar"],
  ]);
});

test("adapter validate: parseDuration reads days, hours, minutes and seconds only", () => {
  assert.equal(parseDuration("P1D"), 86400);
  assert.equal(parseDuration("PT10M"), 600);
  assert.equal(parseDuration("P1DT1H1M1S"), 90061);
  assert.equal(parseDuration("PT0S"), 0);
  for (const bad of ["P", "PT", "P1DT", "P1Y", "P1M", "1D", "P1.5D", "p1d", ""]) assert.equal(parseDuration(bad), null, bad);
});

test("adapter validate: a source.json holds a format and a list of sources, each id once", () => {
  const file = validateSourceFile({ format: SOURCE_FORMAT, sources: [GOOD] }, BITS);
  assert.equal(file.sources.length, 1);
  const codes = (json: unknown) => {
    try {
      validateSourceFile(json, BITS, "adapters/x/source.json");
      return [];
    } catch (err) {
      return (err as SourceError).problems.map((p) => [p.at, p.code]);
    }
  };
  assert.deepEqual(codes({ format: "domains.source.v0", sources: [GOOD] }), [["adapters/x/source.json.format", "format"]]);
  assert.deepEqual(codes({ format: SOURCE_FORMAT, sources: [] }), [["adapters/x/source.json.sources", "empty"]]);
  assert.deepEqual(codes({ format: SOURCE_FORMAT, sources: [GOOD, GOOD] }), [["adapters/x/source.json.sources", "duplicate"]]);
  assert.deepEqual(codes({ format: SOURCE_FORMAT, sources: [GOOD, { ...GOOD, id: "oi-nrd", bit: 0 }] }), [["adapters/x/source.json.sources[1].bit", "bit-taken"]]);
  assert.deepEqual(codes({ format: SOURCE_FORMAT }), [["adapters/x/source.json.sources", "missing"]]);
});

test("adapter validate: the bit map refuses a shared bit, a bit out of range, a bad id and a bit listed out of order", () => {
  const codes = (bits: unknown, extra: object = {}) => {
    try {
      validateBits({ format: BITS_FORMAT, bits, ...extra });
      return [];
    } catch (err) {
      return (err as SourceError).problems.map((p) => [p.at, p.code]);
    }
  };
  assert.deepEqual(codes({ a: 0, b: 1 }), []);
  assert.deepEqual(codes({ a: 0, b: 0 }), [["config/source-bits.json.bits.b", "bit-taken"]]);
  assert.deepEqual(codes({ a: 0, b: 64 }), [["config/source-bits.json.bits.b", "range"]]);
  assert.deepEqual(codes({ a: 0, B: 1 }), [["config/source-bits.json.bits.B", "grammar"]]);
  // raw- begins the raw lane's tags: a source id never takes it (rawTag of @domains/ghcr).
  assert.deepEqual(codes({ a: 0, "raw-oi-cs": 1 }), [["config/source-bits.json.bits.raw-oi-cs", "grammar"]]);
  assert.deepEqual(codes({ a: 0, "oi-raw": 1, rawx: 2 }), []);
  assert.deepEqual(codes({ a: 1, b: 0 }), [["config/source-bits.json.bits.b", "order"]]);
  assert.deepEqual(codes({ a: 0 }, { format: "domains.source-bits.v0" }), [["config/source-bits.json.format", "format"]]);
  assert.deepEqual(codes({ a: 0 }, { extra: 1 }), [["config/source-bits.json.extra", "unknown-field"]]);
  assert.deepEqual(codes([0]), [["config/source-bits.json.bits", "type"]]);
});

test("adapter validate: the append-only rule refuses a removed id and a changed bit", () => {
  const before = validateBits({ format: BITS_FORMAT, bits: { a: 0, b: 1 } });
  assert.deepEqual(bitsAppendOnly(before, validateBits({ format: BITS_FORMAT, bits: { a: 0, b: 1, c: 2 } })), []);
  assert.deepEqual(
    bitsAppendOnly(before, validateBits({ format: BITS_FORMAT, bits: { a: 0 } })).map((p) => p.code),
    ["missing"],
  );
  assert.deepEqual(
    bitsAppendOnly(before, validateBits({ format: BITS_FORMAT, bits: { a: 0, b: 2 } })).map((p) => p.code),
    ["bit-mismatch"],
  );
});

const file = (sources: unknown[]) => JSON.stringify({ format: SOURCE_FORMAT, sources });

test("adapter validate: the registry sorts by bit, then the sources with no bit by id, each with its adapter", () => {
  const rdns = { ...GOOD, id: "thc-rdns", bit: null, family: "dns", kind: "dns", basis: [], datasets: ["rev"] };
  const reg = buildRegistry(
    [
      { adapter: "oi-nrd", text: file([{ ...GOOD, id: "oi-nrd", bit: 1, precision: "second" }]) },
      { adapter: "thc", text: file([rdns, GOOD]) },
    ],
    BITS,
  );
  assert.equal(reg.format, REGISTRY_FORMAT);
  assert.equal(reg.comment, REGISTRY_COMMENT);
  assert.deepEqual(
    reg.sources.map((s) => [s.id, s.bit, s.adapter]),
    [
      ["thc-ct", 0, "thc"],
      ["oi-nrd", 1, "oi-nrd"],
      ["thc-rdns", null, "thc"],
    ],
  );
  const text = renderRegistry(reg);
  assert.ok(text.endsWith("}\n"));
  assert.deepEqual(validateRegistry(JSON.parse(text), BITS), reg);
  assert.deepEqual(buildRegistry([], BITS), { format: REGISTRY_FORMAT, comment: REGISTRY_COMMENT, sources: [] });
});

test("adapter validate: the registry build lists the problems of every file, a duplicate id across files among them", () => {
  try {
    buildRegistry(
      [
        { adapter: "a", text: file([GOOD]) },
        { adapter: "b", text: file([GOOD]) },
        { adapter: "c", text: "{ not json" },
        { adapter: "D_d", text: file([GOOD]) },
        { adapter: "e", text: file([without("failure_modes")]) },
      ],
      BITS,
    );
    assert.fail("no error");
  } catch (err) {
    assert.ok(err instanceof SourceError);
    assert.deepEqual(
      err.problems.map((p) => [p.at, p.code]),
      [
        ["adapters/b/source.json", "duplicate"],
        ["adapters/c/source.json", "json"],
        ["adapters/D_d", "grammar"],
        ["adapters/e/source.json.sources[0].failure_modes", "missing"],
      ],
    );
    assert.match(err.problems[0]!.detail, /also in adapters\/a\/source\.json/);
  }
});

test("adapter validate: a reader refuses a registry out of order, or a row without its adapter", () => {
  const row = { ...GOOD, adapter: "thc" } as Source & { adapter: string };
  const second = { ...GOOD, id: "oi-nrd", bit: 1, adapter: "oi-nrd" };
  const codes = (sources: unknown[]) => {
    try {
      validateRegistry({ format: REGISTRY_FORMAT, comment: "x", sources }, BITS);
      return [];
    } catch (err) {
      return (err as SourceError).problems.map((p) => [p.at, p.code]);
    }
  };
  assert.deepEqual(codes([row, second]), []);
  assert.deepEqual(codes([second, row]), [["config/sources.json.sources[1]", "order"]]);
  assert.deepEqual(codes([GOOD]), [["config/sources.json.sources[0].adapter", "missing"]]);
  assert.deepEqual(codes([row, row]), [["config/sources.json.sources[1]", "duplicate"]]);
  assert.deepEqual(codes([{ ...row, adapter: "THC_x" }]), [["config/sources.json.sources[0].adapter", "grammar"]]);
  // The build refuses a directory name above MAX_ID, so the reader does too.
  assert.deepEqual(codes([{ ...row, adapter: "a".repeat(MAX_ID) }]), []);
  assert.deepEqual(codes([{ ...row, adapter: "a".repeat(MAX_ID + 1) }]), [["config/sources.json.sources[0].adapter", "grammar"]]);
});

test("adapter validate: a cursor is plain JSON of at most 4 KiB, measured in UTF-8 bytes", () => {
  // {"p":"..."} is 8 bytes beside the string.
  assert.deepEqual(checkCursor({ p: "x".repeat(MAX_CURSOR_BYTES - 8) }, "c"), { p: "x".repeat(MAX_CURSOR_BYTES - 8) });
  assert.throws(() => checkCursor({ p: "x".repeat(MAX_CURSOR_BYTES - 7) }, "c"), /4097 bytes/);
  // Two bytes a character in UTF-8.
  assert.throws(() => checkCursor({ p: "é".repeat(2045) }, "c"), /4098 bytes/);
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  for (const bad of [undefined, Number.NaN, new Date(0), { a: undefined }, cycle, () => 1]) {
    assert.throws(
      () => checkCursor(bad, "c"),
      (e: unknown) => e instanceof ContractError && e.check === "cursor",
    );
  }
  assert.equal(checkCursor(null, "c"), null);
});

const SEG = {
  source: "thc-ct",
  dataset: "names",
  window: { start: "2026-10-26T00:00:00Z", end: "2026-10-27T00:00:00Z" },
  cursorBefore: { last_day: "2026-10-25" },
  cursorAfter: { last_day: "2026-10-26" },
  count: 2,
  precision: "day",
  bytes: 10,
  sha256: "0".repeat(64),
};

test("adapter validate: a segment is refused for each fault of its shape", () => {
  validateSegment(SEG, "s");
  validateSegment({ ...SEG, raw: { bytes: 1, sha256: "a".repeat(64) } }, "s");
  const cases: [Record<string, unknown>, RegExp][] = [
    [{ extra: 1 }, /unknown field extra/],
    [{ source: "THC" }, /is not an id/],
    [{ dataset: "nope" }, /dataset/],
    [{ precision: "hour" }, /precision/],
    [{ window: { start: "2026-10-26T06:00:00Z", end: "2026-10-27T00:00:00Z" } }, /does not start and end at 00:00:00Z/],
    [{ window: { start: "2026-10-27T00:00:00Z", end: "2026-10-26T00:00:00Z" } }, /is not before/],
    [{ window: { start: "2026-02-30T00:00:00Z", end: "2026-03-02T00:00:00Z" } }, /not two ISO 8601 UTC times/],
    [{ count: -1 }, /count/],
    [{ bytes: 1.5 }, /bytes/],
    [{ sha256: "A".repeat(64) }, /sha256/],
    [{ raw: { bytes: 1 } }, /raw is not/],
    [{ raw: { bytes: -1, sha256: "a".repeat(64) } }, /raw is not/],
    [{ raw: { bytes: 1.5, sha256: "a".repeat(64) } }, /raw is not/],
    [{ raw: { bytes: 1, sha256: "x" } }, /raw is not/],
    [{ window: { start: "2026-10-26T00:00:00Z", end: "2026-10-26T00:00:00Z" } }, /is not before/],
    [{ window: { start: "2026-10-26T00:00:00Z", end: "2026-10-27T06:00:00Z" } }, /does not start and end at 00:00:00Z/],
    [{ window: { start: "2026-10-26T00:00:00Z", end: "2026-10-27T00:00:00Z", step: 1 } }, /window is not \{ start, end \}/],
    [{ cursorAfter: { p: "x".repeat(5000) } }, /cursorAfter/],
  ];
  for (const [change, why] of cases) assert.throws(() => validateSegment({ ...SEG, ...change }, "s"), why, JSON.stringify(change));
  const { count: _, ...noCount } = SEG;
  assert.throws(() => validateSegment(noCount, "s"), /missing count/);
  // A second source's window may hold a time of day.
  validateSegment({ ...SEG, precision: "second", window: { start: "2026-10-26T06:00:00Z", end: "2026-10-26T06:10:00Z" } }, "s");
});

test("adapter validate: a segment's facts is { bytes, sha256 }, as its raw is, and may be absent", () => {
  validateSegment({ ...SEG, facts: { bytes: 44, sha256: "b".repeat(64) } }, "s");
  validateSegment({ ...SEG, raw: { bytes: 1, sha256: "a".repeat(64) }, facts: { bytes: 44, sha256: "b".repeat(64) } }, "s");
  const cases: [unknown, RegExp][] = [
    [{ bytes: 44 }, /facts is not \{ bytes, sha256 \}/],
    [{ bytes: -1, sha256: "b".repeat(64) }, /facts is not/],
    [{ bytes: 1.5, sha256: "b".repeat(64) }, /facts is not/],
    [{ bytes: 44, sha256: "B".repeat(64) }, /facts is not/],
    [{ bytes: 44, sha256: "b".repeat(64), layer: "facts.json" }, /facts is not/],
    [[44, "b".repeat(64)], /facts is not/],
    [null, /facts is not/],
  ];
  for (const [facts, why] of cases)
    assert.throws(
      () => validateSegment({ ...SEG, facts }, "s"),
      (e: unknown) => e instanceof ContractError && e.check === "segment" && why.test(e.message),
      JSON.stringify(facts),
    );
});

test("adapter validate: a raw lane member's fields are named words of strings and whole numbers, never the writer's own, on a second-precision write with raw bytes", () => {
  const member = { topic: "newly_registered_domain", partition: 0, base_offset: 173858847, last_offset: 173860323, batches: 1477 };
  checkRawMember(undefined, "day", "s");
  checkRawMember(member, "second", "s");
  checkRawMember({}, "second", "s");
  checkRawMember(Object.assign(Object.create(null), { topic: "t" }), "second", "s");
  const draft =
    (v: unknown, precision = "second") =>
    () =>
      checkRawMember(v, precision, "s");
  const cases: [() => void, RegExp][] = [
    [draft(member, "day"), /a day source keeps its file in its segment's own layer raw/],
    [draft([1]), /rawMember is not a plain object of fields/],
    [draft(new Map([["topic", "t"]])), /rawMember is not a plain object of fields/],
    [draft("topic=t"), /rawMember is not a plain object of fields/],
    [draft(null), /rawMember is not a plain object of fields/],
    [draft({ Topic: "t" }), /field "Topic" is not \[a-z\]\[a-z0-9_\]\*/],
    [draft({ "base-offset": 1 }), /field "base-offset"/],
    [draft({ _x: 1 }), /field "_x"/],
    [draft({ offset: 0 }), /field offset is one the writer writes/],
    [draft({ length: 5 }), /field length is one the writer writes/],
    [draft({ sha256: "a".repeat(64) }), /field sha256 is one the writer writes/],
    [draft({ partition: -1 }), /field partition is -1, not a string or a safe whole number/],
    [draft({ partition: 1.5 }), /field partition is 1\.5/],
    [draft({ partition: 2 ** 53 }), /field partition is 9007199254740992/],
    [draft({ codec: null }), /field codec is null/],
    [draft({ codec: true }), /field codec is true/],
    [draft({ offsets: [1, 2] }), /field offsets is \[1,2\]/],
    [draft({ topic: "t".repeat(MAX_RAW_MEMBER_BYTES) }), /rawMember is 1036 bytes of JSON, over 1024/],
  ];
  for (const [fn, why] of cases) assert.throws(fn, (e: unknown) => e instanceof ContractError && e.check === "draft" && why.test(e.message), String(why));
  // {"topic":"..."} is 12 bytes beside the string: 1024 bytes in all is taken.
  checkRawMember({ topic: "t".repeat(MAX_RAW_MEMBER_BYTES - 12) }, "second", "s");
  // A member names raw bytes: none, or none of a byte, is refused; no rawMember needs none.
  checkRawMemberBytes(member, 1, "s");
  checkRawMemberBytes(undefined, null, "s");
  checkRawMemberBytes(undefined, 0, "s");
  for (const bytes of [null, 0])
    assert.throws(
      () => checkRawMemberBytes(member, bytes, "s"),
      (e: unknown) => e instanceof ContractError && e.check === "draft" && /the write has no raw byte, so it makes no raw lane object/.test(e.message),
    );
});

test("adapter validate: a draft's facts are a list of { key, cert_age }, keys strictly ascending, each age a safe whole number of at least 0", () => {
  assert.equal(factsProblem(undefined), null);
  assert.equal(factsProblem([]), null);
  assert.equal(
    factsProblem([
      { key: "com.example", cert_age: 0 },
      { key: "net.example", cert_age: 3_456_789 },
    ]),
    null,
  );
  const cases: [unknown, RegExp][] = [
    [{ "com.example": 1 }, /^facts is not a list$/],
    [[["com.example", 1]], /facts\[0\] is not \{ key, cert_age \}/],
    [[{ key: "com.example" }], /facts\[0\] is not \{ key, cert_age \}/],
    [[{ key: "com.example", cert_age: 1, bit: 1 }], /facts\[0\] is not \{ key, cert_age \}/],
    [[{ key: "", cert_age: 1 }], /facts\[0\]: the key is not a non-empty string/],
    [[{ key: 5, cert_age: 1 }], /facts\[0\]: the key is not a non-empty string/],
    [
      [
        { key: "net.example", cert_age: 1 },
        { key: "com.example", cert_age: 1 },
      ],
      /facts\[1\]: the key "com\.example" does not sort after "net\.example"/,
    ],
    [
      [
        { key: "com.example", cert_age: 1 },
        { key: "com.example", cert_age: 2 },
      ],
      /facts\[1\]: the key "com\.example" does not sort after "com\.example"/,
    ],
    [[{ key: "com.example", cert_age: -1 }], /facts\[0\]: the cert_age -1 of "com\.example" is not a safe whole number of at least 0/],
    [[{ key: "com.example", cert_age: 0.5 }], /the cert_age 0\.5/],
    [[{ key: "com.example", cert_age: "7" }], /the cert_age "7"/],
    [[{ key: "com.example", cert_age: Number.MAX_SAFE_INTEGER + 1 }], /the cert_age 9007199254740992/],
  ];
  for (const [facts, why] of cases) assert.match(factsProblem(facts) ?? "", why, JSON.stringify(facts));
});

test("adapter validate: the facts' walk names the first fact whose key no record has: before the first, between two, past the last, or with no record", () => {
  const facts = (...keys: string[]) => keys.map((key) => ({ key, cert_age: 1 }));
  const walked = (f: { key: string; cert_age: number }[], keys: string[]) => {
    const walk = factKeysWalk(f);
    for (const k of keys) walk.see(k);
    return walk.problem();
  };
  const records = ["com.b", "com.d", "com.f"];
  assert.equal(walked(facts(), records), null);
  assert.equal(walked(facts("com.b", "com.f"), records), null);
  assert.equal(walked(facts("com.b", "com.d", "com.f"), records), null);
  assert.equal(walked(facts("com.a", "com.b"), records), 'the fact of "com.a" names a key no record of the segment has');
  assert.equal(walked(facts("com.b", "com.c", "com.d"), records), 'the fact of "com.c" names a key no record of the segment has');
  assert.equal(walked(facts("com.f", "com.g"), records), 'the fact of "com.g" names a key no record of the segment has');
  assert.equal(walked(facts("com.c", "com.e"), records), 'the fact of "com.c" names a key no record of the segment has');
  assert.equal(walked(facts("com.b"), []), 'the fact of "com.b" names a key no record of the segment has');
});

const contract = (fn: () => unknown, check: string, why: RegExp): void => {
  assert.throws(fn, (e: unknown) => e instanceof ContractError && e.check === check && why.test(e.message), why.source);
};

test("adapter validate: a run's gaps are absent, or a list of { source, day } sorted by source, then day, one each, at most MAX_GAPS", () => {
  checkGaps(undefined, "run");
  checkGaps([], "run");
  checkGaps(
    [
      { source: "thc-ct", day: "2026-10-04" },
      { source: "thc-ct", day: "2026-10-09" },
      { source: "thc-ct-b", day: "2026-10-01" },
    ],
    "run",
  );
  contract(() => checkGaps({}, "run"), "result", /gaps is not a list/);
  contract(() => checkGaps([{ source: "thc-ct" }], "run"), "result", /gaps\[0\] is not \{ source, day \}/);
  contract(() => checkGaps([{ source: "thc-ct", day: "2026-10-04", why: "x" }], "run"), "result", /gaps\[0\] is not \{ source, day \}/);
  contract(() => checkGaps([{ source: "THC", day: "2026-10-04" }], "run"), "result", /gaps\[0\]\.source "THC" is not a source id/);
  contract(() => checkGaps([{ source: "thc-ct", day: "2026-02-30" }], "run"), "result", /gaps\[0\]\.day "2026-02-30" is not a calendar day/);
  contract(() => checkGaps([{ source: "thc-ct", day: "2026-10-04T00:00:00Z" }], "run"), "result", /is not a calendar day/);
  contract(
    () =>
      checkGaps(
        [
          { source: "thc-ct", day: "2026-10-09" },
          { source: "thc-ct", day: "2026-10-04" },
        ],
        "run",
      ),
    "result",
    /gaps\[1\] thc-ct 2026-10-04 does not sort after thc-ct 2026-10-09/,
  );
  contract(
    () =>
      checkGaps(
        [
          { source: "thc-ct", day: "2026-10-04" },
          { source: "thc-ct", day: "2026-10-04" },
        ],
        "run",
      ),
    "result",
    /does not sort after/,
  );
  // Sorted by source first: a shorter id that is a prefix sorts first.
  contract(
    () =>
      checkGaps(
        [
          { source: "thc-ct-b", day: "2026-10-01" },
          { source: "thc-ct", day: "2026-10-04" },
        ],
        "run",
      ),
    "result",
    /does not sort after/,
  );
  const year = Array.from({ length: MAX_GAPS + 1 }, (_, i) => ({ source: "thc-ct", day: new Date(Date.UTC(2026, 0, 1) + i * 86_400_000).toISOString().slice(0, 10) }));
  checkGaps(year.slice(0, MAX_GAPS), "run");
  contract(() => checkGaps(year, "run"), "result", /gaps lists 367 days, over 366/);
});

test("adapter validate: a draft's url lies under one of its row's urls, with no credential, of at most MAX_URLS_CHARS characters", () => {
  const urls = ["https://cs2.ip.thc.org/", "https://huggingface.co/buckets/IP-THC-ORG/Daily-Cerstream-Dumps"];
  checkDraftUrl(undefined, urls, "draft");
  checkDraftUrl("https://cs2.ip.thc.org/2026-10-31.txt.gz", urls, "draft");
  checkDraftUrl("https://huggingface.co/buckets/IP-THC-ORG/Daily-Cerstream-Dumps/resolve/2026/11/2026-10-31.txt.gz?download=true", urls, "draft");
  checkDraftUrl("https://huggingface.co/buckets/IP-THC-ORG/Daily-Cerstream-Dumps", urls, "draft");
  // Without the rows, the URL rules alone.
  checkDraftUrl("https://example.test/x", null, "draft");
  contract(() => checkDraftUrl(5, urls, "draft"), "draft", /url is not a string/);
  contract(() => checkDraftUrl("not-a-url", urls, "draft"), "draft", /url: "not-a-url" is not a URL/);
  contract(() => checkDraftUrl("ftp://cs2.ip.thc.org/x", null, "draft"), "draft", /url: the scheme ftp: is not one of/);
  contract(() => checkDraftUrl("https://user:pw@cs2.ip.thc.org/x", null, "draft"), "draft", /credential: a URL holds a user name or a password/);
  contract(() => checkDraftUrl("https://cs2.ip.thc.org/x#t", null, "draft"), "draft", /credential: a URL holds a fragment/);
  // A signed CDN URL a redirect led to: under no row, and its signature is a credential parameter.
  contract(() => checkDraftUrl("https://us.aws.cdn.hf.co/x?X-Amz-Signature=abc", urls, "draft"), "draft", /the query parameter X-Amz-Signature names a credential/);
  contract(() => checkDraftUrl("https://us.aws.cdn.hf.co/x", urls, "draft"), "draft", /is not one of the source's urls nor under one/);
  // A neighbour of a row's URL that is not under it.
  contract(() => checkDraftUrl("https://huggingface.co/buckets/IP-THC-ORG/Daily-Cerstream-Dumps-other/x", urls, "draft"), "draft", /nor under one/);
  contract(() => checkDraftUrl("https://cs2.ip.thc.org.evil.test/x", urls, "draft"), "draft", /nor under one/);
  contract(() => checkDraftUrl(`https://cs2.ip.thc.org/${"x".repeat(MAX_URLS_CHARS)}`, urls, "draft"), "draft", /characters, over 1024/);
  for (const bad of ["https://cs2.ip.thc.org/a\nb", "https://cs2.ip.thc.org/a\tb", "https://cs2.ip.thc.org/a b", "https://cs2.ip.thc.org/a\u007f"]) {
    contract(() => checkDraftUrl(bad, urls, "draft"), "draft", /holds a space or a control character/);
  }
});
