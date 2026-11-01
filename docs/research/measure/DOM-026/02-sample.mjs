// DOM-026 instrument, copied from .tmp/dom026/sample.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// .tmp/dom026/sample.mjs — read-only analysis of the three NRD topics for the
// DOM-026 design, over the repository's own Kafka client
// (scripts/measure/kafka-client.mjs). ListOffsets and Fetch only, as a consumer
// with no group. Writes .tmp/dom026/sample.json.
//
// Usage: node .tmp/dom026/sample.mjs [N]
import { writeFileSync } from 'node:fs';
import { consumeRange, KafkaClient } from '../../../../scripts/measure/kafka-client.mjs';
import { EARLIEST, LATEST } from '../../../../scripts/measure/kafka-protocol.mjs';

const N = Number(process.argv[2] ?? 20000);
const TOPICS = ['newly_registered_domain', 'newly_registered_fqdn', 'confirmed_newly_registered_domain'];
const out = { at: new Date().toISOString(), n: N, topics: {} };

function analyse(msgs) {
  const fields = {};
  let nonMonoTs = 0;
  let nonMonoRecTs = 0;
  let maxBackTs = 0;
  let prevTs = null;
  let prevRec = null;
  let trailingDot = 0;
  let upper = 0;
  let zone = 0;
  let certIdxNeg = 0;
  let jsonErr = 0;
  let keyed = 0;
  let fracTs = 0;
  const ages = [];
  const recMinusTs = [];
  const zoneSamples = [];
  const confidence = {};
  const ctNames = {};
  const byWindow = new Map();
  const distinct = new Set();
  let minTs = Infinity;
  let maxTs = -Infinity;
  for (const m of msgs) {
    if (m.key !== null) keyed += 1;
    let v;
    try {
      v = JSON.parse(m.value.toString('utf8'));
    } catch {
      jsonErr += 1;
      continue;
    }
    const sig = Object.keys(v).sort().join(',');
    fields[sig] = (fields[sig] ?? 0) + 1;
    const name = v.domain ?? v.fqdn;
    if (typeof name === 'string') {
      if (name.endsWith('.')) trailingDot += 1;
      if (name !== name.toLowerCase()) upper += 1;
      distinct.add(name.replace(/\.$/, '').toLowerCase());
    }
    if (v.ct_name === 'zone_data') {
      zone += 1;
      if (zoneSamples.length < 8) zoneSamples.push({ off: m.offset, v });
    }
    if (v.cert_index === -1) certIdxNeg += 1;
    if (v.confidence !== undefined) confidence[v.confidence] = (confidence[v.confidence] ?? 0) + 1;
    ctNames[v.ct_name] = (ctNames[v.ct_name] ?? 0) + 1;
    const ts = v.timestamp;
    if (typeof ts === 'number') {
      if (!Number.isInteger(ts)) fracTs += 1;
      minTs = Math.min(minTs, ts);
      maxTs = Math.max(maxTs, ts);
      if (prevTs !== null && ts < prevTs) {
        nonMonoTs += 1;
        maxBackTs = Math.max(maxBackTs, prevTs - ts);
      }
      prevTs = prevTs === null ? ts : Math.max(prevTs, ts);
      const w = Math.floor(ts / 600) * 600;
      byWindow.set(w, (byWindow.get(w) ?? 0) + 1);
      recMinusTs.push(m.timestamp / 1000 - ts);
      if (typeof v.submission_timestamp === 'number') ages.push(ts - v.submission_timestamp);
    }
    if (prevRec !== null && m.timestamp < prevRec) nonMonoRecTs += 1;
    prevRec = prevRec === null ? m.timestamp : Math.max(prevRec, m.timestamp);
  }
  const q = (arr, p) => {
    if (arr.length === 0) return null;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))];
  };
  const day = 86400;
  const counts = [...byWindow.values()];
  return {
    messages: msgs.length,
    json_errors: jsonErr,
    keyed,
    field_sets: fields,
    trailing_dot: trailingDot,
    upper_case: upper,
    distinct_names: distinct.size,
    zone_rows: zone,
    cert_index_minus_one: certIdxNeg,
    zone_samples: zoneSamples,
    confidence,
    ct_names_top: Object.entries(ctNames)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8),
    timestamp_fractional: fracTs,
    timestamp_min: Number.isFinite(minTs) ? new Date(minTs * 1000).toISOString() : null,
    timestamp_max: Number.isFinite(maxTs) ? new Date(maxTs * 1000).toISOString() : null,
    timestamp_not_monotone: nonMonoTs,
    timestamp_max_step_back_s: maxBackTs,
    record_ts_not_monotone: nonMonoRecTs,
    record_ts_minus_json_ts_s: { p0: q(recMinusTs, 0), p50: q(recMinusTs, 0.5), p99: q(recMinusTs, 0.99), p100: q(recMinusTs, 1 - 1e-12) },
    cert_age_s: ages.length === 0 ? null : { n: ages.length, p10: q(ages, 0.1), p50: q(ages, 0.5), p62: q(ages, 0.62), p90: q(ages, 0.9), max: q(ages, 1 - 1e-12), over_6h: ages.filter((a) => a > 6 * 3600).length, over_7d: ages.filter((a) => a > 7 * day).length, over_30d: ages.filter((a) => a > 30 * day).length, negative: ages.filter((a) => a < 0).length },
    per_10min_window: { windows: counts.length, min: Math.min(...counts), max: Math.max(...counts), median: q(counts, 0.5) },
    samples: msgs.slice(0, 3).map((m) => ({ off: m.offset, rec_ts: m.timestamp, v: m.value.toString('utf8') })),
  };
}

const client = await KafkaClient.connect({});
try {
  await client.apiVersions();
  for (const topic of TOPICS) {
    const lo = await client.listOffsets([{ topic, partitions: [{ partition: 0, timestamp: LATEST }] }]);
    const ea = await client.listOffsets([{ topic, partitions: [{ partition: 0, timestamp: EARLIEST }] }]);
    const latest = lo[0].partitions[0].offset;
    const earliest = ea[0].partitions[0].offset;
    const res = {};
    for (const [label, start] of [
      ['newest', Math.max(earliest, latest - N)],
      ['earliest', earliest],
    ]) {
      const msgs = [];
      const t0 = Date.now();
      const r = await consumeRange(client, {
        topic,
        ranges: [{ partition: 0, start, stop: Math.min(latest, start + N) }],
        fetchBytes: 8 << 20,
        onRecord: (rec) => msgs.push(rec),
      });
      const ms = Date.now() - t0;
      res[label] = { start, stop: Math.min(latest, start + N), read_ms: ms, wire_bytes: r.wire_bytes, frame_bytes: r.bytes, fetches: r.fetches, batches: r.batches, codecs: r.codecs, failed_batches: r.failed_batches, ...analyse(msgs) };
      console.log(topic, label, JSON.stringify({ start, n: msgs.length, ms, wire: r.wire_bytes, fetches: r.fetches, failed: r.failed_batches }));
    }
    out.topics[topic] = { earliest, latest, ...res };
  }
} finally {
  client.close();
}
writeFileSync(new URL('./02-sample.json', import.meta.url), `${JSON.stringify(out, null, 1)}\n`);
console.log('wrote .tmp/dom026/sample.json');
