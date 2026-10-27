// Read one Zonestream topic from the anonymous plain Kafka listener for a UTC window.
// Usage: node zonestream_kafka_window.mjs <topic> <startISO> <endISO> <outfile>
// Output lines: <event_ts>\t<domain-without-trailing-dot>[\t<confidence>]
// No key, no login. Zero dependencies (Kafka wire protocol v0/v1 messages, gzip and snappy).
// The wire-protocol helpers are adapted from the design-A research scripts of this repository.
import net from 'node:net'; import zlib from 'node:zlib'; import fs from 'node:fs';
const host = 'kafka.zonestream.openintel.nl', port = 9092;
const [topic, t0iso, t1iso, outfile] = process.argv.slice(2);
const T0 = Date.parse(t0iso), T1 = Date.parse(t1iso);
function snappyRaw(src) {
  let p = 0, len = 0, shift = 0;
  while (true) { const b = src[p++]; len |= (b & 0x7f) << shift; if (!(b & 0x80)) break; shift += 7; }
  const out = Buffer.alloc(len); let o = 0;
  while (p < src.length) {
    const tag = src[p++]; const t = tag & 3;
    if (t === 0) { let l = tag >> 2; if (l >= 60) { const nb = l - 59; l = 0; for (let i = 0; i < nb; i++) l |= src[p++] << (8 * i); } l += 1; src.copy(out, o, p, p + l); p += l; o += l; }
    else { let l, off; if (t === 1) { l = 4 + ((tag >> 2) & 7); off = ((tag >> 5) << 8) | src[p++]; } else if (t === 2) { l = 1 + (tag >> 2); off = src[p] | (src[p + 1] << 8); p += 2; } else { l = 1 + (tag >> 2); off = src.readUInt32LE(p); p += 4; } for (let i = 0; i < l; i++) { out[o] = out[o - off]; o++; } }
  }
  return out;
}
function snappyKafka(b) {
  if (b.length > 16 && b.toString('latin1', 1, 7) === 'SNAPPY') { const parts = []; let p = 16; while (p + 4 <= b.length) { const n = b.readInt32BE(p); p += 4; parts.push(snappyRaw(b.subarray(p, p + n))); p += n; } return Buffer.concat(parts); }
  return snappyRaw(b);
}
const sock = net.connect({ host, port });
let buf = Buffer.alloc(0); const waiters = [];
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= 4) { const n = buf.readInt32BE(0); if (buf.length < 4 + n) break; const body = buf.subarray(4, 4 + n); buf = buf.subarray(4 + n); const w = waiters.shift(); if (w) w(body); } });
sock.on('error', (e) => { console.error('socket error', e.message); process.exit(1); });
let corr = 1;
const str = (s) => { const b = Buffer.from(s); const h = Buffer.alloc(2); h.writeInt16BE(b.length); return Buffer.concat([h, b]); };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
function req(apiKey, ver, body) {
  const id = corr++; const hdr = Buffer.alloc(8); hdr.writeInt16BE(apiKey, 0); hdr.writeInt16BE(ver, 2); hdr.writeInt32BE(id, 4);
  const payload = Buffer.concat([hdr, str('pkgforge-research'), body]); sock.write(Buffer.concat([i32(payload.length), payload]));
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), 150000); waiters.push((b) => { clearTimeout(t); res(b); }); });
}
class R { constructor(b) { this.b = b; this.o = 0; } i16() { const v = this.b.readInt16BE(this.o); this.o += 2; return v; } i32() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; } i64() { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v; } s() { const n = this.i16(); if (n < 0) return null; const v = this.b.toString('utf8', this.o, this.o + n); this.o += n; return v; } bytes() { const n = this.i32(); if (n < 0) return null; const v = this.b.subarray(this.o, this.o + n); this.o += n; return v; } }
async function listOffset(ts) {
  const body = Buffer.concat([i32(-1), i32(1), str(topic), i32(1), i32(0), i64(ts)]);
  const r = new R(await req(2, 1, body)); r.i32(); r.i32(); r.s(); r.i32(); r.i32(); const err = r.i16(); r.i64(); const off = r.i64();
  return { err, off: Number(off) };
}
function parseSet(b) {
  const out = []; let o = 0;
  while (o + 12 <= b.length) {
    const off = b.readBigInt64BE(o); const size = b.readInt32BE(o + 8); if (o + 12 + size > b.length) break;
    const m = b.subarray(o + 12, o + 12 + size); let p = 4; const magic = m.readInt8(p++); const attr = m.readInt8(p++); if (magic >= 1) p += 8;
    const kl = m.readInt32BE(p); p += 4; if (kl > 0) p += kl; const vl = m.readInt32BE(p); p += 4; const val = vl >= 0 ? m.subarray(p, p + vl) : null;
    const codec = attr & 7;
    if (codec === 1) out.push(...parseSet(zlib.gunzipSync(val))); else if (codec === 0) out.push({ off: Number(off), v: val?.toString('utf8') }); else if (codec === 2) out.push(...parseSet(snappyKafka(val)));
    o += 12 + size;
  }
  return out;
}
async function fetchMsgs(offset, max) {
  const body = Buffer.concat([i32(-1), i32(3000), i32(1), i32(1), str(topic), i32(1), i32(0), i64(offset), i32(max)]);
  const r = new R(await req(1, 0, body)); r.i32(); r.i32(); r.s(); r.i32(); r.i32(); const err = r.i16(); const hw = r.i64(); const ms = r.bytes();
  return { err, hw: Number(hw), msgs: ms ? parseSet(ms) : [] };
}
const start = await listOffset(T0);
console.error(`start offset ${start.off} err=${start.err} for ${t0iso}`);
const ws = fs.createWriteStream(outfile);
let off = start.off, n = 0, done = false; const t0 = Date.now();
while (!done) {
  const f = await fetchMsgs(off, 4 * 1024 * 1024);
  if (f.err) { console.error('fetch err', f.err); break; }
  if (!f.msgs.length) { console.error('no msgs at', off); break; }
  for (const m of f.msgs) {
    if (m.off < off) continue;
    off = m.off + 1;
    let j; try { j = JSON.parse(m.v); } catch { continue; }
    if (j.timestamp * 1000 >= T1) { done = true; break; }
    n++;
    ws.write(`${j.timestamp}\t${String(j.domain).replace(/\.$/, '').toLowerCase()}${j.confidence !== undefined ? '\t' + j.confidence : ''}\n`);
  }
}
ws.end();
console.error(`${topic} ${t0iso}..${t1iso}: ${n} messages, last offset ${off}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
sock.end(); setTimeout(() => process.exit(0), 300);
