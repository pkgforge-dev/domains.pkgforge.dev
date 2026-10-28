// scripts/measure/kafka-runner.mjs — DOM-004: measure OpenINTEL's Kafka broker
// from where this runs (a GitHub runner, through .github/workflows/measure-kafka.yml),
// and judge the result against the entry's pass rule.
//
// The steps (TODO/ingest.md, DOM-004):
//   1. TCP reach of port 9092 and port 9091, 10 s each.
//   2. ApiVersions, Metadata, and ListOffsets of every topic and partition:
//      earliest, latest, and the offsets at now - 1 h, 24 h and 7 d.
//   3. certstream_domains from the offset at now - 15 min to the offset at
//      now - 5 min (10 minutes of messages, ending before the head).
//   4. The three NRD topics, each from its earliest retained offset to the
//      offset 10 minutes of messages later.
//   5. Every batch of steps 3, 4 and 6 is checked (CRC-32C) and decoded; the
//      failures are counted by kind and by codec.
//   6. Design A's M8 read: a 5-minute window of certstream_domains, every
//      message parsed and its names counted, timed. The window is 12:00:00Z to
//      12:05:00Z of the latest day it has ended at least 5 minutes before now
//      (M8 read 2026-10-26T12:00Z, which is past the topic's retention: about
//      24.2 h at 2026-10-28T14:22Z, and it moves),
//      or the window --window names.
//   7. For each topic of steps 3 and 4: wire_bytes_per_day = wire_bytes /
//      messages * messages_24h, and raw_bytes_per_day the same way.
// result.json carries the definition of every count. It records RUNNER_OS,
// RUNNER_ARCH, JOB_STARTED_AT (set by the workflow), GITHUB_RUN_ID and
// GITHUB_SHA, and no address of the runner or of the broker. It is rewritten
// after every step, so a run cut short still leaves what it measured.
//
// Pass rule (--verdict): port 9092 reachable and the reach of 9091 recorded;
// snappy batches decoded and none failed; no batch of any codec failed; the
// 5-minute window held messages and read to its end in under 60 s; wire_bytes_per_day recorded
// for each of the four topics; no step recorded an error.
//
// Usage:
//   node scripts/measure/kafka-runner.mjs [--data DIR] [--out FILE] [--minutes 10]
//        [--back 15] [--wall-cap-min 6] [--window ISO] [--fetch-bytes N]
//        [--host H] [--port 9092] [--alt-port 9091]
//   node scripts/measure/kafka-runner.mjs --verdict FILE
// --out defaults to DIR/result.json. --wall-cap-min bounds each read, so the
// five reads (certstream_domains, the three NRD topics, the 5-minute window)
// take at most 30 minutes of the Measure step's 36.
// Exit codes, measuring: 0 every step ran and the result is written, 1 a step
// recorded an error (the result is still written), 2 bad arguments or the
// result could not be written.
// Exit codes, --verdict: 0 PASS, 1 FAIL, 2 the file cannot be read or is not a
// DOM-004 result.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { consumeRange, KafkaClient, newDecodeStats, offsetSummary, rangesBetween, rangesFromEarliest, reach, userTopics } from './kafka-client.mjs';
import { commonArgs, intArg, isMain, positiveArg, run, timeArg, UsageError, writeJson } from './kafka-cli.mjs';
import { readWindow, WINDOW_TOPIC } from './kafka-window.mjs';

export const SCHEMA = 'domains.pkgforge.dev/measure/DOM-004/kafka-runner@1';
export const CERTSTREAM = 'certstream_domains';
export const NRD_TOPICS = ['newly_registered_domain', 'newly_registered_fqdn', 'confirmed_newly_registered_domain'];
export const CONSUMED = [CERTSTREAM, ...NRD_TOPICS];
export const WINDOW_LIMIT_S = 60;
const MINUTE = 60e3;
const DAY = 86400e3;

export const DEFINITIONS = {
  messages: 'the records of every whole batch counted; a batch counts when its offsets reach into the range read; control records excluded',
  bytes: 'the Fetch v4 responses of the read as they came off the socket, framing and any batch past the range included',
  wire_bytes: 'the counted batches exactly as the broker returned them, still compressed: the bytes the raw lane stores',
  raw_bytes: 'the record values of the counted batches after decoding (the JSON messages)',
  decoded_bytes: 'the counted batches after decompression, 61-byte batch headers included',
  messages_24h: 'from step 2: the latest offset minus the offset at now - 24 h, summed over partitions',
  wire_bytes_per_day: 'wire_bytes / messages * messages_24h',
  raw_bytes_per_day: 'raw_bytes / messages * messages_24h',
  mb_per_second: 'bytes / seconds / 1e6',
  raw_mb_per_second: 'raw_bytes / seconds / 1e6',
  seconds: 'wall time of the read loop, from the first Fetch to the last decoded batch',
  snappy_failures: 'snappy batches that failed to decode: CRC-32C mismatch, a snappy error, or records that do not match the declared count',
  ended_by: 'window: the read reached its stop offset; head: it reached the high watermark first; wall: the wall-time cap stopped it',
};

// The 5-minute window of step 6: 12:00Z on the latest day it ended at least 5
// minutes before now, or, if that is older than the earliest retained message,
// the whole minutes from now - 20 min (fallback true).
export function windowStart(nowMs, earliestMs) {
  let t0 = Math.floor(nowMs / DAY) * DAY + 12 * 60 * MINUTE;
  while (t0 + 10 * MINUTE > nowMs) t0 -= DAY;
  if (earliestMs !== null && t0 < earliestMs) return { t0: Math.floor((nowMs - 20 * MINUTE) / MINUTE) * MINUTE, fallback: true };
  return { t0, fallback: false };
}

// bytes / messages * messages24h, rounded; null when either count is missing.
export function perDay(bytes, messages, messages24h) {
  if (!(messages > 0) || !Number.isFinite(bytes) || !Number.isFinite(messages24h)) return null;
  return Math.round((bytes / messages) * messages24h);
}

const iso = (ms) => new Date(ms).toISOString();

// Runs the seven steps. `o` holds the parsed options; `save` is called with
// the result after every step; `now` is the clock.
export async function measure(o, { save = () => {}, log = console.log, now = Date.now } = {}) {
  const startedMs = now();
  const env = process.env;
  const result = {
    schema: SCHEMA,
    entry: 'DOM-004',
    started_at: iso(startedMs),
    finished_at: null,
    runner: {
      os: env.RUNNER_OS ?? null,
      arch: env.RUNNER_ARCH ?? null,
      job_started_at: env.JOB_STARTED_AT ?? null,
      github_run_id: env.GITHUB_RUN_ID ?? null,
      github_sha: env.GITHUB_SHA ?? null,
      node: process.version,
    },
    host: o.host,
    settings: {
      port: o.port,
      alt_port: o.altPort,
      minutes: o.minutes,
      back_minutes: o.back,
      wall_cap_minutes: o.wallCapMin,
      fetch_bytes: o.fetchBytes,
      window: o.window === null ? null : iso(o.window),
    },
    reach_9092: null,
    reach_9091: null,
    api_versions: null,
    brokers: null,
    metadata_errors: null,
    topics: null,
    consume: {},
    window_5min: null,
    window_5min_seconds: null,
    decode: null,
    snappy_failures: null,
    errors: [],
    definitions: DEFINITIONS,
  };
  const stats = newDecodeStats();
  const wallCapMs = o.wallCapMin * MINUTE;
  const step = async (name, fn) => {
    log(`step ${name}`);
    try {
      await fn();
    } catch (e) {
      result.errors.push({ step: name, error: `${e.name}: ${e.message}` });
      log(`step ${name} failed: ${e.message}`);
    }
    result.decode = stats;
    result.snappy_failures = stats.failed_by_codec.snappy ?? 0;
    save(result);
  };
  // Each step opens its own connection, so a broken stream in one step cannot
  // poison the next.
  const withClient = async (fn) => {
    const client = await KafkaClient.connect({ host: o.host, port: o.port });
    try {
      return await fn(client);
    } finally {
      client.close();
    }
  };
  const partitionsOf = (topic) => {
    const t = result.topics?.[topic];
    if (!t) throw new Error(`step 2 holds no offsets for ${topic}`);
    return t.by_partition.map((p) => p.partition);
  };
  const recordConsume = (topic, window, c) => {
    const m24 = result.topics[topic].last_24h;
    result.consume[topic] = { window, ...c, messages_24h: m24, wire_bytes_per_day: perDay(c.wire_bytes, c.messages, m24), raw_bytes_per_day: perDay(c.raw_bytes, c.messages, m24) };
    log(`  ${topic}: ${c.messages} messages, ${c.wire_bytes} wire bytes, ${c.raw_bytes} raw bytes in ${c.seconds} s (${c.ended_by})`);
  };

  await step('reach', async () => {
    result.reach_9092 = await reach(o.host, o.port, 10e3);
    result.reach_9091 = await reach(o.host, o.altPort, 10e3);
    log(`  9092 ${JSON.stringify(result.reach_9092)}; 9091 ${JSON.stringify(result.reach_9091)}`);
  });
  if (result.reach_9092?.ok !== true) {
    result.errors.push({ step: 'offsets', error: 'skipped: port 9092 is not reachable' });
  } else {
    await step('offsets', () =>
      withClient(async (client) => {
        const apis = await client.apiVersions();
        result.api_versions = Object.fromEntries([1, 2, 3, 18].map((k) => [k, apis.get(k) ?? null]));
        const md = await client.metadata();
        result.brokers = md.brokers;
        // A topic the broker reports with an error is recorded and left out, so
        // it cannot stop the offsets of the others; a consumed topic left out
        // fails its own step below.
        const bad = md.topics.filter((t) => t.errorCode !== 0 || t.partitions.some((p) => p.errorCode !== 0));
        result.metadata_errors = bad.map((t) => ({
          topic: t.name,
          error: t.errorCode,
          partitions: t.partitions.filter((p) => p.errorCode !== 0).map((p) => ({ partition: p.partition, error: p.errorCode })),
        }));
        result.topics = await offsetSummary(
          client,
          userTopics(md).filter((t) => !bad.includes(t)),
          now(),
        );
      }),
    );
    const t3 = now() - o.back * MINUTE;
    await step(`consume ${CERTSTREAM}`, () =>
      withClient(async (client) => {
        const from = t3;
        const to = from + o.minutes * MINUTE;
        const ranges = await rangesBetween(client, CERTSTREAM, partitionsOf(CERTSTREAM), from, to);
        const c = await consumeRange(client, { topic: CERTSTREAM, ranges, wallCapMs, stats, fetchBytes: o.fetchBytes });
        recordConsume(CERTSTREAM, { from: iso(from), to: iso(to), rule: `now - ${o.back} min, for ${o.minutes} min` }, c);
      }),
    );
    for (const topic of NRD_TOPICS) {
      await step(`consume ${topic}`, () =>
        withClient(async (client) => {
          const earliestIso = result.topics?.[topic]?.earliest_ts;
          if (!earliestIso) throw new Error(`step 2 holds no earliest message time for ${topic}`);
          const from = Date.parse(earliestIso);
          const ranges = await rangesFromEarliest(client, topic, partitionsOf(topic), from, o.minutes * MINUTE);
          const c = await consumeRange(client, { topic, ranges, wallCapMs, stats, fetchBytes: o.fetchBytes });
          recordConsume(topic, { from: earliestIso, to: iso(from + o.minutes * MINUTE), rule: `earliest retained message, for ${o.minutes} min` }, c);
        }),
      );
    }
    await step('window', () =>
      withClient(async (client) => {
        const earliestIso = result.topics?.[WINDOW_TOPIC]?.earliest_ts ?? null;
        const chosen = o.window === null ? windowStart(now(), earliestIso === null ? null : Date.parse(earliestIso)) : { t0: o.window, fallback: false };
        const t1 = chosen.t0 + 5 * MINUTE;
        const ranges = await rangesBetween(client, WINDOW_TOPIC, partitionsOf(WINDOW_TOPIC), chosen.t0, t1);
        const { consume, stat } = await readWindow(client, { ranges, wallCapMs, stats, fetchBytes: o.fetchBytes });
        result.window_5min = {
          window: [iso(chosen.t0), iso(t1)],
          fallback: chosen.fallback,
          ranges: consume.ranges,
          bytes: consume.bytes,
          decoded_bytes: consume.decoded_bytes,
          batches: consume.batches,
          messages_per_second: consume.messages_per_second,
          raw_mb_per_second: consume.raw_mb_per_second,
          ...stat,
        };
        result.window_5min_seconds = consume.seconds;
        log(`  window ${iso(chosen.t0)}: ${stat.messages} messages, ${stat.distinct_names} names in ${consume.seconds} s (${consume.ended_by})`);
      }),
    );
  }
  result.finished_at = iso(now());
  save(result);
  return result;
}

const sumOf = (obj) => Object.values(obj ?? {}).reduce((a, n) => a + n, 0);

// The pass rule over a result. {error} when it is not a DOM-004 result;
// otherwise {pass, reasons, lines}: reasons empty exactly when it passes.
export function verdict(r) {
  if (r === null || typeof r !== 'object' || r.schema !== SCHEMA) return { error: `not a DOM-004 kafka-runner result (schema ${JSON.stringify(r?.schema ?? null)}, expected ${SCHEMA})` };
  const reasons = [];
  const lines = [];
  if (r.reach_9092?.ok !== true) reasons.push(`port 9092 is not reachable (${r.reach_9092?.error ?? 'not recorded'})`);
  if (typeof r.reach_9091?.ok !== 'boolean') reasons.push('the reach of port 9091 is not recorded');
  lines.push(
    `reach: 9092 ${r.reach_9092?.ok ? `open in ${r.reach_9092.ms} ms` : `closed (${r.reach_9092?.error ?? 'not recorded'})`}; 9091 ${r.reach_9091?.ok ? `open in ${r.reach_9091.ms} ms` : `closed (${r.reach_9091?.error ?? 'not recorded'})`}`,
  );
  const snappyBatches = r.decode?.by_codec?.snappy ?? 0;
  if (typeof r.snappy_failures !== 'number') reasons.push('snappy_failures is not recorded');
  else if (r.snappy_failures !== 0) reasons.push(`${r.snappy_failures} snappy batch(es) failed to decode`);
  if (!(snappyBatches > 0)) reasons.push('no snappy batch was decoded, so the snappy check proved nothing');
  const failed = sumOf(r.decode?.failures);
  if (failed > 0) reasons.push(`${failed} batch(es) failed to decode, by kind ${JSON.stringify(r.decode.failures)}`);
  lines.push(`decode: ${r.decode?.batches ?? 0} batch(es), by codec ${JSON.stringify(r.decode?.by_codec ?? {})}, failures ${failed}`);
  const s = r.window_5min_seconds;
  if (typeof s !== 'number') reasons.push('the 5-minute window was not read');
  else {
    if (!(s < WINDOW_LIMIT_S)) reasons.push(`the 5-minute window took ${s} s, not under ${WINDOW_LIMIT_S} s`);
    if (r.window_5min?.ended_by !== 'window') reasons.push(`the 5-minute window did not read to its end (ended_by ${r.window_5min?.ended_by ?? 'not recorded'})`);
    if (!(r.window_5min?.messages > 0)) reasons.push('the 5-minute window held no message, so its time proves nothing');
    lines.push(`window ${r.window_5min?.window?.[0] ?? '?'}: ${r.window_5min?.messages ?? '?'} messages in ${s} s`);
  }
  for (const t of CONSUMED) {
    const c = r.consume?.[t];
    if (!Number.isFinite(c?.wire_bytes_per_day)) {
      reasons.push(`wire_bytes_per_day is not recorded for ${t}`);
      continue;
    }
    lines.push(
      `${t}: ${(c.wire_bytes_per_day / 1e9).toFixed(3)} GB a day on the wire, ${Number.isFinite(c.raw_bytes_per_day) ? (c.raw_bytes_per_day / 1e9).toFixed(3) : '?'} GB decoded (sample ${c.messages} messages, ${c.messages_24h} in 24 h)`,
    );
  }
  const errors = Array.isArray(r.errors) ? r.errors : [];
  if (errors.length > 0) reasons.push(`${errors.length} step error(s): ${errors.map((e) => `${e.step}: ${e.error}`).join('; ')}`);
  return { pass: reasons.length === 0, reasons, lines };
}

function judge(file) {
  let r;
  try {
    r = JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`kafka-runner: cannot read ${file}: ${e.message}`);
    return 2;
  }
  const v = verdict(r);
  if (v.error) {
    console.error(`kafka-runner: ${file}: ${v.error}`);
    return 2;
  }
  const where = r.runner?.os ? `${r.runner.os} ${r.runner.arch ?? ''}`.trim() : 'not a runner';
  console.log(`${v.pass ? 'PASS' : 'FAIL'} DOM-004 Kafka from a runner (${where}, started ${r.started_at})`);
  for (const l of v.lines) console.log(`  ${l}`);
  for (const reason of v.reasons) console.log(`  FAIL: ${reason}`);
  return v.pass ? 0 : 1;
}

// The options of a measuring run, from the command line.
export function options(argv) {
  const { args, host, port, data } = commonArgs(argv);
  return {
    host,
    port,
    altPort: args['alt-port'] === undefined ? 9091 : intArg(args['alt-port'], '--alt-port', 1),
    minutes: args.minutes === undefined ? 10 : positiveArg(args.minutes, '--minutes'),
    back: args.back === undefined ? 15 : positiveArg(args.back, '--back'),
    wallCapMin: args['wall-cap-min'] === undefined ? 6 : positiveArg(args['wall-cap-min'], '--wall-cap-min'),
    fetchBytes: args['fetch-bytes'] === undefined ? 8 << 20 : intArg(args['fetch-bytes'], '--fetch-bytes', 1024),
    window: args.window === undefined ? null : timeArg(args.window, '--window'),
    out: typeof args.out === 'string' ? resolve(args.out) : join(data, 'result.json'),
  };
}

async function main(argv) {
  const verdictIndex = argv.indexOf('--verdict');
  if (verdictIndex !== -1) {
    const file = argv[verdictIndex + 1];
    if (!file || file.startsWith('--')) throw new UsageError('--verdict needs a result file');
    return judge(file);
  }
  const o = options(argv);
  if (o.back <= o.minutes) throw new UsageError('--back must be larger than --minutes, so the read of step 3 ends before the head');
  let unwritable = null;
  const save = (result) => {
    try {
      writeJson(o.out, result);
    } catch (e) {
      unwritable = e;
    }
  };
  const result = await measure(o, { save });
  if (unwritable) {
    console.error(`kafka-runner: cannot write ${o.out}: ${unwritable.message}`);
    return 2;
  }
  console.log(`kafka-runner: wrote ${o.out} with ${result.errors.length} step error(s)`);
  return result.errors.length === 0 ? 0 : 1;
}

if (isMain(import.meta.url)) await run('kafka-runner', main);
