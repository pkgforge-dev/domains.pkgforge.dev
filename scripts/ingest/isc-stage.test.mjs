import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { artifactType, fileTag } from '@domains/ghcr';
import { emptyState, encodeState } from '@domains/state';
import { datedUrl, SOURCE } from '../../adapters/isc-new/src/index.ts';
import { call, copied, inRegistry, PSL, seedRoot } from './fixture.mjs';
import { ISC_STAGE_FILE } from './isc-stage.mjs';
import { EXIT, main } from './run.mjs';

const FIRST = '2026-01-01';
const SECOND = '2026-01-02';
const END = '2026-01-03';
const NOW = '2026-01-07T00:00:00Z';
const LATER = '2026-01-07T00:05:00Z';
const RUN = '41000000002';
const midnight = (day) => `${day}T00:00:00Z`;
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const tagOf = (day, raw) => fileTag(SOURCE, midnight(day), sha(raw), 'd');

function fixtures(tmp, samples, name = 'recordings') {
  const dir = join(tmp, name);
  mkdirSync(dir);
  const bytes = new Map();
  for (const [pathDay, rowDay, domainname = 'isc.example.com'] of samples) {
    const raw = gzipSync(JSON.stringify([{ domainname, firstseen: rowDay }]));
    bytes.set(pathDay, raw);
    writeFileSync(
      join(dir, `${pathDay}.http.json`),
      JSON.stringify({
        format: 'domains.http-recording.v1',
        origin: 'synthetic',
        request: { method: 'GET', url: datedUrl(pathDay) },
        response: { status: 200, headers: { 'content-type': 'application/x-gzip', 'content-length': String(raw.length) }, body_base64: raw.toString('base64') },
      }),
    );
  }
  return { dir, bytes };
}

function seed(reg) {
  const { digest: rootDigest } = seedRoot(reg);
  const stateDigest = reg.seed('state', 'latest', artifactType('state'), {}, [{ title: 'state.json', bytes: encodeState(emptyState(NOW)) }]);
  // Staging runs against an established public obs package.
  reg.seed('obs', 'fixture', artifactType('raw'), {}, []);
  return { rootDigest, stateDigest };
}

function stage(reg, out, recordings, options = {}) {
  const { start = FIRST, end = END, now = NOW, run = RUN, extra, flags = ['--stage'] } = options;
  return call(main, ['--adapter', SOURCE, '--out', out, '--recordings', recordings, '--psl', 'root', '--from', midnight(start), '--to', midnight(end), '--now', now, '--run', run, ...flags], {
    reg,
    extra,
  });
}

function evidence(out) {
  return readFileSync(join(out, ISC_STAGE_FILE), 'utf8').trimEnd().split('\n').map(JSON.parse);
}

test('ISC staging pins public root, state and PSL and an unchanged second run reuses exact immutable manifests', () =>
  inRegistry(async (reg, tmp) => {
    const { rootDigest, stateDigest } = seed(reg);
    const records = fixtures(tmp, [
      [FIRST, FIRST],
      [SECOND, SECOND],
    ]);
    const out = join(tmp, 'first');
    const first = await stage(reg, out, records.dir);
    assert.equal(first.code, EXIT.ok, first.text);
    const [header, ...rows] = evidence(out);
    assert.deepEqual(header, {
      type: 'stage',
      format: 'domains.isc-stage.v1',
      rootDigest,
      stateDigest,
      domainsSince: null,
      psl: PSL,
      at: NOW,
      run: RUN,
      attempt: 1,
      window: { start: midnight(FIRST), end: midnight(END) },
    });
    const tags = [];
    for (const [i, day] of [FIRST, SECOND].entries()) {
      const raw = records.bytes.get(day);
      const tag = tagOf(day, raw);
      tags.push(tag);
      assert.deepEqual(rows[i], {
        type: 'segment',
        day,
        ref: `obs:${tag}`,
        digest: `sha256:${sha(reg.w.manifests.get(`obs:${tag}`))}`,
        rawSha256: sha(raw),
        rawBytes: raw.length,
        count: 1,
        verdict: 'ok',
        url: datedUrl(day),
      });
    }
    assert.deepEqual(rows[2], { type: 'complete', segments: 2 });
    assert.deepEqual(copied(reg), tags);
    const retryOut = join(tmp, 'again');
    const retry = await stage(reg, retryOut, records.dir, { now: LATER, run: '41000000003' });
    assert.equal(retry.code, EXIT.ok, retry.text);
    assert.deepEqual(evidence(retryOut).slice(1), rows);
    assert.deepEqual(copied(reg), tags);
    assert.equal(existsSync(join(out, 'proposals')), false);
    assert.equal(existsSync(join(retryOut, 'proposals')), false);
    assert.equal(`sha256:${sha(reg.w.manifests.get('state:latest'))}`, stateDigest);
    assert.equal(`sha256:${sha(reg.w.manifests.get('root:latest'))}`, rootDigest);
  }));

test('ISC staging refuses a wrong UTC day in the second snapshot before writing any registry object', () =>
  inRegistry(async (reg, tmp) => {
    seed(reg);
    const records = fixtures(tmp, [
      [FIRST, FIRST],
      [SECOND, FIRST],
    ]);
    const out = join(tmp, 'wrong-day');
    const result = await stage(reg, out, records.dir);
    assert.equal(result.code, EXIT.fault, result.text);
    assert.match(result.text, /firstseen 2026-01-01 disagrees with the archive path day 2026-01-02/);
    assert.deepEqual(copied(reg), []);
    assert.equal(existsSync(join(out, ISC_STAGE_FILE)), false);
    assert.equal(existsSync(join(out, 'proposals')), false);
  }));

test('ISC staging refuses a changed gzip before publishing other dates, and refuses two tags for the same day', () =>
  inRegistry(async (reg, tmp) => {
    seed(reg);
    const original = fixtures(tmp, [[SECOND, SECOND]], 'original');
    const initial = await stage(reg, join(tmp, 'first'), original.dir, { start: SECOND });
    assert.equal(initial.code, EXIT.ok, initial.text);
    const originalTag = copied(reg)[0];
    const changed = fixtures(
      tmp,
      [
        [FIRST, FIRST],
        [SECOND, SECOND, 'another.example.net'],
      ],
      'changed',
    );
    const replaced = await stage(reg, join(tmp, 'changed'), changed.dir);
    assert.equal(replaced.code, EXIT.fault, replaced.text);
    assert.match(replaced.text, /ISC staging conflict for 2026-01-02/);
    assert.deepEqual(copied(reg), [originalTag]);
    const duplicateTag = tagOf(SECOND, changed.bytes.get(SECOND));
    reg.seed('obs', duplicateTag, artifactType('raw'), {}, []);
    const duplicate = await stage(reg, join(tmp, 'duplicate'), original.dir, { start: SECOND });
    assert.equal(duplicate.code, EXIT.fault, duplicate.text);
    assert.match(duplicate.text, new RegExp(duplicateTag.replaceAll('.', '\\.')));
    assert.deepEqual(copied(reg), [originalTag]);
  }));

test('ISC staging keeps the acknowledged prefix after an upload failure and verifies the missing day on retry', () =>
  inRegistry(async (reg, tmp) => {
    seed(reg);
    const records = fixtures(tmp, [
      [FIRST, FIRST],
      [SECOND, SECOND],
    ]);
    const firstTag = tagOf(FIRST, records.bytes.get(FIRST));
    const secondTag = tagOf(SECOND, records.bytes.get(SECOND));
    const out = join(tmp, 'failed');
    const oras = async (args, options) => {
      if (args[0] === 'copy' && args.at(-1).endsWith(`:${secondTag}`)) return { code: 1, stdout: '', stderr: 'synthetic second upload failure' };
      return reg.oras(args, options);
    };
    const failed = await stage(reg, out, records.dir, { extra: { oras } });
    assert.equal(failed.code, EXIT.fault, failed.text);
    assert.match(failed.text, /second upload failure/);
    const partial = evidence(out);
    assert.deepEqual(
      partial.map((row) => row.type),
      ['stage', 'segment'],
    );
    assert.equal(partial[1].ref, `obs:${firstTag}`);
    assert.deepEqual(copied(reg), [firstTag]);
    const retryOut = join(tmp, 'retry');
    const retry = await stage(reg, retryOut, records.dir, { now: LATER });
    assert.equal(retry.code, EXIT.ok, retry.text);
    const all = evidence(retryOut);
    assert.deepEqual(all[1], partial[1]);
    assert.equal(all[2].ref, `obs:${secondTag}`);
    assert.deepEqual(all[3], { type: 'complete', segments: 2 });
    assert.deepEqual(copied(reg), [firstTag, secondTag]);
  }));

test('ISC staging refuses an existing tag with conflicting raw and pack layer identities', () =>
  inRegistry(async (reg, tmp) => {
    seed(reg);
    const records = fixtures(tmp, [[FIRST, FIRST]]);
    const initial = await stage(reg, join(tmp, 'original'), records.dir, { end: SECOND });
    assert.equal(initial.code, EXIT.ok, initial.text);
    const tag = copied(reg)[0];
    const previous = JSON.parse(reg.w.manifests.get(`obs:${tag}`));
    const layers = previous.layers.map((layer) => {
      const title = layer.annotations['org.opencontainers.image.title'];
      const bytes = reg.bytes.get(layer.digest);
      return { title, mediaType: layer.mediaType, bytes: title === 'raw' ? new Uint8Array(bytes.length) : bytes };
    });
    reg.seed('obs', tag, previous.artifactType, previous.annotations, layers);
    const out = join(tmp, 'layer-conflict');
    const conflict = await stage(reg, out, records.dir, { end: SECOND, now: LATER });
    assert.equal(conflict.code, EXIT.fault, conflict.text);
    assert.match(conflict.text, /conflicts with the verified ISC pack or raw layer/);
    assert.equal(existsSync(join(out, ISC_STAGE_FILE)), false);
    assert.deepEqual(copied(reg), [tag]);
  }));

test('ISC staging requires an anonymous raw read matching the immutable layer hash', () =>
  inRegistry(async (reg, tmp) => {
    seed(reg);
    const records = fixtures(tmp, [[FIRST, FIRST]]);
    const initial = await stage(reg, join(tmp, 'initial'), records.dir, { end: SECOND });
    assert.equal(initial.code, EXIT.ok, initial.text);
    const raw = records.bytes.get(FIRST);
    const ref = `sha256:${sha(raw)}`;
    reg.bytes.set(ref, new Uint8Array(raw.length));
    const out = join(tmp, 'bad-readback');
    const corrupt = await stage(reg, out, records.dir, { end: SECOND, now: LATER });
    assert.equal(corrupt.code, EXIT.fault, corrupt.text);
    assert.match(corrupt.text, /does not serve the verified dated gzip bytes/);
    assert.deepEqual(
      evidence(out).map((row) => row.type),
      ['stage'],
    );
    reg.bytes.set(ref, raw);
    const retry = await stage(reg, join(tmp, 'repaired-read'), records.dir, { end: SECOND, now: LATER });
    assert.equal(retry.code, EXIT.ok, retry.text);
    assert.deepEqual(copied(reg), [tagOf(FIRST, raw)]);
  }));

test('ISC staging checks window bounds and the D+5 cutoff before registry reads', () =>
  inRegistry(async (reg, tmp) => {
    const records = fixtures(tmp, []);
    const bounds = await stage(reg, join(tmp, 'bounds'), records.dir, { end: '2026-01-09', now: '2026-01-21T00:00:00Z' });
    assert.equal(bounds.code, EXIT.fault, bounds.text);
    assert.match(bounds.text, /spans more than 7 days/);
    const fresh = await stage(reg, join(tmp, 'fresh'), records.dir, { now: '2026-01-06T23:59:59Z' });
    assert.equal(fresh.code, EXIT.fault, fresh.text);
    assert.match(fresh.text, /last staging day has yet to reach D\+5/);
    const ordinary = await stage(reg, join(tmp, 'ordinary'), records.dir, { flags: [] });
    assert.equal(ordinary.code, EXIT.usage, ordinary.text);
    assert.match(ordinary.text, /publishing an ISC dated backfill requires --stage/);
    assert.deepEqual(reg.w.requests, []);
    assert.deepEqual(reg.calls, []);
  }));
