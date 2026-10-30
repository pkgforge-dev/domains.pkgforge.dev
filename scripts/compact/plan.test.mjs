// scripts/compact/plan.mjs: the plan of one compaction from a root.json file
// or from root:latest in the GHCR double of scripts/root/fixture.mjs. Real
// packs of synthetic records (scripts/compact/fixture.mjs); each refusal is
// planted alone.
//
//   node scripts/test.mjs scripts/compact --name "plan cli"
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CompactError, MAX_LAYERS, packManifest, planFile, planRanges, planTier } from '@domains/compact';
import { DirPartsSink, fileDigest } from '@domains/compact/node';
import { artifactType, GhcrError } from '@domains/ghcr';
import { FEED_CODEC, IDX_TITLE, PackError, readIdx, writePack } from '@domains/pack';
import { nodeCompress, writerId } from '@domains/pack/node';
import { buildRoot, SOURCES_LAYER_FORMAT } from '@domains/root';
import { pack } from '../../packages/root/test/helpers.ts';
import { MAX_LAYERS as PUSH_MAX_LAYERS } from '../ghcr/push.mjs';
import { RateLimitError } from '../ghcr/rate.mjs';
import { registry } from '../root/fixture.mjs';
import { Fault, UsageError } from '../root/lib.mjs';
import { main as assembleMain } from './assemble.mjs';
import { dayIso, PSL, rootOf, week, writeInput } from './fixture.mjs';
import { EXIT, lines, main, onOutput } from './plan.mjs';
import { main as rangeMain } from './range.mjs';

const MONDAY = '2026-10-19T00:00:00Z';

async function plan(argv, deps = {}) {
  const out = [];
  const err = [];
  const code = await main(argv, { out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => undefined, ...deps });
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

async function inTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'compact-plan-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const weekArgs = (w, dir, more = []) => [
  '--dataset',
  'names',
  '--tier',
  'w',
  '--span',
  MONDAY,
  '--root',
  w.rootPath,
  '--inputs',
  w.inputsDir,
  '--out',
  join(dir, 'plan.json'),
  '--matrix',
  join(dir, 'matrix.json'),
  ...more,
];

test('plan cli: a whole week is ready: its inputs, its ranges and the matrix', () =>
  inTmp(async (dir) => {
    const w = await week(join(dir, 'in'), 'names', MONDAY);
    const r = await plan(weekArgs(w, dir, ['--ranges', '3', '--records-per-block', '4', '--page-entries', '2']));
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out[0], 'verdict ready names:names-w-2026w43 2026-10-19T00:00:00Z 2026-10-26T00:00:00Z');
    assert.equal(r.out.filter((l) => l.startsWith('input names:names-d-')).length, 7);
    assert.match(r.text, /^ranges key 3 bytes \d+,\d+,\d+$/m);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'matrix.json'), 'utf8')), { include: [{ range: 0 }, { range: 1 }, { range: 2 }] });
    const file = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
    assert.equal(file.format, 'domains.compact-plan.v1');
    assert.equal(file.key.cuts.length, 2);
    assert.equal(file.records_per_block, 4);
    assert.equal(file.time, null);
    assert.equal(r.out.at(-2), `plan ${file.id}`);
  }));

// A root of synthetic entries (packages/root/test/helpers.ts): the plan's
// verdict is read before any index, so no pack is on disk.
function syntheticRoot(dir, add) {
  const root = buildRoot({ live: null, psl: PSL, now: '2026-10-29T08:00:00Z', add });
  const rootPath = join(dir, 'root.json');
  writeFileSync(rootPath, JSON.stringify(root));
  return rootPath;
}

test('plan cli: a week whose day is still in hour packs waits, exit 3, and names the day and the packs there', () =>
  inTmp(async (dir) => {
    const days = [0, 1, 2, 4, 5, 6].map((d) => pack('names', 'd', new Date(Date.parse(MONDAY) + d * 86_400_000).toISOString().replace('.000Z', 'Z'), { psl: PSL }));
    const hours = Array.from({ length: 24 }, (_, h) => pack('names', 'h', `2026-10-22T${String(h).padStart(2, '0')}:00:00Z`, { psl: PSL }));
    const rootPath = syntheticRoot(dir, [...days, ...hours]);
    const r = await plan(['--dataset', 'names', '--tier', 'w', '--span', MONDAY, '--root', rootPath, '--matrix', join(dir, 'matrix.json')]);
    assert.equal(r.code, EXIT.wait, r.text);
    assert.equal(r.out[0], 'verdict wait names:names-w-2026w43 2026-10-19T00:00:00Z 2026-10-26T00:00:00Z');
    const missing = r.out.find((l) => l.startsWith('missing '));
    assert.match(missing, /^missing 2026-10-22T00:00:00Z 2026-10-23T00:00:00Z no d pack covers it; found names:names-h-2026102200 .* names:names-h-2026102223$/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'matrix.json'), 'utf8')), { include: [] });
  }));

test('plan cli: an input index that is not the one the root names is a fault, exit 1', () =>
  inTmp(async (dir) => {
    const w = await week(join(dir, 'in'), 'names', MONDAY);
    const idx = join(w.inputs[2].dir, 'idx');
    const bytes = readFileSync(idx);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(idx, bytes);
    const r = await plan(weekArgs(w, dir));
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /plan: FAIL .*names-d-20261021.idx is \d+ B hashing to sha256:[0-9a-f]{64}; the root names names:names-d-20261021's idx/);
  }));

test('plan cli: a live pack across the unit edge is a fault (straddle), exit 1', () =>
  inTmp(async (dir) => {
    const rootPath = syntheticRoot(dir, [pack('names', 'w', '2026-09-28T00:00:00Z', { psl: PSL }), pack('names', 'd', '2026-10-05T00:00:00Z', { psl: PSL })]);
    const r = await plan(['--dataset', 'names', '--tier', 'm', '--span', '2026-10-01T00:00:00Z', '--root', rootPath]);
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /plan: FAIL straddle names:names-w-2026w40 \(tier w/);
  }));

test('plan cli: a root file that is not JSON or not a root is a fault, exit 1; inputs not on disk are exit 2', () =>
  inTmp(async (dir) => {
    const notJson = join(dir, 'not.json');
    writeFileSync(notJson, '{"format":');
    const a = await plan(['--dataset', 'names', '--tier', 'w', '--span', MONDAY, '--root', notJson]);
    assert.equal(a.code, EXIT.fault, a.text);
    assert.match(a.text, /plan: FAIL --root .*not\.json is not JSON/);
    const notRoot = join(dir, 'not-root.json');
    writeFileSync(notRoot, JSON.stringify({ format: 'domains.root.v0' }));
    const b = await plan(['--dataset', 'names', '--tier', 'w', '--span', MONDAY, '--root', notRoot]);
    assert.equal(b.code, EXIT.fault, b.text);
    assert.match(b.text, /plan: FAIL --root .*not-root\.json: /);
    const w = await week(join(dir, 'in'), 'names', MONDAY);
    const c = await plan(['--dataset', 'names', '--tier', 'w', '--span', MONDAY, '--root', w.rootPath, '--inputs', join(dir, 'empty')]);
    assert.equal(c.code, EXIT.usage, c.text);
    assert.match(c.text, /--inputs: .*names-d-20261019[\\/]idx does not exist/);
  }));

test('plan cli: bad arguments are exit 2', async () => {
  for (const argv of [
    ['--dataset', 'names', '--tier', 'w'],
    ['--dataset', 'names', '--tier', 'h', '--span', MONDAY, '--root', 'x'],
    ['--dataset', 'names', '--tier', 'w', '--span', '2026-10-20T00:00:00Z', '--root', 'no-such-root.json'],
    ['--dataset', 'names', '--tier', 'w', '--span', MONDAY, '--root', 'x', '--ref', 'latest'],
    ['--dataset', 'names', '--tier', 'w', '--span', MONDAY, '--ranges', '0'],
    ['--dataset', 'names', '--tier', 'w', '--span', MONDAY, '--bogus', '1'],
  ]) {
    const r = await plan(argv);
    assert.equal(r.code, EXIT.usage, `${argv.join(' ')}\n${r.text}`);
  }
});

test('plan cli: an excluded pack is printed in its own package, a quarantined segment of obs', () => {
  // planTier and planFile on synthetic entries: validateRoot refuses the field
  // `quarantine` until DOM-029 adds it, so no root.json carries the mark yet.
  const seg = { ...pack('feed', 'seg', '2026-10-06T00:00:00Z', { end: '2026-10-07T00:00:00Z', sources: ['oi-nrd'] }).pack, quarantine: true };
  const day = (d) => pack('feed', 'd', `2026-10-${String(d).padStart(2, '0')}T00:00:00Z`).pack;
  const tier = planTier({ datasets: { feed: [day(5), seg, day(7), day(8), day(9), day(10), day(11)] } }, 'feed', 'w', '2026-10-05T00:00:00Z');
  assert.equal(tier.verdict, 'ready', tier.reason);
  const file = planFile({ plan: tier, root: `sha256:${'e'.repeat(64)}`, key: { cuts: [], ranges: 1, bytes: [0], total: 0 }, time: null });
  const printed = lines(file);
  assert.deepEqual(
    printed.filter((l) => l.startsWith('excluded ')),
    [`excluded obs:${seg.tag} ${seg.manifest} quarantined`],
  );
  assert.equal(printed.filter((l) => l.startsWith('input feed:feed-d-')).length, 6);
});

test('plan cli: --root with --ref, or --ranges with --target-bytes, is exit 2 before anything is read, on a root that plans alone', () =>
  inTmp(async (dir) => {
    const rootPath = syntheticRoot(dir, [pack('names', 'd', MONDAY, { psl: PSL })]);
    const reader = {
      getManifest: async () => {
        throw new TypeError('a read of GHCR');
      },
    };
    const base = ['--dataset', 'names', '--tier', 'd', '--span', MONDAY, '--root', rootPath];
    // Each flag alone plans the unit: it is present.
    for (const more of [[], ['--ranges', '1'], ['--target-bytes', '5']]) {
      const ok = await plan([...base, ...more], { reader });
      assert.equal(ok.code, EXIT.ok, `${more.join(' ')}\n${ok.text}`);
    }
    for (const [more, why] of [
      [['--ref', 'latest'], /^plan: --root and --ref are two roots; give one$/m],
      [['--ranges', '1', '--target-bytes', '5'], /^plan: --ranges and --target-bytes both set the ranges; give one$/m],
    ]) {
      const r = await plan([...base, ...more], { reader });
      assert.equal(r.code, EXIT.usage, `${more.join(' ')}\n${r.text}`);
      assert.match(r.text, why);
    }
  }));

test('plan cli: root:latest and the inputs read from GHCR with no credential give the plan the files give', () =>
  inTmp(async (dir) => {
    const w = await week(join(dir, 'in'), 'names', MONDAY);
    const local = await plan(weekArgs(w, dir, ['--ranges', '3', '--records-per-block', '4']));
    assert.equal(local.code, EXIT.ok, local.text);
    const localPlan = JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8'));
    const reg = registry();
    try {
      for (const i of w.inputs) {
        const layers = readdirSync(i.dir).map((title) => ({ title, bytes: readFileSync(join(i.dir, title)) }));
        reg.seed('names', i.tag, artifactType('pack'), i.manifest.annotations, layers);
      }
      const sources = Object.entries(w.root.through).map(([id, through]) => ({ id, through, fetched: null }));
      reg.seedRoot(w.root, { sources: { format: SOURCES_LAYER_FORMAT, sources } });
      const out = join(dir, 'ghcr.json');
      const remote = await plan(['--dataset', 'names', '--tier', 'w', '--span', MONDAY, '--ranges', '3', '--records-per-block', '4', '--out', out]);
      assert.equal(remote.code, EXIT.ok, remote.text);
      const remotePlan = JSON.parse(readFileSync(out, 'utf8'));
      assert.deepEqual(remotePlan.key, localPlan.key);
      assert.deepEqual(remotePlan.inputs, localPlan.inputs);
      assert.match(remotePlan.root, /^sha256:[0-9a-f]{64}$/);
      assert.deepEqual(reg.w.unusedBodies(), [], 'every GHCR answer body is read or cancelled');
    } finally {
      reg.close();
    }
  }));

async function call(fn, argv, deps = {}) {
  const out = [];
  const err = [];
  const code = await fn(argv, { out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => undefined, env: {}, ...deps });
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

test('plan cli: a unit already built is present, and a week across the first of a month is skip: exit 0, no ranges, an empty matrix, the plan written', () =>
  inTmp(async (dir) => {
    const weekAcross = Array.from({ length: 7 }, (_, d) => pack('names', 'd', dayIso(Date.parse('2026-10-26T00:00:00Z') + d * 86_400_000), { psl: PSL }));
    const cases = [
      ['present', [pack('names', 'd', MONDAY, { psl: PSL })], 'd', MONDAY, /^verdict present names:names-d-20261019 /, /^reason names:names-d-20261019 is live and spans the unit$/m],
      ['skip', weekAcross, 'w', '2026-10-26T00:00:00Z', /^verdict skip names:names-w-2026w44 /, /^reason the week .* crosses the first of a month/m],
    ];
    for (const [label, packs, tier, span, verdict, reason] of cases) {
      const at = join(dir, label);
      mkdirSync(at);
      const rootPath = syntheticRoot(at, packs);
      const r = await plan(['--dataset', 'names', '--tier', tier, '--span', span, '--root', rootPath, '--out', join(at, 'plan.json'), '--matrix', join(at, 'matrix.json')]);
      assert.equal(r.code, EXIT.ok, `${label}\n${r.text}`);
      assert.match(r.out[0], verdict);
      assert.match(r.text, reason);
      assert.equal(r.out.filter((l) => l.startsWith('ranges ')).length, 0, label);
      assert.equal(r.out.at(-1), 'matrix {"include":[]}');
      const file = JSON.parse(readFileSync(join(at, 'plan.json'), 'utf8'));
      assert.equal(file.verdict, label);
      assert.equal(file.key, null);
      assert.equal(file.time, null);
      assert.deepEqual(JSON.parse(readFileSync(join(at, 'matrix.json'), 'utf8')), { include: [] });
    }
  }));

test('plan cli: a day the root names as a gap, with no pack of it, is skip: exit 0, no ranges, an empty matrix (ruling 24)', () =>
  inTmp(async (dir) => {
    const root = buildRoot({ live: null, psl: PSL, now: '2026-10-29T08:00:00Z', add: [pack('domains', 'd', '2026-10-26T00:00:00Z', { psl: PSL })], gaps: { 'thc-ct': ['2026-10-27'] } });
    const rootPath = join(dir, 'root.json');
    writeFileSync(rootPath, JSON.stringify(root));
    const r = await plan(['--dataset', 'domains', '--tier', 'd', '--span', '2026-10-27T00:00:00Z', '--root', rootPath, '--out', join(dir, 'plan.json'), '--matrix', join(dir, 'matrix.json')]);
    assert.equal(r.code, EXIT.ok, r.text);
    assert.match(r.out[0], /^verdict skip names:domains-d-20261027 /);
    assert.match(r.text, /^reason every day of the unit is a gap the root names/m);
    assert.equal(r.out.filter((l) => l.startsWith('ranges ')).length, 0);
    assert.equal(r.out.at(-1), 'matrix {"include":[]}');
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'matrix.json'), 'utf8')), { include: [] });
    assert.equal(JSON.parse(readFileSync(join(dir, 'plan.json'), 'utf8')).verdict, 'skip');
  }));

test('plan cli: a time copy that wants one range more than the key copy is cut into as many as the key copy, and the ranges and the assembly merge it', () =>
  inTmp(async (dir) => {
    const w = await week(join(dir, 'in'), 'feed', MONDAY);
    const totalOf = (title) =>
      planRanges(
        w.inputs.map((i) => readIdx(readFileSync(join(i.dir, title)))),
        { ranges: 1 },
      ).total;
    const key = totalOf('idx');
    const time = totalOf('time.idx');
    // docs/format.md section 14.6: the time copy is 0.982 to 1.104 of the key copy's bytes.
    assert.ok(time > key, `the time copy of the fixture, ${time} B, is larger than its key copy, ${key} B`);
    // A target at which the key copy is 2 ranges and the time copy 3.
    const target = Math.ceil(key / 2);
    assert.ok(target < time / 2 && target >= time / 3, `target ${target} B: key ${key} B, time ${time} B`);
    const planPath = join(dir, 'plan.json');
    const r = await plan([
      '--dataset',
      'feed',
      '--tier',
      'w',
      '--span',
      MONDAY,
      '--root',
      w.rootPath,
      '--inputs',
      w.inputsDir,
      '--target-bytes',
      String(target),
      '--records-per-block',
      '4',
      '--page-entries',
      '2',
      '--out',
      planPath,
    ]);
    assert.equal(r.code, EXIT.ok, r.text);
    assert.match(r.text, /^ranges key 2 bytes \d+,\d+$/m);
    assert.match(r.text, /^ranges time 2 merge$/m);
    const ranges = join(dir, 'ranges');
    const x = await call(rangeMain, ['all', '--plan', planPath, '--inputs', w.inputsDir, '--out', ranges]);
    assert.equal(x.code, 0, x.text);
    assert.equal(x.out.filter((l) => l.startsWith('count time ')).length, 2);
    writeFileSync(join(dir, 'tags.json'), '[]');
    const a = await call(assembleMain, ['--plan', planPath, '--dir', ranges, '--out', join(dir, 'asm'), '--tags', join(dir, 'tags.json'), '--run', '7', '--inputs', w.inputsDir]);
    assert.equal(a.code, 0, a.text);
    assert.match(a.text, /^check time: merged, \d+ part\(s\), bound to the key copy$/m);
  }));

// A feed day pack of no record, with no time copy: a writer's validateRoot
// asks a time copy only of a pack that holds records (docs/format.md section 14.5).
async function emptyFeedDay(dir, start) {
  const tag = `feed-d-${start.slice(0, 10).replaceAll('-', '')}`;
  const at = join(dir, tag);
  mkdirSync(at, { recursive: true });
  const sink = new DirPartsSink(at, 'key');
  const summary = await writePack([], { codec: FEED_CODEC, compress: nodeCompress, sink, recordsPerBlock: 8, pageEntries: 2 });
  await sink.close();
  writeFileSync(join(at, IDX_TITLE), summary.idx);
  const parts = [];
  for (const f of sink.files) parts.push(await fileDigest(f));
  const idx = { digest: `sha256:${createHash('sha256').update(summary.idx).digest('hex')}`, size: summary.idx.length };
  const end = dayIso(Date.parse(start) + 86_400_000);
  const manifest = packManifest({ dataset: 'feed', tier: 'd', span: { start, end }, tag, sources: ['oi-cs', 'thc-ct'], psl: PSL, run: '1', summary, writer: writerId(), parts, idx, time: null });
  return { tag, dir: at, manifest, summary, keys: [], time: null };
}

test('plan cli: a feed week with an input of no time copy marks the time copy to sort, and the ranges and the assembly sort it', () =>
  inTmp(async (dir) => {
    const inDir = join(dir, 'in');
    const inputs = [];
    for (let d = 0; d < 7; d += 1) {
      const start = dayIso(Date.parse(MONDAY) + d * 86_400_000);
      inputs.push(d === 3 ? await emptyFeedDay(inDir, start) : await writeInput(inDir, 'feed', 'd', start, { seed: d }));
    }
    const root = await rootOf('feed', inputs);
    assert.equal(root.datasets.feed.filter((p) => p.time === undefined).length, 1);
    const rootPath = join(dir, 'root.json');
    writeFileSync(rootPath, JSON.stringify(root));
    const planPath = join(dir, 'plan.json');
    const r = await plan([
      '--dataset',
      'feed',
      '--tier',
      'w',
      '--span',
      MONDAY,
      '--root',
      rootPath,
      '--inputs',
      inDir,
      '--ranges',
      '2',
      '--records-per-block',
      '4',
      '--page-entries',
      '2',
      '--out',
      planPath,
    ]);
    assert.equal(r.code, EXIT.ok, r.text);
    assert.match(r.text, /^ranges time 1 sort$/m);
    const ranges = join(dir, 'ranges');
    const x = await call(rangeMain, ['all', '--plan', planPath, '--inputs', inDir, '--out', ranges]);
    assert.equal(x.code, 0, x.text);
    assert.match(x.text, /^time sort: an input carries no time copy; assemble\.mjs sorts the time copy$/m);
    writeFileSync(join(dir, 'tags.json'), '[]');
    const a = await call(assembleMain, ['--plan', planPath, '--dir', ranges, '--out', join(dir, 'asm'), '--tags', join(dir, 'tags.json'), '--run', '7', '--inputs', inDir]);
    assert.equal(a.code, 0, a.text);
    assert.match(a.text, /^check time: sorted, 1 part\(s\), bound to the key copy$/m);
  }));

test('plan cli: --ranges above the ceiling of the pack layers is exit 2; the ceiling is the push tool layer limit', async () => {
  // packages/compact holds its own MAX_LAYERS; the push tool refuses past its own: the two are one number.
  assert.equal(MAX_LAYERS, PUSH_MAX_LAYERS);
  for (const [dataset, ranges, ceiling] of [
    ['names', '256', 255],
    ['feed', '128', 127],
  ]) {
    const r = await plan(['--dataset', dataset, '--tier', 'w', '--span', MONDAY, '--root', 'no-such-root.json', '--ranges', ranges]);
    assert.equal(r.code, EXIT.usage, r.text);
    assert.match(r.text, new RegExp(`--ranges ${ranges} is above ${ceiling}, the most ranges of a ${dataset} pack of tier w whose parts and indexes fit one manifest`));
  }
  // At the ceiling the argument passes, and the root is read next.
  const at = await plan(['--dataset', 'feed', '--tier', 'w', '--span', MONDAY, '--root', 'no-such-root.json', '--ranges', '127']);
  assert.equal(at.code, EXIT.usage, at.text);
  assert.match(at.text, /--root no-such-root\.json does not read/);
});

test('plan cli: an output that cannot be written is exit 2, checked before anything is read', () =>
  inTmp(async (dir) => {
    const reader = {
      getManifest: async () => {
        throw new TypeError('a read before the outputs were checked');
      },
    };
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    const base = ['--dataset', 'names', '--tier', 'w', '--span', MONDAY];
    for (const [more, why] of [
      [['--out', join(dir, 'no', 'such', 'plan.json')], /--out .*plan\.json: its directory .* is not there/],
      [['--matrix', join(dir, 'no', 'm.json')], /--matrix .*m\.json: its directory .* is not there/],
      [['--out', dir], /--out .* is a directory, not a file/],
      [['--matrix', join(file, 'm.json')], /--matrix .*m\.json: .*file is a file, not a directory/],
    ]) {
      const r = await plan([...base, ...more], { reader });
      assert.equal(r.code, EXIT.usage, `${more.join(' ')}\n${r.text}`);
      assert.match(r.text, why);
    }
    // A file the system refuses to write, found only at the write: exit 2 all the same.
    const rootPath = syntheticRoot(dir, [pack('names', 'd', MONDAY, { psl: PSL })]);
    const ro = join(dir, 'read-only.json');
    writeFileSync(ro, '{}');
    chmodSync(ro, 0o444);
    try {
      let refusing = true;
      try {
        writeFileSync(ro, '{}');
        refusing = false;
      } catch {}
      if (refusing) {
        const r = await plan(['--dataset', 'names', '--tier', 'd', '--span', MONDAY, '--root', rootPath, '--out', ro]);
        assert.equal(r.code, EXIT.usage, r.text);
        assert.match(r.text, /plan: --out .*read-only\.json cannot be written: E(PERM|ACCES) /);
      }
    } finally {
      chmodSync(ro, 0o644);
    }
    // The mapping itself: the codes of a path that cannot be written, and no other.
    for (const code of ['ENOENT', 'EEXIST', 'ENOTDIR', 'EISDIR', 'EACCES', 'EPERM', 'EROFS']) {
      assert.throws(
        () =>
          onOutput('p', '--out', () => {
            throw Object.assign(new Error('x'), { code });
          }),
        (e) => e instanceof UsageError && e.message.startsWith(`--out p cannot be written: ${code}`),
        code,
      );
    }
    assert.throws(
      () =>
        onOutput('p', '--out', () => {
          throw Object.assign(new Error('disk'), { code: 'EIO' });
        }),
      (e) => !(e instanceof UsageError) && e.code === 'EIO',
    );
    assert.equal(existsSync(join(dir, 'no')), false);
  }));

test('plan cli: each error class has its exit code: a defect 70, the root not public 4, GHCR unreachable 2, a usage error 2, a fault 1', async () => {
  const cases = [
    [new TypeError('a defect'), EXIT.internal, /^plan: internal error: TypeError: a defect/m],
    [new GhcrError('refused', 'DENIED', 403), EXIT.private, /^PRIVATE PACKAGE$/m],
    [new GhcrError('missing', 'MANIFEST_UNKNOWN', 404), EXIT.private, /plan: the root did not read with no credential: MANIFEST_UNKNOWN/],
    [new GhcrError('unreachable', 'no route to ghcr.io'), EXIT.usage, /^plan: no route to ghcr\.io$/m],
    [new RateLimitError('429 past the cap'), EXIT.usage, /^plan: 429 past the cap$/m],
    [new CompactError('usage', 'a call out of bounds'), EXIT.usage, /^plan: FAIL usage a call out of bounds$/m],
    [new CompactError('straddle', 'a pack across the edge'), EXIT.fault, /^plan: FAIL straddle a pack across the edge$/m],
    [new PackError('crc', 'an index that does not read'), EXIT.fault, /^plan: FAIL crc an index that does not read$/m],
    [new Fault('a root that does not validate'), EXIT.fault, /^plan: FAIL a root that does not validate$/m],
  ];
  for (const [e, code, line] of cases) {
    const reader = {
      getManifest: async () => {
        throw e;
      },
    };
    const r = await plan(['--dataset', 'names', '--tier', 'w', '--span', MONDAY], { reader });
    assert.equal(r.code, code, `${e.name} ${e.message}\n${r.text}`);
    assert.match(r.text, line);
  }
});

test('plan cli: an input index the root names and GHCR does not hold is a fault, exit 1, not PRIVATE PACKAGE', () =>
  inTmp(async (dir) => {
    const w = await week(join(dir, 'in'), 'names', MONDAY);
    const reg = registry();
    try {
      // The root is in GHCR; the packs it names are not.
      const sources = Object.entries(w.root.through).map(([id, through]) => ({ id, through, fetched: null }));
      reg.seedRoot(w.root, { sources: { format: SOURCES_LAYER_FORMAT, sources } });
      const r = await plan(['--dataset', 'names', '--tier', 'w', '--span', MONDAY]);
      assert.equal(r.code, EXIT.fault, r.text);
      assert.ok(!r.out.includes('PRIVATE PACKAGE'), r.text);
      assert.match(
        r.text,
        /plan: FAIL the root names names:names-d-20261019's idx as sha256:[0-9a-f]{64} \(\d+ B\), which GHCR does not give with no credential \(.+\): a pack it names is lost, or its package no longer reads publicly/,
      );
    } finally {
      reg.close();
    }
  }));

test('plan cli: ranges from the input bytes are held to the ceiling, 255 for names and 127 for a pack with a time copy, so the pack fits one manifest', () =>
  inTmp(async (dir) => {
    // Seven day packs of n records, one a block and two a page: more index pages
    // than 256 ranges. The names of the fixture come from 300 keys, which the
    // days share, so names takes more records than feed, whose keys are each day's own.
    for (const [dataset, ceiling, n] of [
      ['names', 255, 280],
      ['feed', 127, 100],
    ]) {
      const inDir = join(dir, dataset);
      const inputs = [];
      for (let d = 0; d < 7; d += 1) inputs.push(await writeInput(inDir, dataset, 'd', dayIso(Date.parse(MONDAY) + d * 86_400_000), { seed: d, n, recordsPerBlock: 1 }));
      const rootPath = join(inDir, 'root.json');
      writeFileSync(rootPath, JSON.stringify(await rootOf(dataset, inputs)));
      const matrix = join(inDir, 'matrix.json');
      const r = await plan(['--dataset', dataset, '--tier', 'w', '--span', MONDAY, '--root', rootPath, '--inputs', inDir, '--target-bytes', '1', '--matrix', matrix]);
      assert.equal(r.code, EXIT.ok, r.text);
      assert.match(r.text, new RegExp(`^ranges key ${ceiling} bytes `, 'm'));
      if (dataset === 'feed') assert.match(r.text, new RegExp(`^ranges time ${ceiling} merge$`, 'm'));
      assert.equal(JSON.parse(readFileSync(matrix, 'utf8')).include.length, ceiling);
    }
  }));
