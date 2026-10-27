// Kafka offsets and message samples for Zonestream (plain 9092). Read-only.
import net from 'node:net'; import zlib from 'node:zlib'; import fs from 'node:fs'; import { snappyKafka } from './snappy.mjs';
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
    if (codec === 1) out.push(...parseSet(zlib.gunzipSync(val))); else if (codec === 0) out.push({ off: Number(off), ts, v: val?.toString('utf8') }); else if (codec === 2) out.push(...parseSet(snappyKafka(val))); else out.push({ off: Number(off), ts, v: '<codec ' + codec + '>' });
    o += 12 + size;
  }
  return out;
}
async function fetchMsgs(topic, offset, max = 65536) {
  const body = Buffer.concat([i32(-1), i32(3000), i32(1), i32(1), str(topic), i32(1), i32(0), i64(offset), i32(max)]);
  const r = new R(await req(1, 0, body)); r.i32(); r.i32(); r.s(); r.i32(); r.i32(); const err = r.i16(); const hw = r.i64(); const ms = r.bytes();
  return { err, hw: Number(hw), msgs: ms ? parseSet(ms) : [] };
}

const out = {};
for (const t of ["certstream_domains","certstream","newly_issued_certificates_measurements"]) {
  const l = await listOffset(t, -1);
  const f = await fetchMsgs(t, l.off - 300, 262144);
  out[t] = { latest: l.off, n: f.msgs.length, bytes_per_msg: f.msgs.length ? Math.round(f.msgs.reduce((a,m)=>a+(m.v||"").length,0)/f.msgs.length) : null, sample: f.msgs.slice(0,4).map(m=>({off:m.off,v:(m.v||"").slice(0,500)})) };
  console.log(t, JSON.stringify(out[t], null, 1).slice(0, 2600));
}
fs.writeFileSync(new URL("../kafka/samples.json", import.meta.url), JSON.stringify(out, null, 1));
sock.end(); setTimeout(() => process.exit(0), 300);
