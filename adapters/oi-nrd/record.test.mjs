// adapters/oi-nrd/record.mjs over the fake broker of test/broker.ts on
// 127.0.0.1, whose head crosses a 10-minute edge. The test passes the edge, a
// clock and a sleep that returns at once (settled C9), so it reads no wall
// clock and waits for nothing; the connect is the production default,
// liveConnect, to the fake broker. Everything here is synthetic.
//
//   node scripts/test.mjs adapters/oi-nrd --name "oi-nrd record"
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseTcpRecording, runAdapter, validateSourceFile } from '@domains/adapter';
import { readBits } from '@domains/adapter/node';
import { loadPsl } from '@domains/names';
import { Fault } from '../../scripts/root/lib.mjs';
import { checkReplay, EXIT, FILES, main, PSL_FILE, SOURCE_FILE } from './record.mjs';
import { LIMITS, makeRun } from './src/index.ts';
import { BASE, CONFIRMED, confirmed, DOMAIN, FQDN, fqdn, nrd, raw, withBroker } from './test/broker.ts';

const ROOT = join(import.meta.dirname, '..', '..');
const EDGE = '2026-10-31T05:50:00Z';
const EDGE_MS = Date.parse(EDGE);
const NOW_MS = EDGE_MS + 95_500;

// A message a second in each topic from a minute before the edge to a minute after it.
const MESSAGES = Array.from({ length: 120 }, (_, i) => {
  const ms = EDGE_MS - 60_000 + i * 1000;
  return [nrd(ms, `d${i}.com`), fqdn(ms, `www.f${i}.net`), confirmed(ms, `c${i}.top`, 1 + (i % 10))];
}).flat();

async function record(argv, { now = NOW_MS } = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { now: () => now, sleep: async () => undefined, out: (l) => out.push(l), err: (l) => err.push(l) });
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

test("oi-nrd record: the recorder's output over the fake broker replays through the harness", () =>
  withBroker(MESSAGES, {}, async (address) => {
    const dir = mkdtempSync(join(tmpdir(), 'oi-nrd-record-'));
    try {
      const args = ['--out', dir, '--host', address.hostname, '--port', String(address.port), '--edge', EDGE];
      const r = await record(args);
      assert.equal(r.code, EXIT.ok, r.text);
      assert.equal(r.out[0], `edge ${EDGE}`);
      const recorded = JSON.parse(readFileSync(join(dir, FILES.recorded), 'utf8'));
      const { cursor, now } = JSON.parse(readFileSync(join(dir, FILES.cursor), 'utf8'));
      const text = readFileSync(join(dir, FILES.recording), 'utf8');
      const rec = parseTcpRecording(JSON.parse(text), FILES.recording);
      assert.deepEqual(rec.address, address);
      assert.equal(rec.origin, 'recorded');
      assert.equal(now, '2026-10-31T05:51:35Z');
      assert.equal(recorded.edge, EDGE);
      assert.equal(recorded.address, `127.0.0.1:${address.port}`);
      // C0 is 25 messages before the edge, whose offset is the 61st message's.
      for (const t of [DOMAIN, FQDN, CONFIRMED]) {
        assert.deepEqual([recorded.topics[t].c0, recorded.topics[t].edge, recorded.topics[t].stop, recorded.topics[t].through], [BASE[t] + 35, BASE[t] + 60, BASE[t] + 120, '2026-10-31T05:49:35Z'], t);
        assert.deepEqual(cursor.topics[t], { 0: BASE[t] + 35 });
      }
      // The replay, as the recorded tests run it: the client id recorded is the user agent.
      const psl = await loadPsl(readFileSync(PSL_FILE));
      assert.equal(recorded.psl_sha256, psl.sha256);
      const sources = validateSourceFile(JSON.parse(readFileSync(SOURCE_FILE, 'utf8')), readBits(ROOT)).sources;
      const h = await runAdapter({ run: makeRun(LIMITS, address) }, { recordings: [], tcp: [rec], psl, cursor, now, userAgent: recorded.client_id, sources });
      assert.deepEqual(
        h.first.result.segments.map((s) => [s.source, s.window.start, s.window.end, s.count]),
        [
          ['oi-nrd', '2026-10-31T05:49:35Z', EDGE, 25],
          ['oi-nrd-fqdn', '2026-10-31T05:49:35Z', EDGE, 25],
          ['oi-nrd-confirmed', '2026-10-31T05:49:35Z', EDGE, 25],
        ],
      );
      assert.deepEqual(h.next.result.segments, []);
      for (const t of [DOMAIN, FQDN, CONFIRMED]) assert.deepEqual(h.first.result.cursor.topics[t], { 0: BASE[t] + 60 });
      assert.deepEqual(
        h.first.connections.map((c) => [c.address, c.opened, c.requests.every((q) => q.exchange !== null)]),
        [[`127.0.0.1:${address.port}`, true, true]],
      );
      // A recording is written once: the second run refuses before it reads the broker.
      const again = await record(args);
      assert.equal(again.code, EXIT.usage, again.text);
      assert.match(again.text, /exists: delete it first to record again/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }));

test('oi-nrd record: too few messages after the edge, or bad arguments, write nothing', () =>
  withBroker(MESSAGES, {}, async (address) => {
    const dir = join(mkdtempSync(join(tmpdir(), 'oi-nrd-record-')), 'fixtures');
    try {
      const few = await record(['--out', dir, '--host', address.hostname, '--port', String(address.port), '--edge', EDGE, '--after', '61']);
      assert.equal(few.code, EXIT.fault, few.text);
      assert.match(few.text, /after 120 s, a topic holds fewer than 61 messages at or after 2026-10-31T05:50:00Z: newly_registered_domain 60/);
      assert.equal(existsSync(dir), false);
      for (const [argv, why] of [
        [[], /--out is needed/],
        [['--out', dir, '--edge', '2026-10-31T05:51:00Z'], /not an ISO 8601 UTC time on a 10-minute edge/],
        // V8 rolls 2026-02-30 to 2026-03-02: only the round trip refuses it.
        [['--out', dir, '--edge', '2026-02-30T00:00:00Z'], /--edge "2026-02-30T00:00:00Z" is not/],
        [['--out', dir, '--port', '0'], /--port "0" is not a whole number from 1 to 65535/],
        [['--out', dir, '--port', '65536'], /--port "65536"/],
        [['--out', dir, '--back', '10001'], /--back "10001" is not a whole number from 1 to 10000/],
        [['--out', dir, '--nope', '1'], /unknown flag --nope/],
        [['--out', dir, '--back', 'x'], /--back "x"/],
        [['--out', dir, '--back', '1', '--back', '2'], /--back is given twice/],
        [['--out', dir, '--back'], /--back needs a value/],
        [['--out', dir, 'extra'], /"extra" is not a flag/],
        [['--out', dir, '--host', 'bad host!'], /--host "bad host!" is not a host name/],
      ]) {
        const bad = await record(argv);
        assert.equal(bad.code, EXIT.usage, `${argv.join(' ')}: ${bad.text}`);
        assert.match(bad.text, why, argv.join(' '));
      }
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  }));

// ---------------------------------------------------------------- the review of DOM-026
// The recorder's guards, each driven (the guard mutation found 20 of 33 unheld).

// A run of the recorder against `messages` on the fake broker, into a fresh directory.
async function recordAgainst(messages, extra = [], { faults = {}, patch = () => {}, deps = {} } = {}) {
  return withBroker(messages, { faults }, async (address, broker) => {
    patch(broker);
    const dir = join(mkdtempSync(join(tmpdir(), 'oi-nrd-record-')), 'fixtures');
    try {
      const out = [];
      const err = [];
      const argv = ['--out', dir, '--host', address.hostname, '--port', String(address.port), ...extra];
      const code = await main(argv, { now: () => NOW_MS, sleep: async () => undefined, out: (l) => out.push(l), err: (l) => err.push(l), ...deps });
      const recorded = existsSync(join(dir, FILES.recorded)) ? JSON.parse(readFileSync(join(dir, FILES.recorded), 'utf8')) : null;
      return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}`, wrote: existsSync(dir), recorded };
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  });
}

test('oi-nrd record: with no --edge it takes the next 10-minute edge after the clock, and sleeps until a second past it', async () => {
  let clock = EDGE_MS - 30_000;
  const sleeps = [];
  const r = await recordAgainst(MESSAGES, [], {
    deps: {
      now: () => clock,
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += ms;
      },
    },
  });
  assert.equal(r.code, EXIT.ok, r.text);
  assert.equal(r.out[0], `edge ${EDGE}`);
  assert.equal(sleeps[0], 31_000);
  assert.equal(r.recorded.now, '2026-10-31T05:50:01Z');
});

test('oi-nrd record: C0 lies --back messages before the edge, no earlier than the first offset at or after the edge minus 10 minutes', async () => {
  // A message every 10 s from 05:35:00 to 05:51:00: the edge 05:50:00 is the 91st, 05:40:00 the 31st.
  const spread = Array.from({ length: 97 }, (_, i) => {
    const ms = Date.parse('2026-10-31T05:35:00Z') + i * 10_000;
    return [nrd(ms, `d${i}.com`), fqdn(ms, `www.f${i}.net`), confirmed(ms, `c${i}.top`, 1 + (i % 10))];
  }).flat();
  const r = await recordAgainst(spread, ['--edge', EDGE, '--back', '100', '--after', '5']);
  assert.equal(r.code, EXIT.ok, r.text);
  for (const t of [DOMAIN, FQDN, CONFIRMED]) assert.deepEqual([r.recorded.topics[t].c0, r.recorded.topics[t].through], [BASE[t] + 30, '2026-10-31T05:40:00Z'], t);
});

test('oi-nrd record: a topic with no message in the 10 minutes before the edge, a Fetch error code, no record at C0, and a run that returns a fault each write nothing', async () => {
  // confirmed_newly_registered_domain starts at the edge.
  const thin = MESSAGES.filter((m) => m.topic !== CONFIRMED || m.recordMs >= EDGE_MS);
  const t1 = await recordAgainst(thin, ['--edge', EDGE]);
  assert.equal(t1.code, EXIT.fault, t1.text);
  assert.match(t1.text, /no message lies in the 10 minutes before 2026-10-31T05:50:00Z in confirmed_newly_registered_domain/);
  assert.equal(t1.wrote, false);
  const t2 = await recordAgainst(MESSAGES, ['--edge', EDGE], { faults: { fetchError: { topic: FQDN, partition: 0, code: 6 } } });
  assert.equal(t2.code, EXIT.fault, t2.text);
  assert.match(t2.text, new RegExp(`newly_registered_fqdn: a Fetch at ${BASE[FQDN] + 35} answered the error code 6`));
  // The batch at C0 removed: the Fetch at C0 answers the next record.
  const t3 = await recordAgainst(MESSAGES, ['--edge', EDGE], {
    patch: (broker) => {
      const part = broker.topics[DOMAIN][0];
      part.batches = part.batches.filter((b) => b.baseOffset !== BASE[DOMAIN] + 35);
    },
  });
  assert.equal(t3.code, EXIT.fault, t3.text);
  assert.match(t3.text, new RegExp(`newly_registered_domain: the Fetch at ${BASE[DOMAIN] + 35} answered no record at that offset`));
  // A message that is not JSON in run 1's window: the run returns the fault malformed.
  const bad = [...MESSAGES, raw(DOMAIN, EDGE_MS - 5_000, '{not json')];
  const t4 = await recordAgainst(
    bad.sort((a, b) => a.recordMs - b.recordMs),
    ['--edge', EDGE],
  );
  assert.equal(t4.code, EXIT.fault, t4.text);
  assert.match(t4.text, /a run returned oi-nrd malformed/);
  assert.equal(t4.wrote, false);
});

test('oi-nrd record: the replay check refuses replayed runs 1 or 3 that differ from the live runs in segments or cursor, and a run 1 of no segment', () => {
  const seg = { source: 'oi-nrd', count: 1 };
  const live = { segments: [seg], cursor: { at: 1 } };
  const three = { segments: [], cursor: { at: 2 } };
  const replay = (first, next) => ({ first: { result: first }, next: { result: next } });
  checkReplay(replay(live, three), live, three);
  for (const [first, next, why] of [
    [{ ...live, segments: [] }, three, /do not return what the live runs returned/],
    [{ ...live, cursor: { at: 9 } }, three, /do not return what the live runs returned/],
    [live, { ...three, segments: [seg] }, /do not return what the live runs returned/],
    [live, { ...three, cursor: { at: 9 } }, /do not return what the live runs returned/],
  ])
    assert.throws(
      () => checkReplay(replay(first, next), live, three),
      (e) => e instanceof Fault && why.test(e.message),
    );
  const none = { segments: [], cursor: { at: 1 } };
  assert.throws(
    () => checkReplay(replay(none, three), none, three),
    (e) => e instanceof Fault && /run 1 wrote no segment/.test(e.message),
  );
});
