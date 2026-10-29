// scripts/root/show.mjs against the GHCR double of scripts/root/fixture.mjs
// (packages/testkit's world): a root read with no credential, as a consumer
// reads it. Each refusal is planted alone. Every root and digest is synthetic.
//
//   node scripts/test.mjs scripts/root --name show
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildRoot, rollbackRoot, SOURCES_LAYER_FORMAT } from '@domains/root';
import { pack as entry } from '../../packages/root/test/helpers.ts';
import { PSL_LIVE, registry, sha } from './fixture.mjs';
import { EXIT } from './lib.mjs';
import { main } from './show.mjs';

const TITLE = 'org.opencontainers.image.title';

async function inRegistry(fn) {
  const reg = registry();
  try {
    await fn(reg);
    assert.deepEqual(reg.w.unusedBodies(), [], 'every GHCR answer body is read or cancelled');
  } finally {
    reg.close();
  }
}

async function show(argv) {
  const out = [];
  const err = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => undefined });
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

const THC = { format: SOURCES_LAYER_FORMAT, sources: [{ id: 'thc-ct', through: '2026-10-27T00:00:00Z', fetched: null }] };

test('show: root:latest prints root_seq, as_of, the pins and each live pack', () =>
  inRegistry(async (reg) => {
    const one = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z' });
    const oneDigest = reg.seedRoot(one);
    const two = buildRoot({
      live: { root: one, digest: oneDigest },
      psl: PSL_LIVE,
      now: '2026-10-29T09:00:00Z',
      add: [entry('names', 'd', '2026-10-26T00:00:00Z')],
      gaps: { 'thc-ct': ['2026-10-04'] },
    });
    const d = reg.seedRoot(two, { sources: THC });
    const r = await show(['--ref', 'latest']);
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out, [
      `root ghcr.io/pkgforge-dev/domains.pkgforge.dev/root:latest ${d}`,
      'format domains.root.v1',
      'root_seq 2',
      'as_of 2026-10-27T00:00:00Z',
      'created 2026-10-29T09:00:00Z',
      `previous ${oneDigest}`,
      `psl ${PSL_LIVE}`,
      `psl_live ${PSL_LIVE}`,
      'dataset names: 1 live pack(s), 10 record(s), corpus_since 2026-10-26T00:00:00Z',
      '  d 2026-10-26T00:00:00Z 2026-10-27T00:00:00Z names:names-d-20261026 10 thc-ct',
      'through thc-ct 2026-10-27T00:00:00Z',
      'gaps thc-ct 2026-10-04',
      'withdrawn none',
    ]);
    // The first root by its dated tag, and by its digest.
    const first = await show(['--ref', 'r-20261029t080000z']);
    assert.equal(first.code, EXIT.ok, first.text);
    assert.ok(first.out.includes('datasets none: no live pack'));
    assert.ok(first.out.includes('previous none'));
    assert.equal((await show([`--ref=${oneDigest}`])).code, EXIT.ok);
    // --json prints root.json as it was read.
    const json = await show(['--json']);
    assert.deepEqual(JSON.parse(json.out.join('\n')), JSON.parse(JSON.stringify(two)));
  }));

test('show: a rolled-back root prints each manifest it withdrew, with its time', () =>
  inRegistry(async (reg) => {
    const one = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z' });
    const day26 = entry('names', 'd', '2026-10-26T00:00:00Z');
    const day27 = entry('names', 'd', '2026-10-27T00:00:00Z');
    const two = buildRoot({ live: { root: one, digest: sha('one') }, psl: PSL_LIVE, now: '2026-10-29T08:10:00Z', add: [day26] });
    const three = buildRoot({ live: { root: two, digest: sha('two') }, psl: PSL_LIVE, now: '2026-10-29T08:20:00Z', add: [day27] });
    const four = rollbackRoot({ live: { root: three, digest: sha('three') }, target: two, between: [], psl: PSL_LIVE, now: '2026-10-29T08:30:00Z' });
    reg.seedRoot(four, { sources: THC });
    const r = await show([]);
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out.slice(-2), ['through thc-ct 2026-10-27T00:00:00Z', `withdrawn ${day27.pack.manifest} 2026-10-29T08:30:00Z`]);
  }));

test('show: an absent root is PRIVATE PACKAGE, exit 4', () =>
  inRegistry(async () => {
    const r = await show([]);
    assert.equal(r.code, EXIT.private, r.text);
    assert.deepEqual(r.out, ['PRIVATE PACKAGE']);
  }));

test('show: a layer that does not hash to its digest is exit 1', () =>
  inRegistry(async (reg) => {
    reg.seedRoot(buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z' }));
    const m = JSON.parse(reg.w.manifests.get('root:latest'));
    const d = m.layers.find((l) => l.annotations[TITLE] === 'root.json').digest;
    const b = reg.bytes.get(d);
    // Planted: one byte of root.json changed, its length kept.
    const bad = b.slice();
    bad[bad.length - 2] = 0x20;
    reg.bytes.set(d, bad);
    const r = await show([]);
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /the blob sha256:[0-9a-f]{64} of pkgforge-dev\/domains\.pkgforge\.dev\/root read as \d+ B hashing to sha256:/);
  }));

test('show: a root of an unknown format is exit 1, and a reader ignores an unknown field', () =>
  inRegistry(async (reg) => {
    const one = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T08:00:00Z' });
    reg.seedRoot({ ...one, format: 'domains.root.v2' });
    const r = await show([]);
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /the format is "domains\.root\.v2"; this reader knows domains\.root\.v1/);
    const later = buildRoot({ live: null, psl: PSL_LIVE, now: '2026-10-29T09:00:00Z' });
    reg.seedRoot({ ...later, added_later: true });
    assert.equal((await show([])).code, EXIT.ok);
  }));

test('show: bad arguments are exit 2', async () => {
  for (const argv of [['--ref'], ['--ref', 'LATEST'], ['--bogus'], ['latest'], ['--ref', 'a', '--ref', 'b']]) {
    const r = await show(argv);
    assert.equal(r.code, EXIT.usage, `${argv.join(' ')}: ${r.text}`);
  }
});
