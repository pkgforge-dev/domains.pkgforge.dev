// Kafka offsets and message samples for Zonestream (plain 9092). Read-only.
import net from 'node:net'; import zlib from 'node:zlib'; import fs from 'node:fs';
const host = 'kafka.zonestream.openintel.nl', port = 9092;
const sock = net.connect({ host, port });
let buf = Buffer.alloc(0); const waiters = [];
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= 4) { const n = buf.readInt32BE(0); if (buf.length < 4 + n) break; const body = buf.subarray(4, 4 + n); buf = buf.subarray(4 + n); const w = waiters.shift(); if (w) w(body); } });
sock.on('error', (e) => { console.log('socket error', e.message); process.exit(1); });
let corr = 1;
const str = (s) => { const b = Buffer.from(s); const h = Buffer.alloc(2); h.writeInt16BE(b.length); return Buffer.concat([h, b]); };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
function req(apiKey, ver, body) {
  const id = corr++; const hdr = Buffer.alloc(8); hdr.writeInt16BE(apiKey, 0); hdr.writeInt16BE(ver, 2); hdr.writeInt32BE(id, 4);
  const payload = Buffer.concat([hdr, str('pkgforge-probe'), body]); sock.write(Buffer.concat([i32(payload.length), payload]));
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), 20000); waiters.push((b) => { clearTimeout(t); res(b); }); });
}
class R { constructor(b) { this.b = b; this.o = 0; } i8() { return this.b.readInt8(this.o++); } i16() { const v = this.b.readInt16BE(this.o); this.o += 2; return v; } i32() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; } i64() { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v; } s() { const n = this.i16(); if (n < 0) return null; const v = this.b.toString('utf8', this.o, this.o + n); this.o += n; return v; } bytes() { const n = this.i32(); if (n < 0) return null; const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; } }
async function listOffset(topic, ts) {
  const body = Buffer.concat([i32(-1), i32(1), str(topic), i32(1), i32(0), i64(ts)]);
  const r = new R(await req(2, 1, body)); r.i32(); r.i32(); r.s(); r.i32(); r.i32(); const err = r.i16(); const t = r.i64(); const off = r.i64();
  return { err, ts: Number(t), off: Number(off) };
}
function parseSet(b) { // message set v0/v1
  const out = []; let o = 0;
  while (o + 12 <= b.length) {
    const off = b.readBigInt64BE(o); const size = b.readInt32BE(o + 8); if (o + 12 + size > b.length) break;
    const m = b.subarray(o + 12, o + 12 + size); let p = 4; const magic = m.readInt8(p++); const attr = m.readInt8(p++); let ts = null; if (magic >= 1) { ts = Number(m.readBigInt64BE(p)); p += 8; }
    const kl = m.readInt32BE(p); p += 4; if (kl > 0) p += kl; const vl = m.readInt32BE(p); p += 4; const val = vl >= 0 ? m.subarray(p, p + vl) : null;
    const codec = attr & 7;
    if (codec === 1) out.push(...parseSet(zlib.gunzipSync(val))); else if (codec === 0) out.push({ off: Number(off), ts, v: val?.toString('utf8') }); else out.push({ off: Number(off), ts, v: '<codec ' + codec + '>' });
    o += 12 + size;
  }
  return out;
}
async function fetchMsgs(topic, offset, max = 65536) {
  const body = Buffer.concat([i32(-1), i32(3000), i32(1), i32(1), str(topic), i32(1), i32(0), i64(offset), i32(max)]);
  const r = new R(await req(1, 0, body)); r.i32(); r.i32(); r.s(); r.i32(); r.i32(); const err = r.i16(); const hw = r.i64(); const ms = r.bytes();
  return { err, hw: Number(hw), msgs: ms ? parseSet(ms) : [] };
}
const topics = ['newly_registered_domain', 'certstream_domains', 'confirmed_newly_registered_domain', 'newly_issued_certificates_measurements', 'certstream', 'newly_registered_fqdn'];
const now = Date.now(); const res = {};
for (const t of topics) {
  const e = await listOffset(t, -2), l = await listOffset(t, -1);
  const h1 = await listOffset(t, now - 3600e3), h24 = await listOffset(t, now - 86400e3);
  res[t] = { earliest: e.off, latest: l.off, retained: l.off - e.off, off_1h_ago: h1.off, off_24h_ago: h24.off, last_1h: h1.off >= 0 ? l.off - h1.off : null, last_24h: h24.off >= 0 ? l.off - h24.off : null };
  // sample 3 messages at earliest and 3 at latest-3 to read their timestamps
  const f0 = await fetchMsgs(t, e.off, 4096); const f1 = await fetchMsgs(t, Math.max(e.off, l.off - 5), 8192);
  res[t].earliest_msg_ts = f0.msgs[0] ? new Date(f0.msgs[0].ts).toISOString() : null;
  res[t].latest_msg_ts = f1.msgs.length ? new Date(f1.msgs.at(-1).ts).toISOString() : null;
  res[t].sample = [...f0.msgs.slice(0, 2), ...f1.msgs.slice(-2)].map((m) => ({ off: m.off, v: (m.v || '').slice(0, 400) }));
  console.log(t, JSON.stringify({ ...res[t], sample: undefined }));
}
fs.writeFileSync(new URL('../kafka/offsets.json', import.meta.url), JSON.stringify({ at: new Date(now).toISOString(), res }, null, 1));
sock.end(); setTimeout(() => process.exit(0), 300);
