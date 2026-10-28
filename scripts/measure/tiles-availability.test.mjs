// The rounds and the verdict of DOM-011 (scripts/measure/tiles-availability.mjs).
// The rounds run over synthetic hosts and a clock the test turns
// (fixtures/tiles/fake-log.mjs); the verdict reads synthetic artifacts built
// here, laid out as `gh run download` lays them out. Each refusal plants one
// fault into a set that passes, so the guard that refuses it is the only
// thing that changed.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { LOG_LIST_URL } from './ct-logs.mjs';
import { fakeFetch, fakeList, fakeLog } from './fixtures/tiles/fake-log.mjs';
import { download, main, OVERLAP_SCHEMA, RATES_SCHEMA, runRounds, SCHEMA, WINDOW_SCHEMA } from './tiles-availability.mjs';

const MIN = 60_000;
const S = Date.parse('2026-10-29T00:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tmp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'tiles-availability-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const lines = (file) =>
  readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));

// --- the rounds -----------------------------------------------------------------

const LIST = fakeList({
  logs: [
    ['Geomys', 'Geomys Tuscolo2027h1', 'usable', 'https://tuscolo.test/'],
    ['IPng Networks', 'IPng Networks Gouda2026h2', 'usable', 'https://gouda.test/'],
    ['Google', 'Google ParcelYard2026h2', 'usable', 'https://parcel.test/'],
    ['Old', 'Old Log2020', 'retired', 'https://old.test/'],
  ],
});
const NOT_FOUND = '<?xml version="1.0"?><Error><Code>NoSuchKey</Code></Error>';
const hosts = () =>
  fakeFetch({
    [LOG_LIST_URL]: () => new Response(JSON.stringify(LIST)),
    'https://tuscolo.test/': fakeLog({ size: 256 * 20 + 5 }),
    'https://gouda.test/': fakeLog({ size: 256 * 2000 + 9, firstServed: 300 }),
    'https://parcel.test/': fakeLog({ size: 256 * 30, firstServed: 1e9, notFound: NOT_FOUND }),
  });

// A clock that only the fake sleep moves.
const turnedClock = (t0) => {
  let now = t0;
  return { clock: () => now, sleep: async (ms) => (now += ms), set: (t) => (now = t) };
};

test('tiles rounds: a job takes a round every 30 minutes from its start for 340 minutes, each appended as one line', async (t) => {
  const out = join(tmp(t), 'rounds.jsonl');
  const c = turnedClock(S);
  const fetchFn = hosts();
  const r = await runRounds({ out, start: S, forMs: 340 * MIN, intervalMs: 30 * MIN, fetchFn, clock: c.clock, sleep: c.sleep, env: { GITHUB_RUN_ID: '7', GITHUB_RUN_ATTEMPT: '1' }, log: () => {} });
  assert.deepEqual(r, { ran: 12, skipped: 0, silent: 0, stopped_by: 'for-min' });
  const ls = lines(out);
  assert.deepEqual(
    ls.map((l) => l.kind),
    ['start', ...Array(12).fill('round'), 'end'],
  );
  assert.ok(ls.every((l) => l.schema === SCHEMA && l.run_id === '7'));
  const rounds = ls.filter((l) => l.kind === 'round');
  assert.deepEqual(
    rounds.map((l) => (Date.parse(l.started) - S) / MIN),
    [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330],
  );
  const first = rounds[0];
  assert.equal(first.list.timestamp, '2026-10-28T13:37:58Z');
  assert.deepEqual(
    first.logs.map((l) => l.name),
    ['tuscolo2027h1', 'gouda2026h2', 'parcelyard2026h2'],
    'a retired log is not probed',
  );
  const gouda = first.logs.find((l) => l.name === 'gouda2026h2');
  assert.deepEqual([gouda.tile0.status, gouda.tail.status, gouda.first_served.tile, gouda.first_served.how], [404, 200, 300, 'search']);
  assert.equal(rounds[1].logs.find((l) => l.name === 'gouda2026h2').first_served.how, 'hint', 'the round before is the hint');
  assert.equal(gouda.mon, undefined);
  // A 404 keeps its headers and body once; the same 404 in a later round says repeat.
  const parcel0 = first.logs.find((l) => l.name === 'parcelyard2026h2');
  assert.match(parcel0.tile0.body, /NoSuchKey/);
  assert.deepEqual(parcel0.tile0.headers, { server: 'synthetic', 'content-type': 'text/plain; charset=utf-8', 'content-length': String(NOT_FOUND.length) });
  const parcel1 = rounds[1].logs.find((l) => l.name === 'parcelyard2026h2');
  assert.equal(parcel1.tile0.repeat, true);
  assert.equal(parcel1.tile0.body, undefined);
  assert.equal(parcel1.tile0.status, 404);
  assert.ok(
    fetchFn.calls.every((x) => /contact: domains@pkgforge\.dev/.test(x.headers['user-agent'])),
    'every request carries the contact',
  );
});

test('tiles rounds: no round is taken at or after until, and a late round skips the slots it missed', async (t) => {
  const dir = tmp(t);
  const c = turnedClock(S);
  const r = await runRounds({
    out: join(dir, 'a.jsonl'),
    start: S,
    forMs: 340 * MIN,
    intervalMs: 30 * MIN,
    until: S + 95 * MIN,
    fetchFn: hosts(),
    clock: c.clock,
    sleep: c.sleep,
    env: {},
    log: () => {},
  });
  assert.deepEqual(r, { ran: 4, skipped: 0, silent: 0, stopped_by: 'until' });
  assert.equal(lines(join(dir, 'a.jsonl')).at(-1).stopped_by, 'until');
  // A run that starts after until takes no round and says so.
  const past = turnedClock(S + 100 * MIN);
  const none = await runRounds({
    out: join(dir, 'b.jsonl'),
    start: S + 100 * MIN,
    forMs: 340 * MIN,
    intervalMs: 30 * MIN,
    until: S + 95 * MIN,
    fetchFn: hosts(),
    clock: past.clock,
    sleep: past.sleep,
    env: {},
    log: () => {},
  });
  assert.deepEqual(none, { ran: 0, skipped: 0, silent: 0, stopped_by: 'until' });
  // A job whose script starts 65 minutes late runs slot 2 at once, never slots 0 and 1 back to back.
  const late = turnedClock(S + 65 * MIN);
  const l = await runRounds({ out: join(dir, 'c.jsonl'), start: S, forMs: 100 * MIN, intervalMs: 30 * MIN, fetchFn: hosts(), clock: late.clock, sleep: late.sleep, env: {}, log: () => {} });
  assert.deepEqual(l, { ran: 2, skipped: 2, silent: 0, stopped_by: 'for-min' });
  assert.deepEqual(
    lines(join(dir, 'c.jsonl'))
      .filter((x) => x.kind === 'round')
      .map((x) => x.round),
    [2, 3],
  );
});

test('tiles rounds: a round with no answer at all fails the run; --once takes one round', async (t) => {
  const dir = tmp(t);
  const down = async () => {
    throw new Error('no network');
  };
  const c = turnedClock(S);
  const r = await main(['--once', '--out', join(dir, 'd.jsonl')], { fetchFn: down, clock: c.clock, sleep: c.sleep, env: {}, log: () => {} });
  assert.equal(r, 1);
  const ls = lines(join(dir, 'd.jsonl'));
  assert.equal(ls.at(-1).stopped_by, 'once');
  assert.match(ls[1].list.error, /no network/);
  const ok = await main(['--once', '--out', join(dir, 'e.jsonl')], { fetchFn: hosts(), clock: c.clock, sleep: c.sleep, env: {}, log: () => {} });
  assert.equal(ok, 0);
  assert.equal(await main(['--out', join(dir, 'f.jsonl'), '--until', 'tomorrow'], { log: () => {}, err: () => {} }), 2);
});

// --- the verdict ----------------------------------------------------------------

// A probe record of one log in one round (synthetic).
function rec(name, op, { t0 = 200, tail = 200, partial = 200, cp = 200, size = 1000, at = S, first = 0, state = 'usable' } = {}) {
  return {
    name,
    op,
    state,
    checkpoint: { status: cp },
    ...(cp === 200 ? { size } : {}),
    tile0: { n: 0, status: t0 },
    tail: { n: 3, status: tail, ...(tail === 200 ? { last_ts: at - 2 * MIN } : {}) },
    partial: { n: 4, w: 9, status: partial },
    first_served: t0 === 200 ? { tile: 0, how: 'tile 0' } : tail === 200 ? { tile: first, how: 'search' } : { tile: null, how: 'tail not served' },
  };
}

// Synthetic rounds of five runs over 24 hours: each run takes a round every 30
// minutes from its start, for 340 minutes, and the next starts 335 minutes in.
function chain({ fault = () => null } = {}) {
  const runs = [];
  // until: the first round is a minute after the dispatch.
  const end = S + 24 * 60 * MIN - MIN;
  for (let r = 0; r < 5; r++) {
    const start = S + r * 335 * MIN;
    const rounds = [];
    for (let k = 0; k < 12 && start + k * 30 * MIN < end; k++) {
      const at = start + k * 30 * MIN;
      const n = (at - S) / MIN;
      const logs = [
        rec('tuscolo2027h1', 'Geomys', { at, size: 1000 + n * 100 }),
        rec('sycamore2027h1', "Let's Encrypt", { at, size: 5000 + n * 200 }),
        rec('gouda2026h2', 'IPng Networks', { at, t0: 404, first: 300 + Math.floor(n / 60) }),
        rec('parcelyard2026h2', 'Google', { at, t0: 404, tail: 404, partial: 404 }),
      ];
      fault({ run: r, k, at, logs });
      rounds.push({
        schema: SCHEMA,
        kind: 'round',
        run_id: String(100 + r),
        run_attempt: '1',
        round: k,
        slot: iso(at),
        started: iso(at),
        ended: iso(at + 20_000),
        late_ms: 0,
        list: { status: 200, timestamp: '2026-10-28T13:37:58Z', version: '0.synthetic' },
        logs,
        requests: 20,
        failed: 0,
        throttled: 0,
      });
    }
    const last = r === 4;
    runs.push({
      id: 100 + r,
      lines: [
        { schema: SCHEMA, kind: 'start', run_id: String(100 + r), start: iso(start) },
        ...rounds,
        { schema: SCHEMA, kind: 'end', run_id: String(100 + r), ran: rounds.length, stopped_by: last ? 'until' : 'for-min' },
      ],
    });
  }
  return runs;
}

const overlapDoc = (over = {}) => ({
  schema: OVERLAP_SCHEMA,
  at: iso(S + 5 * MIN),
  window: { from: '2026-10-28T02:00:00.000Z', to: '2026-10-28T02:05:00.000Z', day: '2026-10-28', picked_by: 'run time' },
  families: { sycamore: { complete: true }, willow: { complete: true }, tuscolo: { complete: true }, gouda: { complete: true } },
  kafka: { ok: true, cut: false },
  thc: { ok: true },
  sets: { sycamore: 10, union4: 20, kafka: 30 },
  matrix: {
    rows: ['sycamore', 'union4', 'kafka'],
    cols: ['sycamore', 'union4', 'kafka', 'thc'],
    cells: [
      [100, 100, 70, 98],
      [50, 100, 60, 94],
      [23, 40, 100, 50],
    ],
  },
  errors: [],
  ...over,
});
const windowDoc = (stat = {}) => ({
  schema: WINDOW_SCHEMA,
  at: iso(S + 9 * MIN),
  log: 'tuscolo2027h1',
  from: '2026-10-26T12:00:00.000Z',
  to: '2026-10-26T12:05:00.000Z',
  stat: { complete: true, tiles_read: 10, entries: 1000, distinct_names: 1200, throttled: 0, ...stat },
});
const ratesDoc = { schema: RATES_SCHEMA, t0: iso(S + 10 * MIN), gap_s: 600, res: [{ name: 'sycamore2027h1', per_day_M: 1.5, names_tile: 200 }] };

function lay(dir, { runs = chain(), overlap = overlapDoc(), window = windowDoc() } = {}) {
  for (const run of runs) {
    mkdirSync(join(dir, `tiles-rounds-${run.id}-1`), { recursive: true });
    writeFileSync(join(dir, `tiles-rounds-${run.id}-1`, 'rounds.jsonl'), `${run.lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  }
  const o = join(dir, 'tiles-overlap-100-1');
  mkdirSync(o, { recursive: true });
  if (overlap) writeFileSync(join(o, 'overlap.json'), JSON.stringify(overlap));
  if (window) writeFileSync(join(o, 'geomys-window.json'), JSON.stringify(window));
  writeFileSync(join(o, 'rates.json'), JSON.stringify(ratesDoc));
}

async function verdict(t, layout, extra = () => {}) {
  const dir = tmp(t);
  lay(join(dir, 'runs'), layout);
  extra(join(dir, 'runs'));
  const out = [];
  const file = join(dir, 'result.json');
  const code = await main(['--verdict', file, '--runs', join(dir, 'runs')], { now: S + 25 * 60 * MIN, log: (l) => out.push(l), err: (l) => out.push(l) });
  return { code, text: out.join('\n'), file, dir };
}

test('tiles verdict: 24 hours of rounds, Geomys at 200, a reliable log, the Geomys window and an overlap pass', async (t) => {
  const v = await verdict(t, {});
  assert.equal(v.code, 0, v.text);
  const r = JSON.parse(readFileSync(v.file, 'utf8'));
  assert.equal(r.verdict, 'PASS');
  assert.equal(r.rounds.present, 48);
  assert.equal(r.rounds.runs, 5);
  assert.equal(r.rounds.gaps.filter((g) => g.seam).length, 4);
  assert.deepEqual(r.reliable, ['tuscolo2027h1', 'gouda2026h2', 'sycamore2027h1']);
  const tus = r.logs.find((l) => l.name === 'tuscolo2027h1');
  assert.equal(tus.entries_per_day, 144_000, '100 entries a minute');
  assert.equal(tus.tail_age_min, 2);
  assert.deepEqual(r.logs.find((l) => l.name === 'gouda2026h2').first_served.first, 300);
  assert.equal(r.logs.find((l) => l.name === 'gouda2026h2').first_served.tiles_per_day, 23);
  assert.deepEqual(r.logs.find((l) => l.name === 'parcelyard2026h2').status.tail, { 404: r.rounds.in_window });
  assert.match(v.text, /rounds: 48 of 48 slots/);
  assert.match(v.text, /Geomys window tuscolo2027h1 .*1000 entries, 1200 names/);
  assert.match(v.text, /% of row in column/);
  assert.match(v.text, /\nPASS$/);
  // Read back with no rounds beside it, the result is judged on its own rows.
  rmSync(join(v.dir, 'runs'), { recursive: true });
  const again = [];
  assert.equal(await main(['--verdict', v.file, '--runs', join(v.dir, 'runs')], { log: (l) => again.push(l) }), 0);
  assert.match(again.join('\n'), /judging/);
});

test('tiles verdict: fewer than 44 of the 48 slots fail it, and the largest gap is printed', async (t) => {
  // Run 102 takes no round: 10 slots are empty.
  const runs = chain().filter((r) => r.id !== 102);
  const v = await verdict(t, { runs });
  assert.equal(v.code, 1);
  assert.match(v.text, /38 of 48 slots hold a round, fewer than 44/);
  assert.match(v.text, /largest gap 340 min \(2026-10-29T11:05:00\.000Z to 2026-10-29T16:45:00\.000Z\)/);
  // The same chain with run 102 kept passes: the missing run alone failed it.
  assert.equal((await verdict(t, {})).code, 0);
});

test('tiles verdict: one Geomys 429 fails it, while a Geomys partial tile at 404 does not', async (t) => {
  const partial404 = await verdict(t, { runs: chain({ fault: ({ k, logs }) => k === 3 && (logs[0].partial.status = 404) }) });
  assert.equal(partial404.code, 0, partial404.text);
  const throttled = await verdict(t, { runs: chain({ fault: ({ run, k, logs }) => run === 2 && k === 5 && (logs[0].tail.status = 429) }) });
  assert.equal(throttled.code, 1);
  assert.match(throttled.text, /1 Geomys answers were not 200; Geomys answered 429 1 times/);
  assert.match(throttled.text, /tuscolo2027h1 tail 429 at/);
});

test('tiles verdict: no reliable log fails it', async (t) => {
  // Each log that served misses one tail.
  const v = await verdict(t, {
    runs: chain({
      fault: ({ run, k, logs }) => {
        if (run === 1 && k === 1) logs[0].tail.status = 500;
        if (run === 1 && k === 2) logs[1].tail.status = null;
        if (run === 1 && k === 3) logs[2].checkpoint.status = 503;
      },
    }),
  });
  assert.equal(v.code, 1);
  assert.match(v.text, /no log is reliable/);
});

test('tiles verdict: a cut Kafka window, or no Geomys window, fails it', async (t) => {
  const cut = await verdict(t, { overlap: overlapDoc({ kafka: { ok: false, cut: true } }) });
  assert.equal(cut.code, 1);
  assert.match(cut.text, /no whole overlap window/);
  const skipped = await verdict(t, { overlap: { schema: OVERLAP_SCHEMA, at: iso(S), skipped: 'until has passed' } });
  assert.match(skipped.text, /overlap \(tiles-overlap-100-1\): skipped, until has passed/);
  assert.equal(skipped.code, 1);
  const noWindow = await verdict(t, { window: null });
  assert.equal(noWindow.code, 1);
  assert.match(noWindow.text, /no whole read of the Geomys window/);
  const throttledWindow = await verdict(t, { window: windowDoc({ throttled: 2 }) });
  assert.match(throttledWindow.text, /Geomys answered 429 2 times/);
});

test('tiles verdict: before the chain ends nothing is written; a result whose verdict does not follow from its rows is refused', async (t) => {
  const dir = tmp(t);
  const runs = chain();
  runs[4].lines.at(-1).stopped_by = 'for-min';
  lay(join(dir, 'runs'), { runs });
  const out = [];
  const file = join(dir, 'result.json');
  assert.equal(await main(['--verdict', file, '--runs', join(dir, 'runs')], { now: S + 25 * 60 * MIN, log: (l) => out.push(l) }), 1);
  assert.match(out.join('\n'), /not complete: the chain has not ended; nothing is written/);
  // Six hours after the 24 hours, the window is complete either way.
  assert.equal(await main(['--verdict', file, '--runs', join(dir, 'runs')], { now: S + 31 * 60 * MIN, log: () => {} }), 0);
  const r = JSON.parse(readFileSync(file, 'utf8'));
  r.verdict = 'FAIL';
  writeFileSync(file, JSON.stringify(r));
  rmSync(join(dir, 'runs'), { recursive: true });
  const err = [];
  assert.equal(await main(['--verdict', file, '--runs', join(dir, 'runs')], { log: () => {}, err: (l) => err.push(l) }), 2);
  assert.match(err.join('\n'), /the result says FAIL, its rows say PASS/);
  assert.equal(await main(['--verdict', join(dir, 'none.json'), '--runs', join(dir, 'runs')], { log: () => {}, err: () => {} }), 2);
});

// The rounds of chain() without the rounds `drop` names, as [run, k] pairs.
const dropRounds = (drop) => chain().map((run, r) => ({ ...run, lines: run.lines.filter((l) => l.kind !== 'round' || !drop.some(([dr, dk]) => dr === r && dk === l.round)) }));
const writeIn = (dir, name, file, doc) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, file), JSON.stringify(doc));
};

test('tiles verdict: exactly 44 slots pass and 43 fail', async (t) => {
  // Rounds 2 to 6 of run 1 hold slots 13 to 17, which no other round holds.
  const at44 = await verdict(t, { runs: dropRounds([2, 3, 4, 5].map((k) => [1, k])) });
  assert.equal(at44.code, 0, at44.text);
  assert.match(at44.text, /rounds: 44 of 48 slots/);
  const at43 = await verdict(t, { runs: dropRounds([2, 3, 4, 5, 6].map((k) => [1, k])) });
  assert.equal(at43.code, 1);
  assert.match(at43.text, /43 of 48 slots hold a round, fewer than 44/);
});

test('tiles verdict: a Geomys 200 with a bad body, or a Geomys partial tile at 500, is not a 200', async (t) => {
  const bad = await verdict(t, { runs: chain({ fault: ({ run, k, logs }) => run === 1 && k === 1 && (logs[0].tile0.bad = true) }) });
  assert.equal(bad.code, 1);
  assert.match(bad.text, /1 Geomys answers were not 200/);
  assert.match(bad.text, /tuscolo2027h1 tile0 bad at/);
  const partial500 = await verdict(t, { runs: chain({ fault: ({ run, k, logs }) => run === 1 && k === 1 && (logs[0].partial.status = 500) }) });
  assert.equal(partial500.code, 1);
  assert.match(partial500.text, /tuscolo2027h1 partial 500 at/);
});

test('tiles verdict: no Geomys log in the rounds fails it', async (t) => {
  const v = await verdict(t, { runs: chain({ fault: ({ logs }) => logs.splice(0, 1) }) });
  assert.equal(v.code, 1);
  assert.match(v.text, /no Geomys answer was recorded/);
});

test('tiles verdict: a log qualified in the rounds, or one probed in fewer rounds than the rest, is not reliable', async (t) => {
  const v = await verdict(t, {
    runs: chain({
      fault: ({ run, at, logs }) => {
        logs.push(rec('willow2027h1', "Let's Encrypt", { at, state: 'qualified' }));
        if (run === 0) logs.push(rec('oak2027h1', "Let's Encrypt", { at }));
      },
    }),
  });
  assert.equal(v.code, 0, v.text);
  const r = JSON.parse(readFileSync(v.file, 'utf8'));
  assert.deepEqual(r.reliable, ['tuscolo2027h1', 'gouda2026h2', 'sycamore2027h1']);
  assert.ok(r.logs.find((l) => l.name === 'willow2027h1').status.tail['200'] > 0);
});

test('tiles verdict: a Geomys window read that is not whole, or two whole reads that disagree, fail it', async (t) => {
  const partial = await verdict(t, { window: windowDoc({ complete: false }) });
  assert.equal(partial.code, 1);
  assert.match(partial.text, /no whole read of the Geomys window/);
  const disagree = await verdict(t, {}, (dir) => writeIn(dir, 'tiles-overlap-101-1', 'geomys-window.json', windowDoc({ entries: 999 })));
  assert.equal(disagree.code, 1);
  assert.match(disagree.text, /the whole reads of the Geomys window disagree/);
  const agree = await verdict(t, {}, (dir) => writeIn(dir, 'tiles-overlap-101-1', 'geomys-window.json', windowDoc()));
  assert.equal(agree.code, 0, agree.text);
});

test('tiles verdict: an overlap with a family not whole, or THC unread, is not whole; one whole beside one skipped passes', async (t) => {
  const families = { sycamore: { complete: true }, willow: { complete: true }, tuscolo: { complete: true }, gouda: { complete: false } };
  const three = await verdict(t, { overlap: overlapDoc({ families }) });
  assert.equal(three.code, 1);
  assert.match(three.text, /no whole overlap window/);
  const noThc = await verdict(t, { overlap: overlapDoc({ thc: { ok: false } }) });
  assert.equal(noThc.code, 1);
  assert.match(noThc.text, /no whole overlap window/);
  const mixed = await verdict(t, {}, (dir) => writeIn(dir, 'tiles-overlap-104-1', 'overlap.json', { schema: OVERLAP_SCHEMA, at: iso(S + 23 * 60 * MIN), skipped: 'until has passed' }));
  assert.equal(mixed.code, 0, mixed.text);
  assert.match(mixed.text, /overlap \(tiles-overlap-104-1\): skipped, until has passed/);
});

test('tiles verdict: a line of another schema is refused', async (t) => {
  const dir = tmp(t);
  mkdirSync(join(dir, 'runs', 'x'), { recursive: true });
  writeFileSync(join(dir, 'runs', 'x', 'rounds.jsonl'), `${JSON.stringify({ schema: 'dom-012-poll/1', kind: 'poll' })}\n`);
  const err = [];
  assert.equal(await main(['--verdict', join(dir, 'r.json'), '--runs', join(dir, 'runs')], { log: () => {}, err: (l) => err.push(l) }), 2);
  assert.match(err.join('\n'), /schema "dom-012-poll\/1", not dom-011-round\/1/);
});

test('tiles download: each completed run gives its own artifacts; one already here is not fetched again', (t) => {
  const dir = tmp(t);
  mkdirSync(join(dir, 'tiles-rounds-11-1'), { recursive: true });
  writeFileSync(join(dir, 'tiles-rounds-11-1', 'rounds.jsonl'), '');
  const calls = [];
  const run = (_cmd, args) => {
    calls.push(args.join(' '));
    if (args[0] === 'run' && args[1] === 'list')
      return {
        status: 0,
        stdout: JSON.stringify([
          { databaseId: 11, status: 'completed', headBranch: 'main', event: 'workflow_dispatch' },
          { databaseId: 12, status: 'completed', conclusion: 'failure', headBranch: 'main', event: 'workflow_dispatch' },
          { databaseId: 13, status: 'in_progress', headBranch: 'main', event: 'workflow_dispatch' },
        ]),
      };
    if (args[0] === 'api') return { status: 0, stdout: args[1].includes('/11/') ? 'tiles-rounds-11-1\ntiles-overlap-11-1\ntiles-rounds-12-1\nother\n' : '' };
    if (args[0] === 'run' && args[1] === 'download') {
      const target = args[args.indexOf('--dir') + 1];
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'overlap.json'), '{}');
      return { status: 0 };
    }
    return { status: 9, stderr: 'unplanned' };
  };
  const out = download('pkgforge-dev/domains.pkgforge.dev', dir, run, () => {});
  assert.deepEqual(out.present, ['tiles-rounds-11-1']);
  assert.deepEqual(out.fetched, ['tiles-overlap-11-1']);
  assert.deepEqual(out.missing, [{ id: 12, conclusion: 'failure' }], 'a name of run 12 listed under run 11 is not taken');
  assert.equal(out.running, 1);
  assert.ok(calls[0].startsWith('run list --repo pkgforge-dev/domains.pkgforge.dev --workflow measure-tiles.yml --branch main '));
  assert.match(calls[0], /--json \S*headBranch,event/);
  // A run of another branch is refused, never read into the evidence.
  for (const planted of [
    { databaseId: 14, status: 'completed', headBranch: 'topic', event: 'workflow_dispatch' },
    { databaseId: 15, status: 'completed', headBranch: 'main', event: 'push' },
  ]) {
    assert.throws(
      () =>
        download(
          'o/n',
          dir,
          (_c, a) => (a[1] === 'list' ? { status: 0, stdout: JSON.stringify([planted]) } : { status: 9, stderr: 'unplanned' }),
          () => {},
        ),
      /not workflow_dispatch on main/,
    );
  }
  assert.throws(
    () =>
      download(
        'o/n',
        dir,
        () => ({ status: 1, stderr: 'auth' }),
        () => {},
      ),
    /gh run list failed: auth/,
  );
});
