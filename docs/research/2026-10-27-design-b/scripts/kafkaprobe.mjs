// hand-rolled Kafka probe: ApiVersions v0 -> Metadata v0 (topics) -> ListOffsets v1 (earliest, latest, and offset at now-24h/-7d)
import net from 'node:net';
const HOST = 'kafka.zonestream.openintel.nl', PORT = 9092;
function i16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function i32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function i64(n) { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; }
function str(s) { const t = Buffer.from(s); return Buffer.concat([i16(t.length), t]); }
let corr = 1;
function frame(api, ver, body) { const hdr = Buffer.concat([i16(api), i16(ver), i32(corr++), str('probe')]); const msg = Buffer.concat([hdr, body]); return Buffer.concat([i32(msg.length), msg]); }
const sock = net.connect({ host: HOST, port: PORT, timeout: 15000 });
let buf = Buffer.alloc(0); const waiters = [];
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= 4) { const n = buf.readInt32BE(0); if (buf.length < 4 + n) break; const m = buf.subarray(4, 4 + n); buf = buf.subarray(4 + n); const w = waiters.shift(); if (w) w(m); } });
sock.on('error', (e) => { console.log('socket error', e.code || e.message); process.exit(1); });
sock.on('timeout', () => { console.log('timeout'); process.exit(1); });
const call = (api, ver, body) => new Promise((res) => { waiters.push(res); sock.write(frame(api, ver, body)); });
await new Promise((r) => sock.once('connect', r)); console.log('tcp connected', HOST, PORT);
const av = await call(18, 0, Buffer.alloc(0)); console.log('ApiVersions error_code', av.readInt16BE(4), 'apis', av.readInt32BE(6));
// Metadata v0, all topics: array length 0 => all topics in v0
const md = await call(3, 0, i32(0));
let o = 4; const nb = md.readInt32BE(o); o += 4; const brokers = [];
for (let i = 0; i < nb; i++) { const id = md.readInt32BE(o); o += 4; const hl = md.readInt16BE(o); o += 2; const host = md.subarray(o, o + hl).toString(); o += hl; const port = md.readInt32BE(o); o += 4; brokers.push(`${id}@${host}:${port}`); }
console.log('brokers', brokers.join(' '));
const nt = md.readInt32BE(o); o += 4; const topics = [];
for (let i = 0; i < nt; i++) { const ec = md.readInt16BE(o); o += 2; const tl = md.readInt16BE(o); o += 2; const name = md.subarray(o, o + tl).toString(); o += tl; const np = md.readInt32BE(o); o += 4; const parts = [];
  for (let p = 0; p < np; p++) { const pec = md.readInt16BE(o); o += 2; const pid = md.readInt32BE(o); o += 4; const leader = md.readInt32BE(o); o += 4; const nr = md.readInt32BE(o); o += 4; o += nr * 4; const ni = md.readInt32BE(o); o += 4; o += ni * 4; parts.push({ pid, leader, pec }); }
  topics.push({ name, ec, parts }); }
console.log('topics', topics.map(t => `${t.name}(ec=${t.ec},parts=${t.parts.length})`).join(' '));
async function offsetAt(topic, part, ts) { // ListOffsets v1
  const body = Buffer.concat([i32(-1), i32(1), str(topic), i32(1), i32(part), i64(ts)]);
  const r = await call(2, 1, body); let q = 4; q += 4; const tl = r.readInt16BE(q); q += 2 + tl; q += 4; const pid = r.readInt32BE(q); q += 4; const ec = r.readInt16BE(q); q += 2; const tsr = r.readBigInt64BE(q); q += 8; const off = r.readBigInt64BE(q); return { ec, off: Number(off), ts: Number(tsr) }; }
const now = Date.now();
for (const t of topics.filter(t => !t.name.startsWith('__'))) {
  for (const p of t.parts) {
    const e = await offsetAt(t.name, p.pid, -2), l = await offsetAt(t.name, p.pid, -1);
    const h1 = await offsetAt(t.name, p.pid, now - 3600e3), d1 = await offsetAt(t.name, p.pid, now - 86400e3), d7 = await offsetAt(t.name, p.pid, now - 7 * 86400e3);
    console.log(t.name, 'p' + p.pid, 'earliest', e.off, 'latest', l.off, 'retained', l.off - e.off, '| last 1h', l.off - h1.off, '| last 24h', l.off - d1.off, '(ec', d1.ec + ')', '| last 7d', l.off - d7.off, '| offset@24h-ago ts', d1.ts);
  }
}
process.exit(0);
