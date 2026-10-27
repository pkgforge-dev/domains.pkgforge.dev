// Minimal Kafka protocol probe: ApiVersions, Metadata, ListOffsets. Read-only.
import net from 'node:net';
import tls from 'node:tls';
const host = 'kafka.zonestream.openintel.nl', port = Number(process.env.KPORT||9091);
const useTls = process.argv[2] === 'tls';
const sock = useTls ? tls.connect({ host, port, servername: host }) : net.connect({ host, port });
let buf = Buffer.alloc(0); const waiters = [];
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); pump(); });
sock.on('error', (e) => { console.log('socket error', e.message); process.exit(1); });
sock.on('close', () => { console.log('closed'); });
function pump() { while (buf.length >= 4) { const n = buf.readInt32BE(0); if (buf.length < 4 + n) return; const body = buf.subarray(4, 4 + n); buf = buf.subarray(4 + n); const w = waiters.shift(); if (w) w(body); } }
let corr = 1;
function str(s) { const b = Buffer.from(s); const h = Buffer.alloc(2); h.writeInt16BE(b.length); return Buffer.concat([h, b]); }
function req(apiKey, ver, body) {
  const id = corr++; const cid = str('pkgforge-probe');
  const hdr = Buffer.alloc(8); hdr.writeInt16BE(apiKey, 0); hdr.writeInt16BE(ver, 2); hdr.writeInt32BE(id, 4);
  const payload = Buffer.concat([hdr, cid, body]); const len = Buffer.alloc(4); len.writeInt32BE(payload.length);
  sock.write(Buffer.concat([len, payload]));
  return new Promise((res, rej) => { const t = setTimeout(() => rej(new Error('timeout')), 15000); waiters.push((b) => { clearTimeout(t); res(b); }); });
}
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
class R { constructor(b) { this.b = b; this.o = 0; } i16() { const v = this.b.readInt16BE(this.o); this.o += 2; return v; } i32() { const v = this.b.readInt32BE(this.o); this.o += 4; return v; } i64() { const v = this.b.readBigInt64BE(this.o); this.o += 8; return v; } s() { const n = this.i16(); if (n < 0) return null; const v = this.b.toString('utf8', this.o, this.o + n); this.o += n; return v; } }
try {
  const av = new R(await req(18, 0, Buffer.alloc(0))); av.i32();
  const err = av.i16(); const n = av.i32(); const apis = {};
  for (let i = 0; i < n; i++) apis[av.i16()] = [av.i16(), av.i16()];
  console.log('ApiVersions err', err, 'Metadata', apis[3], 'ListOffsets', apis[2], 'Fetch', apis[1]);
  const md = new R(await req(3, 0, i32(0))); md.i32();
  const nb = md.i32(); const brokers = [];
  for (let i = 0; i < nb; i++) brokers.push({ id: md.i32(), host: md.s(), port: md.i32() });
  console.log('brokers', JSON.stringify(brokers));
  const nt = md.i32(); const topics = [];
  for (let i = 0; i < nt; i++) { const e = md.i16(); const name = md.s(); const np = md.i32(); const parts = []; for (let j = 0; j < np; j++) { const pe = md.i16(); const pid = md.i32(); const leader = md.i32(); const nr = md.i32(); for (let k = 0; k < nr; k++) md.i32(); const ni = md.i32(); for (let k = 0; k < ni; k++) md.i32(); parts.push({ pid, leader, pe }); } topics.push({ name, e, parts }); }
  console.log('topics', JSON.stringify(topics));
  for (const t of topics) {
    for (const ts of [-2, -1]) {
      const body = Buffer.concat([i32(-1), i32(1), str(t.name), i32(t.parts.length), ...t.parts.flatMap((p) => [i32(p.pid), i64(ts)])]);
      const lo = new R(await req(2, 1, body)); lo.i32();
      const ntp = lo.i32(); const out = [];
      for (let i = 0; i < ntp; i++) { const name = lo.s(); const np = lo.i32(); for (let j = 0; j < np; j++) { const pid = lo.i32(); const pe = lo.i16(); const tsr = lo.i64(); const off = lo.i64(); out.push({ pid, pe, ts: String(tsr), off: String(off) }); } }
      console.log(t.name, ts === -2 ? 'earliest' : 'latest', JSON.stringify(out));
    }
  }
} catch (e) { console.log('ERR', e.message); }
sock.end(); setTimeout(() => process.exit(0), 500);
