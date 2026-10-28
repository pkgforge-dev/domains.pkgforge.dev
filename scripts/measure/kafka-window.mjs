// scripts/measure/kafka-window.mjs — read a window of certstream_domains
// between two times and count what design A's M8 counted: messages, raw JSON
// bytes, distinct certificates, names and registered domains, and the seconds
// the read took. DOM-004 step 6 runs the same read from a GitHub runner.
//
// Copied from docs/research/2026-10-27-design-a/scripts/kafka-window.mjs. What
// changed: it reads with the shared client (Fetch v4, every partition); the
// window is the offsets ListOffsets gives for the two times, where design A
// stopped at the first message whose own `seen` field passed the end; a message
// that is not JSON is counted in json_errors, where design A skipped it in
// silence; and the outputs go under --data DIR instead of ../kafka/.
//
// Usage: node scripts/measure/kafka-window.mjs T0 T1 NAME [--data DIR] [--host H] [--port P]
//   T0, T1  ISO 8601 times, T0 before T1, inside the topic's retention (about 24 h for certstream_domains, and it moves)
//   NAME    the stem of the outputs: DIR/NAME.names.txt (one name a line),
//           DIR/NAME.names.f64 (the names' 53-bit hashes, sorted, as design A's
//           f64cmp.mjs reads them) and DIR/NAME.stat.json
// Exit codes: 0 read and written, 1 the read failed, 2 bad arguments.
import { join } from 'node:path';
import { consumeRange, KafkaClient, rangesBetween } from './kafka-client.mjs';
import { commonArgs, isMain, run, timeArg, UsageError, writeFileAtomic, writeJson } from './kafka-cli.mjs';

export const WINDOW_TOPIC = 'certstream_domains';

// Design A's 53-bit name hash, kept bit for bit so a .names.f64 written here
// compares with one design A wrote.
export function h53(s) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return (a >>> 0) + (b & 0x1fffff) * 4294967296;
}

// The name a certstream domain_list entry counts as: lower case, without a
// leading wildcard label, as design A counted it.
export const normaliseName = (d) => {
  const l = d.toLowerCase();
  return l.startsWith('*.') ? l.slice(2) : l;
};

// Reads `ranges` of the topic and counts design A's M8 figures. Returns the
// consume counts, the set of names and the stat object design A wrote.
export async function readWindow(client, { topic = WINDOW_TOPIC, ranges, wallCapMs, stats, fetchBytes }) {
  const names = new Set();
  const slds = new Set();
  const certs = new Set();
  const perSource = {};
  const types = {};
  let jsonErrors = 0;
  let firstSeen = null;
  let lastSeen = null;
  const onRecord = (rec) => {
    let j;
    try {
      j = JSON.parse(rec.value === null ? '' : rec.value.toString('utf8'));
    } catch {
      // Counted, not dropped: json_errors is part of the stat.
      jsonErrors += 1;
      return;
    }
    if (typeof j.seen === 'number') {
      firstSeen ??= j.seen;
      lastSeen = j.seen;
    }
    perSource[j.source] = (perSource[j.source] ?? 0) + 1;
    types[j.updateType] = (types[j.updateType] ?? 0) + 1;
    if (j.fingerprint) certs.add(j.fingerprint);
    for (const d of Array.isArray(j.domain_list) ? j.domain_list : []) if (typeof d === 'string') names.add(normaliseName(d));
    for (const d of Array.isArray(j.sld_list) ? j.sld_list : []) if (typeof d === 'string') slds.add(d.toLowerCase());
  };
  const consume = await consumeRange(client, { topic, ranges, wallCapMs, stats, fetchBytes, onRecord });
  const iso = (s) => (s === null ? null : new Date(s * 1000).toISOString());
  const stat = {
    messages: consume.messages,
    raw_json_bytes: consume.raw_bytes,
    wire_bytes: consume.wire_bytes,
    distinct_certs_by_fingerprint: certs.size,
    distinct_names: names.size,
    distinct_slds: slds.size,
    first_seen: iso(firstSeen),
    last_seen: iso(lastSeen),
    fetch_secs: consume.seconds,
    json_errors: jsonErrors,
    ended_by: consume.ended_by,
    types,
    per_source: Object.fromEntries(
      Object.entries(perSource)
        .sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? -1 : 1))
        .slice(0, 25),
    ),
  };
  return { consume, names, stat };
}

// The sorted Float64Array of the names' h53 hashes.
export function hashNames(names) {
  const arr = new Float64Array(names.size);
  let k = 0;
  for (const d of names) arr[k++] = h53(d);
  return arr.sort();
}

async function main(argv) {
  const { args, host, port, data } = commonArgs(argv);
  const [t0iso, t1iso, name] = args._;
  if (!name) throw new UsageError('usage: kafka-window.mjs T0 T1 NAME [--data DIR] [--host H] [--port P]');
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new UsageError('NAME may hold letters, digits, dot, dash and underscore only');
  const t0 = timeArg(t0iso, 'T0');
  const t1 = timeArg(t1iso, 'T1');
  if (t1 <= t0) throw new UsageError('T1 must be after T0');
  const client = await KafkaClient.connect({ host, port });
  try {
    const md = await client.metadata([WINDOW_TOPIC]);
    const topic = md.topics.find((t) => t.name === WINDOW_TOPIC);
    if (!topic || topic.errorCode !== 0) throw new Error(`the broker does not serve ${WINDOW_TOPIC}`);
    const ranges = await rangesBetween(
      client,
      WINDOW_TOPIC,
      topic.partitions.map((p) => p.partition),
      t0,
      t1,
    );
    console.log('start offsets', JSON.stringify(ranges), 'for', t0iso, 'to', t1iso);
    const { names, stat } = await readWindow(client, { ranges });
    const out = { window: [t0iso, t1iso], ...stat };
    writeFileAtomic(join(data, `${name}.names.txt`), [...names].join('\n'));
    const arr = hashNames(names);
    writeFileAtomic(join(data, `${name}.names.f64`), Buffer.from(arr.buffer));
    writeJson(join(data, `${name}.stat.json`), out);
    console.log(JSON.stringify(out));
  } finally {
    client.close();
  }
  return 0;
}

if (isMain(import.meta.url)) await run('kafka-window', main);
