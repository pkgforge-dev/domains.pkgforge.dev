import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyState } from '@domains/state';
import { call, inTmp, PSL_FILE, stateFile } from '../../../scripts/ingest/fixture.mjs';
import { EXIT, main } from '../../../scripts/ingest/run.mjs';
import { parseCursor } from '../src/cursor.ts';
import { datedUrl, SOURCE } from '../src/index.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const DAY = '2026-11-26';
const NOW = '2026-12-01T12:00:00Z';
const RUN = '41000000002';

test('isc indexed CLI: one eligible snapshot is verified with the supplying URL and exact raw digest', () =>
  inTmp(async (dir) => {
    const state = stateFile(dir, {
      ...emptyState(NOW),
      cursors: { [SOURCE]: { ...parseCursor(null), next: DAY } },
      moved: { [SOURCE]: { at: NOW, run: RUN } },
    });
    const out = join(dir, 'out');
    const result = await call(main, ['--adapter', SOURCE, '--out', out, '--state', state, '--recordings', FIXTURES, '--psl', PSL_FILE, '--now', NOW, '--run', RUN, '--no-push']);
    assert.equal(result.code, EXIT.ok, result.text);
    const rows = result.out.filter((line) => line.startsWith('segment '));
    assert.equal(rows.length, 1);
    const gzip = Buffer.from(JSON.parse(readFileSync(join(FIXTURES, 'slice.http.json'), 'utf8')).response.body_base64, 'base64');
    const sha = createHash('sha256').update(gzip).digest('hex');
    const tag = `${SOURCE}.${DAY.replaceAll('-', '')}.${sha.slice(0, 12)}-d`;
    assert.ok(rows[0].startsWith(`segment obs:${tag} ${SOURCE} domains ${DAY}T00:00:00Z 2026-11-27T00:00:00Z `));
    assert.ok(rows[0].endsWith(' verdict ok'));
    assert.equal(result.out.at(-1), 'no push: --no-push; 1 segment(s) and 0 raw object(s) verified');
    assert.equal(existsSync(join(out, 'proposals')), false);
    const work = join(out, 'work', SOURCE, tag);
    const manifest = JSON.parse(readFileSync(join(work, 'manifest.json'), 'utf8'));
    assert.equal(manifest.annotations['dev.pkgforge.domains.url'], datedUrl(DAY));
    const raw = JSON.parse(readFileSync(join(work, 'blobs.json'), 'utf8')).find((blob) => blob.title === 'raw');
    assert.deepEqual([raw.digest, raw.size], [`sha256:${sha}`, gzip.length]);
  }));
