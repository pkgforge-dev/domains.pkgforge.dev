// adapters/oi-nrd/record.mjs — the recorder of the oi-nrd fixtures (DOM-026,
// design 7.1, settled C9 and C10): it reads the broker once, read-only, as a
// consumer with no group, and writes the recording the contract tests replay.
//
//   node adapters/oi-nrd/record.mjs --out adapters/oi-nrd/fixtures [--host H --port P] [--back 25] [--after 25] [--edge ISO]
//
// In this order:
//   1. the edge B: --edge, a time on a 10-minute edge, or else the next
//      10-minute edge after the clock, which it waits for. Then it polls
//      ListOffsets of the latest offset every 2 s, for at most 120 s, until each
//      topic holds at least --after messages at or after B (ListOffsets(B));
//   2. per topic, C0 = ListOffsets(B) minus --back, no lower than the earliest
//      retained offset or than ListOffsets(B - 10 minutes), so the messages
//      before B lie in one window; the record time T0 of the record at C0. The
//      cursor is { topics: { T: { "0": C0 } }, through: { T: T0 to the second } },
//      and `now` the clock, to the second;
//   3. run 1: run(cursor) with ctx.connect a tap of the live connect
//      (tapConnect of @domains/adapter), the memory writer, the fixture list of
//      the names package and the contact User-Agent as the client id. Each
//      topic writes the window [T0, B) and leaves [B, ...) open, so run 1's
//      cursor is { ListOffsets(B), B };
//   4. run 3: run(cursor 1) with a tap that answers run 1's requests from run
//      1's exchanges, so only its Fetch at ListOffsets(B) reaches the broker. It
//      writes no window: every record it reads is in the open window or at or
//      past the latest offset;
//   5. the check: runAdapter (the harness) over the recording, in process,
//      with the adapter at the recorded address, must pass its three runs, and
//      its runs 1 and 3 must return what the live runs returned; else nothing
//      is written;
//   6. --out/broker.tcp.json (one recording, origin recorded), cursor.json
//      ({ cursor, now }) and recorded.json: the time, the command, the client
//      id, the edge, per topic C0, ListOffsets(B) and the latest offset run 1
//      read, the messages and zone rows read, the list's sha256, and the
//      recording's sha256. A file already there is refused: a recording is
//      replaced by deleting it first.
// It reads no environment and holds no credential: the broker answers plain
// TCP on 9092 with none (DOM-004). The tests pass --edge, a clock, a sleep and
// a connect (record.test.mjs), so they need no wall clock and no network.
//
// stdout, one line each:
//   edge ISO
//   topic T c0 N edge N stop N messages N zone_rows N
//   wrote FILE (sha256 HEX)
// Exit codes: 0 written · 1 the check failed, the broker failed or answered
// too few messages, or a run returned a fault · 2 bad arguments, or a file of
// --out already exists.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { ContractError, encodeTcpRecording, jsonEqual, memoryWriter, parseTcpRecording, runAdapter, tapConnect, validateSourceFile } from '@domains/adapter';
import { decodeBatch, EARLIEST, KafkaConnection, LATEST, partitionKey, ZONESTREAM } from '@domains/adapter/kafka';
import { liveConnect, readBits } from '@domains/adapter/node';
import { loadPsl } from '@domains/names';
import { parseArgs, repeatedFlag } from '../../scripts/lib/args.mjs';
import { oneLine } from '../../scripts/lib/line.mjs';
import { USER_AGENT } from '../../scripts/lib/user-agent.mjs';
import { Fault, UsageError } from '../../scripts/root/lib.mjs';
import { LIMITS, makeRun, TOPICS } from './src/index.ts';
import { isoOf } from './src/window.ts';

export const EXIT = Object.freeze({ ok: 0, fault: 1, usage: 2 });
const ROOT = resolve(import.meta.dirname, '..', '..');
// The list of the names package's tests: the fixtures replay under it.
export const PSL_FILE = join(ROOT, 'packages', 'names', 'test', 'fixtures', 'psl-2026-10-27.dat');
export const SOURCE_FILE = join(import.meta.dirname, 'source.json');
export const FILES = Object.freeze({ recording: 'broker.tcp.json', cursor: 'cursor.json', recorded: 'recorded.json' });
const POLL_MS = 2_000;
const POLL_FOR_MS = 120_000;
const EDGE_S = LIMITS.windowS;
// A Fetch of the batch at C0: one batch of these topics is about 230 bytes.
const PROBE_BYTES = 64 << 10;
const USAGE = 'usage: node adapters/oi-nrd/record.mjs --out DIR [--host H] [--port P] [--back N] [--after N] [--edge ISO]';
const FLAGS = ['out', 'host', 'port', 'back', 'after', 'edge'];

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// The adapter reads no HTTP: a call is a defect.
const noFetch = async (input) => {
  throw new Error(`oi-nrd fetched ${String(input)}; it reads Kafka alone`);
};

function whole(v, name, min, max) {
  if (typeof v !== 'string' || !/^\d+$/.test(v) || Number(v) < min || Number(v) > max) throw new UsageError(`--${name} ${JSON.stringify(v)} is not a whole number from ${min} to ${max}`);
  return Number(v);
}

function parse(argv) {
  const a = parseArgs(argv);
  for (const k of Object.keys(a)) if (k !== '_' && !FLAGS.includes(k)) throw new UsageError(`unknown flag --${k}`);
  const twice = repeatedFlag(a);
  if (twice !== null) throw new UsageError(`--${twice} is given twice`);
  for (const k of FLAGS) if (a[k] === true) throw new UsageError(`--${k} needs a value`);
  if (a._.length > 0) throw new UsageError(`${JSON.stringify(a._[0])} is not a flag`);
  if (a.out === undefined) throw new UsageError('--out is needed');
  let edge = null;
  if (a.edge !== undefined) {
    const ms = Date.parse(a.edge);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(a.edge) || !Number.isFinite(ms) || isoOf(ms / 1000) !== a.edge || (ms / 1000) % EDGE_S !== 0)
      throw new UsageError(`--edge ${JSON.stringify(a.edge)} is not an ISO 8601 UTC time on a ${EDGE_S / 60}-minute edge`);
    edge = ms / 1000;
  }
  const hostname = a.host ?? ZONESTREAM.hostname;
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(hostname)) throw new UsageError(`--host ${JSON.stringify(hostname)} is not a host name`);
  return {
    out: a.out,
    address: { hostname, port: a.port === undefined ? ZONESTREAM.port : whole(a.port, 'port', 1, 65_535) },
    back: a.back === undefined ? 25 : whole(a.back, 'back', 1, 10_000),
    after: a.after === undefined ? 25 : whole(a.after, 'after', 1, 10_000),
    edge,
  };
}

// Steps 1 and 2 over one connection of its own, which is not recorded. The
// wait for the edge comes first: a connection idle for it would pass the
// live connect's idle bound.
async function probe(args, d, asks) {
  const at = `${args.address.hostname}:${args.address.port}`;
  const edge = args.edge ?? (Math.floor(d.now() / 1000 / EDGE_S) + 1) * EDGE_S;
  d.out(`edge ${isoOf(edge)}`);
  const wait = edge * 1000 - d.now();
  if (wait > 0) await d.sleep(wait + 1000);
  let conn;
  try {
    conn = await KafkaConnection.open(d.connect, args.address, USER_AGENT);
  } catch (e) {
    throw new Fault(`${at}: ${e.message}`);
  }
  try {
    const keys = asks.map((a) => partitionKey(a.topic, 0));
    let offsets;
    for (let waited = 0; ; waited += POLL_MS) {
      const [earliest, latest, atEdge, windowStart] = [
        await conn.listOffsets(asks, EARLIEST),
        await conn.listOffsets(asks, LATEST),
        await conn.listOffsets(asks, edge * 1000),
        await conn.listOffsets(asks, (edge - EDGE_S) * 1000),
      ];
      offsets = keys.map((k) => ({ earliest: earliest.get(k), latest: latest.get(k), edge: atEdge.get(k), windowStart: windowStart.get(k) }));
      const short = offsets.flatMap((o, i) => (o.edge === -1 || o.latest - o.edge < args.after ? [`${asks[i].topic} ${o.edge === -1 ? 0 : o.latest - o.edge}`] : []));
      if (short.length === 0) break;
      if (waited >= POLL_FOR_MS) throw new Fault(`after ${POLL_FOR_MS / 1000} s, a topic holds fewer than ${args.after} messages at or after ${isoOf(edge)}: ${short.join(', ')}`);
      await d.sleep(POLL_MS);
    }
    const c0 = offsets.map((o) => Math.max(o.earliest, o.edge - args.back, o.windowStart === -1 ? o.edge : o.windowStart));
    const thin = asks.filter((_, i) => c0[i] >= offsets[i].edge);
    if (thin.length > 0) throw new Fault(`no message lies in the ${EDGE_S / 60} minutes before ${isoOf(edge)} in ${thin.map((a) => a.topic).join(', ')}`);
    const { partitions } = await conn.fetch(
      asks.map((a, i) => ({ topic: a.topic, partition: 0, offset: c0[i], maxBytes: PROBE_BYTES })),
      { maxWaitMs: LIMITS.maxWaitMs, maxBytes: 3 * PROBE_BYTES },
    );
    const through = {};
    const topics = {};
    asks.forEach((a, i) => {
      const p = partitions.get(keys[i]);
      if (p.errorCode !== 0) throw new Fault(`${a.topic}: a Fetch at ${c0[i]} answered the error code ${p.errorCode}`);
      const first = p.batches.flatMap((b) => decodeBatch(b.bytes).records).find((r) => r.offset >= c0[i]);
      if (first === undefined || first.offset !== c0[i]) throw new Fault(`${a.topic}: the Fetch at ${c0[i]} answered no record at that offset`);
      through[a.topic] = isoOf(Math.floor(first.timestamp / 1000));
      topics[a.topic] = { 0: c0[i] };
    });
    return { edge, offsets, cursor: { through, topics } };
  } catch (e) {
    if (e instanceof Fault) throw e;
    throw new Fault(`${at}: ${e.message}`);
  } finally {
    await conn.close();
  }
}

// Step 5's check, on the results: the replayed runs 1 and 3 return the
// segments and the cursor the live runs returned, and run 1 wrote a segment.
// The probe's checks make a failure here a defect of the tap or the replay,
// which this re-checks before a recording is written. Throws Fault.
export function checkReplay(replay, one, three) {
  const same = (a, b) => jsonEqual(a.segments, b.segments) && jsonEqual(a.cursor, b.cursor);
  if (!same(replay.first.result, one) || !same(replay.next.result, three)) throw new Fault('the replayed runs 1 and 3 do not return what the live runs returned');
  if (one.segments.length === 0) throw new Fault('run 1 wrote no segment: the recording would prove nothing');
}

// One run of the adapter at `address` over a tap of the connect: { result, exchanges }.
async function tapped(run, d, cursor, now, psl, prior) {
  const tap = tapConnect(d.connect, prior);
  const result = await run(cursor, Object.freeze({ fetch: noFetch, connect: tap.connect, psl, now, userAgent: USER_AGENT, writer: memoryWriter() }));
  if (result.errors.length > 0) throw new Fault(`a run returned ${result.errors.map((e) => oneLine(`${e.source} ${e.code} ${e.detail}`)).join('; ')}`);
  return { result, exchanges: tap.exchanges };
}

export async function main(argv, deps = {}) {
  const d = {
    out: deps.out ?? console.log,
    err: deps.err ?? console.error,
    now: deps.now ?? (() => Date.now()),
    sleep: deps.sleep ?? ((ms) => delay(ms)),
    connect: deps.connect ?? liveConnect(),
  };
  try {
    const args = parse(argv);
    const paths = Object.fromEntries(Object.entries(FILES).map(([k, f]) => [k, join(args.out, f)]));
    for (const p of Object.values(paths)) if (existsSync(p)) throw new UsageError(`${p} exists: delete it first to record again`);
    const listBytes = readFileSync(PSL_FILE);
    const psl = await loadPsl(listBytes);
    const sources = validateSourceFile(JSON.parse(readFileSync(SOURCE_FILE, 'utf8')), readBits(ROOT)).sources;
    const asks = TOPICS.map((t) => ({ topic: t.topic, partition: 0 }));

    const p = await probe(args, d, asks);
    const now = isoOf(Math.floor(d.now() / 1000));
    const run = makeRun(LIMITS, args.address);
    let one;
    let three;
    try {
      one = await tapped(run, d, p.cursor, now, psl, []);
      three = await tapped(run, d, one.result.cursor, now, psl, one.exchanges);
    } catch (e) {
      if (e instanceof Fault) throw e;
      throw new Fault(`a live run failed: ${e.message}`);
    }
    const text = encodeTcpRecording({ origin: 'recorded', recordedAt: now, address: args.address, exchanges: [...one.exchanges, ...three.exchanges] });

    // 5. The check: the recording replays through the harness as the live runs ran.
    let replay;
    try {
      replay = await runAdapter({ run }, { recordings: [], tcp: [parseTcpRecording(JSON.parse(text), FILES.recording)], psl, cursor: p.cursor, now, userAgent: USER_AGENT, sources });
    } catch (e) {
      if (e instanceof ContractError) throw new Fault(`the recording does not replay through the harness: ${e.message}`);
      throw e;
    }
    checkReplay(replay, one.result, three.result);

    const cursorText = `${JSON.stringify({ cursor: p.cursor, now }, null, 2)}\n`;
    const topics = {};
    TOPICS.forEach((t, i) => {
      const at = one.result.cursor.topics[t.topic]['0'];
      const stop = at + one.result.stats[`${t.source}.lag`];
      topics[t.topic] = {
        source: t.source,
        c0: p.cursor.topics[t.topic]['0'],
        through: p.cursor.through[t.topic],
        edge: p.offsets[i].edge,
        stop,
        messages: one.result.stats[`${t.source}.messages`],
        zone_rows: one.result.stats[`${t.source}.zone_rows`],
      };
      d.out(`topic ${t.topic} c0 ${topics[t.topic].c0} edge ${topics[t.topic].edge} stop ${stop} messages ${topics[t.topic].messages} zone_rows ${topics[t.topic].zone_rows}`);
    });
    const recorded = {
      recorded_at: now,
      command: ['node', relative(ROOT, join(import.meta.dirname, 'record.mjs')).replaceAll('\\', '/'), ...argv].join(' '),
      client_id: USER_AGENT,
      address: `${args.address.hostname}:${args.address.port}`,
      edge: isoOf(p.edge),
      now,
      psl_sha256: psl.sha256,
      recording_sha256: sha256(text),
      topics,
    };
    mkdirSync(args.out, { recursive: true });
    for (const [path, body] of [
      [paths.recording, text],
      [paths.cursor, cursorText],
      [paths.recorded, `${JSON.stringify(recorded, null, 2)}\n`],
    ]) {
      writeFileSync(path, body, { flag: 'wx' });
      d.out(`wrote ${path} (sha256 ${sha256(body)})`);
    }
    return EXIT.ok;
  } catch (e) {
    if (e instanceof UsageError) {
      d.err(`record: ${e.message}\n${USAGE}`);
      return EXIT.usage;
    }
    if (e instanceof Fault) {
      d.err(oneLine(`record: FAIL ${e.message}; nothing is written`));
      return EXIT.fault;
    }
    throw e;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
