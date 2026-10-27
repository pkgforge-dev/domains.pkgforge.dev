import net from 'node:net'; import zlib from 'node:zlib';
const [topic, offsetArg, maxBytes] = [process.argv[2], process.argv[3], +process.argv[4] || 20000];
const HOST = 'kafka.zonestream.openintel.nl', PORT = 9092;
const i16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }, i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }, i64 = (n) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt(n)); return b; };
const str = (s) => { const t = Buffer.from(s); return Buffer.concat([i16(t.length), t]); };
let corr = 1; const sock = net.connect({ host: HOST, port: PORT, timeout: 20000 }); let buf = Buffer.alloc(0); const waiters = [];
sock.on('data', (d) => { buf = Buffer.concat([buf, d]); while (buf.length >= 4) { const n = buf.readInt32BE(0); if (buf.length < 4 + n) break; const m = buf.subarray(4, 4 + n); buf = buf.subarray(4 + n); const w = waiters.shift(); if (w) w(m); } });
sock.on('error', (e) => { console.log('err', e.code); process.exit(1); }); sock.on('timeout', () => { console.log('timeout'); process.exit(1); });
const call = (api, ver, body) => new Promise((res) => { const hdr = Buffer.concat([i16(api), i16(ver), i32(corr++), str('probe')]); const msg = Buffer.concat([hdr, body]); waiters.push(res); sock.write(Buffer.concat([i32(msg.length), msg])); });
await new Promise((r) => sock.once('connect', r));
const av = await call(18, 0, Buffer.alloc(0)); let o = 6; const cnt = av.readInt32BE(o - 0); // [corr4][err2][count4]
let q = 4 + 2; const n = av.readInt32BE(q); q += 4; const apis = {}; for (let i = 0; i < n; i++) { apis[av.readInt16BE(q)] = [av.readInt16BE(q + 2), av.readInt16BE(q + 4)]; q += 6; }
console.log('Fetch(1) versions', apis[1], 'ListOffsets(2)', apis[2], 'Metadata(3)', apis[3]);
const ver = Math.min(apis[1][1], 4); if (apis[1][0] > 4) { console.log('fetch min version > 4: not supported by this probe'); process.exit(0); }
let off = offsetArg;
if (off === 'latest-5000') { const lb = Buffer.concat([i32(-1), i32(1), str(topic), i32(1), i32(0), i64(-1)]); const r = await call(2, 1, lb); let p = 4 + 4; const tl = r.readInt16BE(p); p += 2 + tl; p += 4 + 4 + 2 + 8; off = Number(r.readBigInt64BE(p)) - 5000; }
const body = Buffer.concat([i32(-1), i32(2000), i32(1), i32(1 << 20), Buffer.from([0]), i32(1), str(topic), i32(1), i32(0), i64(off), i32(maxBytes)]);
const r = await call(1, 4, body); let p = 4 + 4; // corr + throttle
const nt = r.readInt32BE(p); p += 4; const tl = r.readInt16BE(p); p += 2 + tl; const np = r.readInt32BE(p); p += 4; const pid = r.readInt32BE(p); p += 4; const ec = r.readInt16BE(p); p += 2; const hwm = r.readBigInt64BE(p); p += 8; const lso = r.readBigInt64BE(p); p += 8; const na = r.readInt32BE(p); p += 4; p += Math.max(0, na) * 16; const sz = r.readInt32BE(p); p += 4;
console.log('fetch error', ec, 'hwm', Number(hwm), 'recordset bytes', sz);
const rs = r.subarray(p, p + sz); const rdv = (b, pos) => { let v = 0, s = 0, byte; do { byte = b[pos.i++]; v |= (byte & 127) << s; s += 7; } while (byte & 128); return (v >>> 1) ^ -(v & 1); };
let shown = 0, total = 0, bytesPayload = 0; let ptr = 0;
while (ptr + 61 <= rs.length) { const baseOffset = Number(rs.readBigInt64BE(ptr)); const len = rs.readInt32BE(ptr + 8); if (ptr + 12 + len > rs.length) break; const magic = rs[ptr + 16]; const attrs = rs.readInt16BE(ptr + 21); const nrec = rs.readInt32BE(ptr + 57); let body2 = rs.subarray(ptr + 61, ptr + 12 + len); const comp = attrs & 7; if (comp === 1) body2 = zlib.gunzipSync(body2); else if (comp === 4) body2 = zlib.zstdDecompressSync(body2); else if (comp !== 0) { console.log('compression', comp, 'unsupported'); }
  const pos = { i: 0 }; for (let k = 0; k < nrec && pos.i < body2.length; k++) { const rl = rdv(body2, pos); const start = pos.i; pos.i++; rdv(body2, pos); const od = rdv(body2, pos); const kl = rdv(body2, pos); const key = kl >= 0 ? body2.subarray(pos.i, pos.i + kl).toString() : null; if (kl > 0) pos.i += kl; const vl = rdv(body2, pos); const val = vl >= 0 ? body2.subarray(pos.i, pos.i + vl).toString() : null; if (vl > 0) pos.i += vl; pos.i = start + rl; total++; bytesPayload += vl > 0 ? vl : 0; if (shown < 6) { console.log(' rec', baseOffset + od, 'key', key, 'val', (val || '').slice(0, 220)); shown++; } }
  ptr += 12 + len; console.log(' batch magic', magic, 'compression', comp, 'records', nrec); if (ptr > 0 && total > 3000) break; }
console.log('decoded records', total, 'avg value bytes', total ? (bytesPayload / total).toFixed(1) : 0);
process.exit(0);
