// DOM-026 instrument, copied from .tmp/dom026/empty/t.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// Can the disk writer of run.mjs write a domains segment of no record, and does it verify?
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { diskWriter } from '../../../../scripts/ingest/writer.mjs';
import { verifyDir } from '../../../../scripts/ingest/pack.mjs';
import { REQUIRE } from '../../../../scripts/ingest/run.mjs';
const dir = mkdtempSync(join(tmpdir(), 'dom026-empty-'));
const rows = JSON.parse(readFileSync('scripts/ingest/fixtures/sources.json', 'utf8')).sources;
const w = diskWriter({ dir, adapter: 'fixture-stream', sources: rows, psl: '0232f4df0831911356e8ee1f4d5c3b6b12c0ed3f6bd66b0f81c8ab5d3d49e9ca', run: '41000000001', fetched: '2026-10-31T06:00:00Z' });
const seg = await w.write({ source: 'oi-cs', dataset: 'domains', window: { start: '2026-10-31T05:00:00Z', end: '2026-10-31T05:10:00Z' }, cursorBefore: { n: 1 }, cursorAfter: { n: 2 }, precision: 'second' }, []);
console.log('segment', JSON.stringify(seg));
const x = w.segments[0];
const v = await verifyDir({ blobs: x.blobs, annotations: x.manifest.annotations, require: [...REQUIRE], psl: 'packages/names/test/fixtures/psl-2026-10-27.dat', sources: 'scripts/ingest/fixtures/sources.json', history: null, rawBytes: null, work: join(dir, 'verify') }, { err: () => {}, verify: undefined });
console.log('verdict', v.verdict, 'code', v.code);
for (const l of v.lines) console.log('  ', l);
