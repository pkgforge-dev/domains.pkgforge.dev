import fs from 'node:fs'; import { fileURLToPath } from 'node:url';
import { loadPsl, split } from './psl.mjs';
const psl = loadPsl(fileURLToPath(new URL('../psl/psl.dat', import.meta.url)));
function h53(s) { let a = 0x811c9dc5, b = 0x01000193 ^ 0x9747b28c; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15; } return (a >>> 0) + (b & 0x1fffff) * 4294967296; }
const b = fs.readFileSync(process.argv[3]); const T = new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8);
const has = (x) => { let lo = 0, hi = T.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (T[m] === x) return true; if (T[m] < x) lo = m + 1; else hi = m - 1; } return false; };
const names = fs.readFileSync(process.argv[2], 'utf8').split('\n');
const cnt = { hit: new Map(), miss: new Map() }; const regMiss = new Map(); let hit = 0, miss = 0; const missSamples = [];
const sldHit = new Set(), sldAll = new Set();
for (const n of names) { const sp = split(psl.icann, n); sldAll.add(sp.reg || n); const k = has(h53(n)) ? 'hit' : 'miss'; if (k === 'hit') { hit++; sldHit.add(sp.reg || n); } else { miss++; if (missSamples.length < 25 && Math.random() < 0.01) missSamples.push(n); } cnt[k].set(sp.suffix, (cnt[k].get(sp.suffix) || 0) + 1); if (k === 'miss') { const s2 = split(psl.all, n).reg || n; regMiss.set(s2, (regMiss.get(s2) || 0) + 1); } }
const top = (m, k = 12) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k);
console.log(JSON.stringify({ hit, miss, regdomains_total: sldAll.size, regdomains_with_any_name_in_thc: sldHit.size, topMissSuffix: top(cnt.miss), topHitSuffix: top(cnt.hit), topMissSite: top(regMiss, 12), missSamples }, null, 1));
