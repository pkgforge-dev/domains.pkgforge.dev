// front-coded block encoder measurement. usage: node blockenc.mjs <sorted_rev.tsv> <entriesPerBlock>
import fs from 'node:fs'; import readline from 'node:readline'; import zlib from 'node:zlib';
const [inp, per] = [process.argv[2], +process.argv[3] || 4096];
const rl = readline.createInterface({ input: fs.createReadStream(inp, { encoding: 'latin1' }), crlfDelay: Infinity });
function varint(n, out) { while (n >= 128) { out.push((n & 127) | 128); n = Math.floor(n / 128); } out.push(n); }
let prev = '', prevFlags = 0, cur = null; let names = 0, raw = 0, front = 0, blocks = 0, defl = 0, brot = 0, zst = 0, glob = 0;
let bytes = []; let inBlock = 0;
function flush() {
  if (!inBlock) return; const b = Buffer.from(bytes); front += b.length; blocks++;
  defl += zlib.deflateRawSync(b, { level: 9 }).length;
  brot += zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: b.length } }).length;
  zst += zlib.zstdCompressSync(b, { params: { [zlib.constants.ZSTD_c_compressionLevel]: 12 } }).length;
  bytes = []; inBlock = 0; prev = '';
}
function emit(name, flags) {
  let s = 0; const m = Math.min(prev.length, name.length); while (s < m && prev.charCodeAt(s) === name.charCodeAt(s)) s++;
  const suf = Buffer.from(name.slice(s), 'latin1'); varint(s, bytes); varint((suf.length << 2) | flags, bytes); for (const c of suf) bytes.push(c);
  prev = name; inBlock++; names++; raw += name.length + 1;
  if (inBlock >= per) flush();
}
let last = null, lf = 0;
for await (const l of rl) {
  const t = l.indexOf('\t'); const name = l.slice(0, t); const f = l.charCodeAt(t + 1) === 49 ? 2 : 1;
  if (name === last) { lf |= f; continue; }
  if (last !== null) emit(last, lf);
  last = name; lf = f;
}
if (last !== null) emit(last, lf); flush();
const mb = (x) => (x / 1e6).toFixed(1) + ' MB';
console.log(JSON.stringify({ per, names, raw: mb(raw), frontcoded: mb(front), deflate9: mb(defl), brotli9: mb(brot), zstd12: mb(zst), bpn_front: (front / names).toFixed(2), bpn_deflate: (defl / names).toFixed(2), bpn_brotli: (brot / names).toFixed(2), bpn_zstd: (zst / names).toFixed(2), blocks }));
