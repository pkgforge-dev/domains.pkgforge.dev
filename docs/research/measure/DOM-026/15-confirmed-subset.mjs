// DOM-026 instrument, copied from the door sweep's .scratch/live2.mjs as it ran, with its import
// paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// LIVE2: overlap of oi-nrd and oi-nrd-confirmed keys in the same real hour (read-only live read, memory writer).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkResult, memoryWriter } from '@domains/adapter';
import { liveConnect } from '@domains/adapter/node';
import { loadPsl } from '@domains/names';
import { LIMITS, makeRun } from '../../../../adapters/oi-nrd/src/index.ts';
import { ZONESTREAM } from '@domains/adapter/kafka';
import { USER_AGENT } from '../../../../scripts/lib/user-agent.mjs';
const ROOT = join(import.meta.dirname, '..', '..', '..', '..');
const psl = await loadPsl(readFileSync(join(ROOT, 'packages/names/test/fixtures/psl-2026-10-27.dat')));
const w = memoryWriter();
const now = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const ctx = Object.freeze({ fetch: async () => { throw new Error('no'); }, connect: liveConnect(), psl, now, userAgent: USER_AGENT, writer: w });
const r = checkResult(await makeRun({ ...LIMITS, maxWindowsPerRun: 2 }, ZONESTREAM)(null, ctx), 'live2');
const hour = (s) => w.written.filter((x) => x.segment.source === s && x.segment.window.start === '2026-10-22T14:00:00Z')[0];
const a = hour('oi-nrd'), c = hour('oi-nrd-confirmed');
const A = new Set(a.records.map((x) => x.key)), C = new Set(c.records.map((x) => x.key));
let both = 0; for (const k of C) if (A.has(k)) both++;
let bothConfirmedEvidence = 0, ctRdap = 0, nrdList = 0;
for (const x of c.records) { for (const e of x.evidence ?? []) { if (e.basis === 3) ctRdap++; if (e.basis === 2) nrdList++; } }
console.log('hour 2026-10-22T14:00Z: oi-nrd keys', A.size, 'confirmed keys', C.size, 'confirmed also in oi-nrd', both, `(${(100 * both / C.size).toFixed(1)}%)`);
console.log('confirmed evidence entries: nrd-ct+rdap', ctRdap, 'nrd-list(zone rows)', nrdList);
// how many of the confirmed keys are in oi-nrd, by class
let single = 0, regConf = 0, weak = 0;
for (const x of c.records) { const lvl = Math.max(0, ...((x.evidence ?? []).filter((e) => e.basis === 3).map((e) => e.confidence))); const inA = A.has(x.key); if (lvl >= 1 && lvl <= 5) regConf++; else if (inA) weak++; else single++; }
console.log('confirmed keys: registered-confirmed (level 1-5)', regConf, '| level 6-10 or zone-only and ALSO in oi-nrd (would be "corroborated" by families ct vs registry+ct)', weak, '| not in oi-nrd', single);
