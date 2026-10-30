// scripts/ingest/pack.mjs: the push of a pack from its manifest.json and
// blobs.json, and the pinned list (DOM-024), against the GHCR double of
// scripts/root/fixture.mjs. push.mjs's own lines are planted through
// deps.push; a tag that moves between the two reads of pslFile is planted
// with the double's intercept. Every digest and byte is synthetic.
//
//   node scripts/test.mjs scripts/ingest --name pack
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactType, refTag } from '@domains/ghcr';
import { anonymousReader } from '../ghcr/check-public.mjs';
import { sha } from '../root/fixture.mjs';
import { Fault } from '../root/lib.mjs';
import { inRegistry, PSL, PSL_BYTES, seedList } from './fixture.mjs';
import { pslFile, pushFiles, pushPlanOf } from './pack.mjs';

const TITLE = 'org.opencontainers.image.title';
const D = (c) => `sha256:${c.repeat(64)}`;
const NO_PAUSE = { sleep: async () => undefined, random: () => 0 };

test('pack: pushFiles takes the digest of the pushed or present line, passes another exit through, and a push that exits 0 with no digest is a Fault', async () => {
  const say = (code, lines) => async (_argv, io) => {
    for (const l of lines) io.out(l);
    return code;
  };
  const plan = { pkg: 'obs', tag: 'isc-new.20261028.0123456789ab-d', artifactType: 'T', created: '2026-10-29T00:00:00Z', annotations: [['k', 'v']], files: [{ path: '/w/idx', mediaType: 'M' }] };
  const seen = [];
  const pushed = await pushFiles(plan, {
    push: async (argv, io) => {
      seen.push(argv);
      return say(0, [`pushed ghcr.io/x/obs:${plan.tag} ${D('a')}`])(argv, io);
    },
  });
  assert.deepEqual(pushed, { code: 0, line: `pushed ghcr.io/x/obs:${plan.tag} ${D('a')}`, digest: D('a') });
  assert.deepEqual(seen, [['obs', plan.tag, '--artifact-type', 'T', '--created', '2026-10-29T00:00:00Z', '--annotation', 'k=v', '/w/idx:M']]);
  const present = await pushFiles(plan, { push: say(0, [`present ghcr.io/x/obs:${plan.tag} ${D('b')} (the same layers)`]) });
  assert.equal(present.digest, D('b'));
  assert.deepEqual(await pushFiles(plan, { push: say(3, ['another manifest holds the tag']) }), { code: 3, line: 'another manifest holds the tag', digest: null });
  await assert.rejects(
    pushFiles(plan, { push: say(0, [`pushed ghcr.io/x/obs:${plan.tag}`]) }),
    (e) => e instanceof Fault && e.message === `scripts/ghcr/push.mjs exited 0 for obs:${plan.tag} and printed no digest: pushed ghcr.io/x/obs:${plan.tag}`,
  );
});

test('pack: pushPlanOf takes each layer from the blobs.json file of its title, size and digest, and refuses a file of another size or digest', () => {
  const layer = { mediaType: 'application/octet-stream', digest: D('1'), size: 5, annotations: { [TITLE]: 'part.000' } };
  const manifest = {
    artifactType: 'T',
    annotations: { 'org.opencontainers.image.created': '2026-10-29T00:00:00Z', 'org.opencontainers.image.source': 'S', 'dev.pkgforge.domains.count': '1' },
    layers: [layer],
  };
  const file = { title: 'part.000', file: '/w/part.000', digest: D('1'), size: 5 };
  const config = { title: 'config', file: null, digest: D('2'), size: 2 };
  assert.deepEqual(pushPlanOf(manifest, [config, file]), {
    artifactType: 'T',
    created: '2026-10-29T00:00:00Z',
    annotations: [['dev.pkgforge.domains.count', '1']],
    files: [{ path: '/w/part.000', mediaType: 'application/octet-stream' }],
  });
  for (const other of [
    { ...file, digest: D('3') },
    { ...file, size: 6 },
    { ...file, title: 'part.001' },
  ]) {
    assert.throws(
      () => pushPlanOf(manifest, [config, other]),
      (e) => e instanceof Fault && e.message === `blobs.json names no file of 5 B hashing to ${D('1')} for the layer part.000 of the manifest`,
      JSON.stringify(other),
    );
  }
});

test('pack: pslFile writes the list ref:psl-<sha12> pins, and refuses a pin of another hash and a tag that moves between its two reads', () =>
  inRegistry(async (reg, tmp) => {
    seedList(reg);
    const reader = anonymousReader();
    const path = await pslFile(reader, PSL, join(tmp, 'a'), NO_PAUSE);
    assert.deepEqual(new Uint8Array(readFileSync(path)), new Uint8Array(PSL_BYTES));
    const tag = refTag('psl', PSL);
    // A hash of the same 12 hex as the list's: its tag is the list's tag, which pins the list, not it.
    const twin = `${PSL.slice(0, 12)}${PSL.slice(12).replace(/./g, (c) => (c === 'f' ? 'e' : 'f'))}`;
    assert.equal(refTag('psl', twin), tag);
    await assert.rejects(pslFile(reader, twin, join(tmp, 'b'), NO_PAUSE), (e) => e instanceof Fault && e.message === `ref:${tag} pins ${PSL}, not ${twin}`);
    // The second read of the tag answers another manifest: one with no layer of the list's title, and one whose layer is other bytes.
    const base = reg.w.intercept;
    const moved = (planted) => {
      let gets = 0;
      reg.w.intercept = (url, init) => (init.method !== 'HEAD' && url.endsWith(`/ref/manifests/${tag}`) && ++gets === 2 ? base(url.replace(/[^/]+$/, planted), init) : base(url, init));
    };
    const type = artifactType('ref');
    const ann = { 'dev.pkgforge.domains.sha256': PSL };
    moved(reg.seed('ref', null, type, ann, [{ title: 'other.dat', bytes: PSL_BYTES, mediaType: 'text/plain' }]));
    await assert.rejects(pslFile(reader, PSL, join(tmp, 'c'), NO_PAUSE), (e) => e instanceof Fault && e.message === `ref:${tag} holds no layer public_suffix_list.dat`);
    const bytes = new TextEncoder().encode('// not the list\n');
    moved(reg.seed('ref', null, type, ann, [{ title: 'public_suffix_list.dat', bytes, mediaType: 'text/plain' }]));
    await assert.rejects(pslFile(reader, PSL, join(tmp, 'd'), NO_PAUSE), (e) => e instanceof Fault && e.message === `the layer of ref:${tag} hashes to ${sha(bytes).slice(7)}, not ${PSL}`);
    reg.w.intercept = base;
  }));
