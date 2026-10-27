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


function h53(s) { let a = 0x811c9dc5, b = 0x01000193 ^ 0x9747b28c; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15; } return (a >>> 0) + (b & 0x1fffff) * 4294967296; }
const [t0iso, t1iso, outname] = process.argv.slice(2);
const T0 = Date.parse(t0iso), T1 = Date.parse(t1iso);
const start = await listOffset("certstream_domains", T0);
console.log("start offset", start.off, "for", t0iso);
let off = start.off, n = 0, bytes = 0; const names = new Set(), slds = new Set(); const perSource = {}; const types = {}; let lastSeen = 0, firstSeen = 0, certs = new Set();
const t0 = Date.now();
while (true) {
  const f = await fetchMsgs("certstream_domains", off, 4 * 1024 * 1024);
  if (f.err) { console.log("fetch err", f.err); break; }
  if (!f.msgs.length) { console.log("no msgs at", off); break; }
  let done = false;
  for (const m of f.msgs) {
    if (m.off < off) continue;
    off = m.off + 1; bytes += m.v.length;
    let j; try { j = JSON.parse(m.v); } catch { continue; }
    if (j.seen * 1000 >= T1) { done = true; break; }
    n++; if (!firstSeen) firstSeen = j.seen; lastSeen = j.seen;
    perSource[j.source] = (perSource[j.source] || 0) + 1; types[j.updateType] = (types[j.updateType] || 0) + 1;
    certs.add(j.fingerprint);
    for (let d of j.domain_list || []) { d = d.toLowerCase(); if (d.startsWith("*.")) d = d.slice(2); names.add(d); }
    for (const d of j.sld_list || []) slds.add(d.toLowerCase());
  }
  if (done) break;
}
const secs = (Date.now() - t0) / 1000;
fs.writeFileSync(new URL("../kafka/" + outname + ".names.txt", import.meta.url), [...names].join(String.fromCharCode(10)));
const arr = new Float64Array(names.size); let k = 0; for (const d of names) arr[k++] = h53(d); arr.sort();
fs.writeFileSync(new URL("../kafka/" + outname + ".names.f64", import.meta.url), Buffer.from(arr.buffer));
const stat = { window: [t0iso, t1iso], messages: n, raw_json_bytes: bytes, distinct_certs_by_fingerprint: certs.size, distinct_names: names.size, distinct_slds: slds.size, first_seen: new Date(firstSeen * 1000).toISOString(), last_seen: new Date(lastSeen * 1000).toISOString(), fetch_secs: secs, types, per_source: Object.fromEntries(Object.entries(perSource).sort((a, b) => b[1] - a[1]).slice(0, 25)) };
fs.writeFileSync(new URL("../kafka/" + outname + ".stat.json", import.meta.url), JSON.stringify(stat, null, 1));
console.log(JSON.stringify(stat));
sock.end(); setTimeout(() => process.exit(0), 300);
