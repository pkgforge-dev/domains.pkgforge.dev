export function snappyRaw(src) {
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
export function snappyKafka(b) { // xerial framing or raw
  if (b.length > 16 && b.toString('latin1', 1, 7) === 'SNAPPY') { const parts = []; let p = 16; while (p + 4 <= b.length) { const n = b.readInt32BE(p); p += 4; parts.push(snappyRaw(b.subarray(p, p + n))); p += n; } return Buffer.concat(parts); }
  return snappyRaw(b);
}
