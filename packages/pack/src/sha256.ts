// packages/pack/src/sha256.ts — SHA-256 (FIPS 180-4), fed in pieces.
//
// The writer hashes each raw block as it closes it, and a verifier hashes each
// block as it reads it: the annotation `dev.pkgforge.domains.sha256` is the
// SHA-256 of the raw blocks concatenated in order (docs/format.md section 8).
// crypto.subtle.digest takes one buffer, and a day pack holds hundreds of MB of
// raw blocks, so this hash takes them one at a time and holds 64 bytes. It
// imports nothing from `node:`, so it runs in workerd too; checksums.test.ts
// holds it equal to node:crypto.

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
const INITIAL = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

export class Sha256 {
  readonly #h = new Uint32Array(INITIAL);
  readonly #w = new Uint32Array(64);
  readonly #block = new Uint8Array(64);
  #fill = 0;
  #length = 0;
  #done = false;

  #compress(b: Uint8Array, at: number): void {
    const w = this.#w;
    for (let i = 0; i < 16; i += 1) {
      const p = at + 4 * i;
      w[i] = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    }
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
      const s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    const h = this.#h;
    let a = h[0];
    let bb = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let hh = h[7];
    for (let i = 0; i < 64; i += 1) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & bb) ^ (a & c) ^ (bb & c);
      const t2 = (S0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = bb;
      bb = a;
      a = (t1 + t2) | 0;
    }
    h[0] += a;
    h[1] += bb;
    h[2] += c;
    h[3] += d;
    h[4] += e;
    h[5] += f;
    h[6] += g;
    h[7] += hh;
  }

  update(data: Uint8Array): this {
    if (this.#done) throw new Error("Sha256: update after digest");
    let at = 0;
    this.#length += data.length;
    if (this.#fill > 0) {
      const n = Math.min(64 - this.#fill, data.length);
      this.#block.set(data.subarray(0, n), this.#fill);
      this.#fill += n;
      at = n;
      if (this.#fill < 64) return this;
      this.#compress(this.#block, 0);
      this.#fill = 0;
    }
    for (; at + 64 <= data.length; at += 64) this.#compress(data, at);
    if (at < data.length) {
      this.#block.set(data.subarray(at), 0);
      this.#fill = data.length - at;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.#done) throw new Error("Sha256: digest twice");
    this.#done = true;
    const bits = this.#length * 8;
    const tail = new Uint8Array(this.#fill < 56 ? 64 : 128);
    tail.set(this.#block.subarray(0, this.#fill));
    tail[this.#fill] = 0x80;
    const view = new DataView(tail.buffer);
    view.setUint32(tail.length - 8, Math.floor(bits / 2 ** 32));
    view.setUint32(tail.length - 4, bits >>> 0);
    for (let at = 0; at < tail.length; at += 64) this.#compress(tail, at);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    for (let i = 0; i < 8; i += 1) outView.setUint32(4 * i, this.#h[i]);
    return out;
  }

  hex(): string {
    let text = "";
    for (const b of this.digest()) text += b.toString(16).padStart(2, "0");
    return text;
  }
}

export const sha256Hex = (data: Uint8Array): string => new Sha256().update(data).hex();
