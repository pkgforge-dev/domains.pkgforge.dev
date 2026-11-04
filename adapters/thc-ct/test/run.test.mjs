// adapters/thc-ct through main of scripts/ingest/run.mjs, in process, over the
// synthetic answers of fixtures/ (--recordings; design section 13.4): the disk
// writer, the verifier under the required checks and the volume band, and a
// backfill window pushed to the GHCR double of scripts/root/fixture.mjs. The
// list is the fixture list the answers replay under; the state is a file. No
// test reaches the network or GHCR.
//
//   node scripts/test.mjs adapters/thc-ct --name "thc-ct run"
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyState, proposalFile } from '@domains/state';
import { call, inRegistry, inTmp, stateFile } from '../../../scripts/ingest/fixture.mjs';
import { EXIT, main } from '../../../scripts/ingest/run.mjs';
import { PSL_FILE } from '../record.mjs';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const META = JSON.parse(readFileSync(join(FIXTURES, 'recorded.json'), 'utf8'));
const DAY = META.day;
const NOW = '2026-11-01T00:30:00Z';
const RUN = '41000000002';
const CURSOR = { next: DAY, open: [] };
// The tag of a day file names its bytes: the first 12 hex digits of the gzip's sha256.
const SHA12 = META.slice.gzip_sha256.slice(0, 12);
const TAG = `thc-ct.${DAY.replaceAll('-', '')}.${SHA12}`;

// A state that holds thc-ct's cursor and, when given, a band history of seven days before DAY.
function stateOf(dir, count = null) {
  const history = count === null ? {} : { 'thc-ct': Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${String(24 + i).padStart(2, '0')}`, count, quarantined: false })) };
  return stateFile(dir, { ...emptyState('2026-11-01T00:00:00Z'), cursors: { 'thc-ct': CURSOR }, moved: { 'thc-ct': { at: '2026-11-01T00:00:00Z', run: '41000000000' } }, history });
}
const argsOf = (out, state, more = ['--no-push']) => ['--adapter', 'thc-ct', '--out', out, '--state', state, '--recordings', FIXTURES, '--psl', PSL_FILE, '--now', NOW, '--run', RUN, ...more];
const segmentLines = (r) => r.out.filter((l) => l.startsWith('segment '));

test('thc-ct run: the live run writes the names and the domains segment of the day under the file tag, each verified ok', () =>
  inTmp(async (tmp) => {
    const r = await call(main, argsOf(join(tmp, 'out'), stateOf(tmp)));
    assert.equal(r.code, EXIT.ok, r.text);
    assert.match(r.out[0], /^cursor thc-ct \{"next":"2026-10-31","open":\[\]\} /);
    assert.deepEqual(
      segmentLines(r).map((l) => l.split(' ').slice(0, 6).concat(l.split(' ').at(-1))),
      [
        ['segment', `obs:${TAG}`, 'thc-ct', 'names', `${DAY}T00:00:00Z`, '2026-11-01T00:00:00Z', 'ok'],
        ['segment', `obs:${TAG}-d`, 'thc-ct', 'domains', `${DAY}T00:00:00Z`, '2026-11-01T00:00:00Z', 'ok'],
      ],
    );
    assert.deepEqual(
      r.out.filter((l) => l.startsWith('fault ') || l.startsWith('gap ') || l.startsWith('raw ')),
      [],
    );
    const stats = JSON.parse(r.out.find((l) => l.startsWith('stats thc-ct ')).slice('stats thc-ct '.length));
    assert.deepEqual([stats.files, stats.bytes, stats.from_cs2], [1, META.slice.gzip_bytes, 1]);
    assert.equal(r.out.at(-1), 'no push: --no-push; 2 segment(s) and 0 raw object(s) verified');
    // Both directories hold the file as the layer raw: one blob, two manifests.
    const work = join(tmp, 'out', 'work', 'thc-ct');
    const dirs = readdirSync(work)
      .filter((d) => d.startsWith('thc-ct.'))
      .sort();
    assert.deepEqual(dirs, [TAG, `${TAG}-d`]);
    const raws = dirs.map((d) => JSON.parse(readFileSync(join(work, d, 'blobs.json'), 'utf8')).find((b) => b.title === 'raw'));
    assert.deepEqual(
      raws.map((b) => [b.digest, b.size]),
      [
        [`sha256:${META.slice.gzip_sha256}`, META.slice.gzip_bytes],
        [`sha256:${META.slice.gzip_sha256}`, META.slice.gzip_bytes],
      ],
    );
    // The url annotation is cs2's file URL, where the bytes came from.
    for (const d of dirs) {
      const m = JSON.parse(readFileSync(join(work, d, 'manifest.json'), 'utf8'));
      assert.equal(m.annotations['dev.pkgforge.domains.url'], `https://cs2.ip.thc.org/${DAY}.txt.gz`, d);
    }
  }));

test('thc-ct run: a history whose median puts the day below 40% or above 4 times it gives verdict quarantine on both segments', () =>
  inTmp(async (tmp) => {
    // The day's file is META.slice.gzip_bytes: a median 3 times it puts it under 40%, one a fifth of it over 4 times.
    for (const [count, side] of [
      [META.slice.gzip_bytes * 3, 'below'],
      [Math.floor(META.slice.gzip_bytes / 5), 'above'],
    ]) {
      const r = await call(main, argsOf(join(tmp, side), stateOf(join(tmp), count)));
      assert.equal(r.code, EXIT.ok, `${side}: ${r.text}`);
      assert.deepEqual(
        segmentLines(r).map((l) => l.split(' ').at(-1)),
        ['quarantine', 'quarantine'],
        side,
      );
    }
    // Inside the band: ok.
    const ok = await call(main, argsOf(join(tmp, 'within'), stateOf(tmp, META.slice.gzip_bytes)));
    assert.deepEqual(
      segmentLines(ok).map((l) => l.split(' ').at(-1)),
      ['ok', 'ok'],
    );
  }));

test('thc-ct run: a backfill window of the day reads the bucket, pushes both segments to the double, and writes proposal.thc-ct.20261031.json with the live cursor kept', () =>
  inRegistry(async (reg, tmp) => {
    const out = join(tmp, 'out');
    const r = await call(main, argsOf(out, stateOf(tmp), ['--from', `${DAY}T00:00:00Z`, '--to', '2026-11-01T00:00:00Z']), { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(
      segmentLines(r).map((l) => l.split(' ')[1]),
      [`obs:${TAG}`, `obs:${TAG}-d`],
    );
    const file = join(out, 'proposals', proposalFile('thc-ct', `${DAY}T00:00:00Z`));
    assert.equal(file.replaceAll('\\', '/').split('/').at(-1), 'proposal.thc-ct.20261031.json');
    const p = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual([p.adapter, p.before, p.after], ['thc-ct', CURSOR, CURSOR]);
    assert.deepEqual(
      p.segments.map((s) => [s.ref, s.dataset, s.quarantined]),
      [
        [`obs:${TAG}`, 'names', false],
        [`obs:${TAG}-d`, 'domains', false],
      ],
    );
    assert.deepEqual(p.history, [{ source: 'thc-ct', day: DAY, count: META.slice.gzip_bytes, quarantined: false }]);
    assert.equal(p.gaps, undefined);
    assert.match(r.text, /proposal .*proposal\.thc-ct\.20261031\.json segments 2 raw 0 history 1 cursor kept/);
    // Both manifests are in the double, with the bucket's resolve URL as their url.
    for (const tag of [TAG, `${TAG}-d`]) assert.ok(reg.w.manifests.has(`obs:${tag}`), tag);
    const stats = JSON.parse(r.out.find((l) => l.startsWith('stats thc-ct ')).slice('stats thc-ct '.length));
    assert.deepEqual([stats.from_hf, stats.days], [1, 1]);
    const m = JSON.parse(readFileSync(join(out, 'work', 'thc-ct', TAG, 'manifest.json'), 'utf8'));
    assert.equal(m.annotations['dev.pkgforge.domains.url'], `https://huggingface.co/buckets/IP-THC-ORG/Daily-Cerstream-Dumps/resolve/${META.file.listing_path}?download=true`);
  }));
