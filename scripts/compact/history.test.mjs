// Historical feed replay through the plan and build CLI doors with immutable
// root edges and local DPK1 artifacts. Only the registry transport is a double.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dayOf, SUMMARY_TITLE, timeCodecFor } from '@domains/compact';
import { openCopy } from '@domains/compact/node';
import { FEED_CODEC, FEED_SUSPECT, FEED_SUSPECT_CERT, TIME_IDX_TITLE } from '@domains/pack';
import { buildRoot, rollbackRoot } from '@domains/root';
import { BIT, dayNo, domain, entryOf, PSL, REGISTRY, secs, segment, tierPack, writeDir } from '../../packages/compact/test/daily-helpers.ts';
import { pack } from '../../packages/root/test/helpers.ts';
import { registry } from '../root/fixture.mjs';
import { entryOfOutput } from './history-build.mjs';
import { main } from './history.mjs';

const utc = (day) => `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`;
const OLD = { sources: ['oi-nrd'], psl: PSL };
const DEFINITIONS = ['domains', 'feed'];
const read = (path) => JSON.parse(readFileSync(path));
const save = (path, value) => writeFileSync(path, JSON.stringify(value));
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function withUnfetchedRaw(pack) {
  const bytes = Buffer.from('the historical raw bytes are deliberately absent from the local replay archive');
  const raw = { mediaType: 'application/gzip', digest: digest(bytes), size: bytes.length, annotations: { 'org.opencontainers.image.title': 'raw.txt.gz' } };
  const json = { ...pack.json, layers: [...pack.json.layers, raw] };
  const text = JSON.stringify(json);
  return { ...pack, json, text, digest: digest(text) };
}

async function call(argv) {
  const lines = [];
  const code = await main(argv, { out: (l) => lines.push(l), err: (l) => lines.push(l) });
  return { code, text: lines.join('\n') };
}

async function fixture(t, { changedWhilePlanning = false, lastRowOnly = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'compact-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reg = registry();
  t.after(() => reg.close());
  const inputDir = join(dir, 'archive');
  const byDay = [];
  const inventory = [];
  const secondWeekKeys = lastRowOnly ? ['com.moved'] : ['com.moved', 'com.quarantined', 'com.unchanged'];
  for (let i = 2; i <= 15; i += 1) {
    const keys = i === 11 ? secondWeekKeys : [];
    const rows = keys.map((key, index) => ({
      key,
      flags: 0,
      firstSeen: secs(utc(i)) + index + 1,
      sources: [BIT['oi-nrd']],
      basis: 0,
      confidence: 0,
      feedFlags: key === 'com.unchanged' ? FEED_SUSPECT | FEED_SUSPECT_CERT : 0,
    }));
    const domains = await tierPack(
      'domains',
      'd',
      utc(i),
      rows.map((row) => domain(row.key, 'oi-nrd', row.firstSeen)),
      OLD,
    );
    const feed = await tierPack('feed', 'd', utc(i), rows, OLD);
    byDay.push([domains, feed]);
    for (const p of [domains, feed]) {
      writeDir(inputDir, p);
      inventory.push({ dataset: p.dataset, tag: p.tag, digest: p.digest, repo: entryOf(p).pack.repo, annotations: p.json.annotations });
    }
  }
  const old = byDay.flatMap((pair) => pair.map(entryOf));
  const later = pack('feed', 'h', utc(16), OLD);
  const pinned = buildRoot({ live: null, now: utc(17), psl: PSL, add: [...old, later] });
  const pinnedDigest = reg.seedRoot(pinned);
  const w45 = DEFINITIONS.map((ds) => pack(ds, 'w', utc(2), OLD));
  const w46 = DEFINITIONS.map((ds) => pack(ds, 'w', utc(9), { ...OLD, count: secondWeekKeys.length }));
  const one = buildRoot({
    live: { root: pinned, digest: pinnedDigest },
    psl: PSL,
    now: '2026-11-17T01:00:00Z',
    replace: [...w45, ...w46].map((p) => ({
      old: old.filter((r) => r.dataset === p.dataset && r.pack.span.start >= p.pack.span.start && r.pack.span.end <= p.pack.span.end).map((r) => r.pack.manifest),
      new: p,
    })),
  });
  const compactionDigest = reg.seedRoot(one);
  const extras = await Promise.all(
    [
      [3, 'com.moved', false],
      [4, 'com.quarantined', true],
    ].map(async ([value, key, quarantine]) => {
      const day = dayOf(utc(value).slice(0, 10));
      return withUnfetchedRaw(await segment('thc-ct', day.start, day.end, [domain(key, 'thc-ct', dayNo(day.date))], { quarantine }));
    }),
  );
  const current = buildRoot({ live: { root: one, digest: compactionDigest }, now: '2026-11-17T02:00:00Z', psl: PSL, add: extras.map(entryOf) });
  const currentDigest = reg.seedRoot(current);
  for (const item of extras) writeDir(inputDir, item);
  const hints = [{ before: { digest: changedWhilePlanning ? compactionDigest : pinnedDigest }, after: { digest: compactionDigest } }];
  const planDir = join(dir, 'plan');
  const resultDir = join(dir, 'result');
  const inventoryPath = join(dir, 'inventory.json');
  const edgePath = join(dir, 'edges.json');
  const sources = join(dir, 'sources.json');
  save(sources, { sources: REGISTRY });
  save(inventoryPath, inventory);
  save(edgePath, hints);
  return {
    dir,
    reg,
    inputDir,
    planDir,
    resultDir,
    inventory,
    inventoryPath,
    edgePath,
    pinned: { root: pinned, digest: pinnedDigest },
    compacted: { root: one, digest: compactionDigest },
    planArgs: ['plan', '--ref', currentDigest, '--inventory', inventoryPath, '--edges', edgePath, '--from', '2026-11-02', '--to', '2026-11-15', '--out', planDir],
    buildArgs: ['build', '--plan', join(planDir, 'history-plan.json'), '--inputs', inputDir, '--sources', sources, '--run', '1', '--out', resultDir],
  };
}

async function readRows(dir, copy, codec) {
  const opened = await openCopy(dir, copy, codec);
  try {
    const names = [];
    for await (const row of opened.reader.scan()) names.push(row);
    return names;
  } finally {
    await opened.close();
  }
}

test('historical replay binds exact archived days, retracts downstream keys and assembles original spans locally', async (t) => {
  const f = await fixture(t);
  const latest = f.reg.w.manifests.get('root:latest');
  const planned = await call(f.planArgs);
  assert.equal(planned.code, 0, planned.text);
  const { plan } = read(join(f.planDir, 'history-plan.json'));
  assert.equal(Object.keys(plan.evidence).length, 4);
  assert.equal(plan.replay.length, 14);
  assert.deepEqual(
    plan.downstream.map((p) => p.tag),
    ['feed-h-2026111600'],
  );
  assert.deepEqual(
    plan.replay[2].domains.map((p) => p.quarantine ?? null),
    [null, true],
  );
  const archivedSegment = join(f.inputDir, plan.replay[1].domains[1].tag);
  assert.equal(read(join(archivedSegment, 'manifest.json')).layers.at(-1).annotations['org.opencontainers.image.title'], 'raw.txt.gz');
  assert.equal(existsSync(join(archivedSegment, 'raw.txt.gz')), false);
  const built = await call(f.buildArgs);
  assert.equal(built.code, 0, built.text);
  const result = read(join(f.resultDir, 'history-build.json'));
  assert.equal(result.publicationReady, false);
  assert.equal(result.reconciled[9].carry.retracted, 2);
  assert.equal(result.reconciled[9].carry.carried, 1);
  const changes = readFileSync(join(f.resultDir, 'changes.ndjson'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(changes, [
    { date: '2026-11-03', kind: 'added', key: 'com.moved' },
    { date: '2026-11-11', kind: 'removed', key: 'com.moved' },
    { date: '2026-11-11', kind: 'removed', key: 'com.quarantined' },
  ]);
  const domain = result.replacements.find((p) => p.new.tag === 'domains-w-2026w45-r2');
  assert.equal(domain.old.length, 3, 'the week and both live overlay segments are named for replacement');
  for (const [week, key] of [
    [45, 'com.moved'],
    [46, 'com.unchanged'],
  ]) {
    const replacement = result.replacements.find((p) => p.new.tag === `feed-w-2026w${week}-r2`);
    assert.deepEqual(replacement.new.span, replacement.old[0].span);
    assert.ok(replacement.new.sources.includes('oi-nrd'));
    const keyRows = await readRows(replacement.dir, 'key', FEED_CODEC);
    const timeRows = await readRows(replacement.dir, 'time', timeCodecFor('feed', 'w'));
    assert.deepEqual(
      keyRows.map((row) => row.key),
      [key],
    );
    assert.deepEqual(timeRows, keyRows);
  }
  assert.equal(f.reg.w.manifests.get('root:latest'), latest);
  assert.deepEqual(f.reg.calls, []);
});

test('historical replay writes a canonical empty week after retracting its last feed row', async (t) => {
  const f = await fixture(t, { lastRowOnly: true });
  const latest = f.reg.w.manifests.get('root:latest');
  const planned = await call(f.planArgs);
  assert.equal(planned.code, 0, planned.text);
  const built = await call(f.buildArgs);
  assert.equal(built.code, 0, built.text);
  const result = read(join(f.resultDir, 'history-build.json'));
  assert.equal(result.publicationReady, false);
  assert.equal(result.reconciled[9].removed, 1);
  assert.equal(result.reconciled[9].carry.retracted, 1);
  const replacement = result.replacements.find((p) => p.new.tag === 'feed-w-2026w46-r2');
  assert.equal(replacement.old[0].count, 1);
  assert.equal(replacement.new.count, 0);
  assert.deepEqual(replacement.new.span, replacement.old[0].span);
  assert.deepEqual(replacement.new.sources, replacement.old[0].sources);
  assert.deepEqual(await readRows(replacement.dir, 'key', FEED_CODEC), []);
  assert.deepEqual(await readRows(replacement.dir, 'time', timeCodecFor('feed', 'w')), []);
  assert.equal(f.reg.w.manifests.get('root:latest'), latest);
  assert.deepEqual(f.reg.calls, []);
});

test('historical plan refuses an unproved edge and an inventory that names a different original', async (t) => {
  const badEdge = await fixture(t, { changedWhilePlanning: true });
  const edge = await call(badEdge.planArgs);
  assert.equal(edge.code, 1, edge.text);
  assert.match(edge.text, /are not adjacent roots/);

  const wrong = await fixture(t);
  const item = wrong.inventory.find((p) => p.tag === 'feed-d-20261103');
  item.digest = `sha256:${'a'.repeat(64)}`;
  save(wrong.inventoryPath, wrong.inventory);
  const missing = await call(wrong.planArgs);
  assert.equal(missing.code, 1, missing.text);
  assert.match(missing.text, /feed-d-20261103.*no matching archive inventory entry/);
});

test('historical plan distinguishes original compaction from a rollback that restores the same weeks over rebuilt days', async (t) => {
  const f = await fixture(t);
  const restoreDays = rollbackRoot({ live: f.compacted, target: f.pinned.root, between: [], psl: PSL, now: '2026-11-17T02:10:00Z' });
  const restoreDigest = f.reg.seedRoot(restoreDays);
  const revision = pack('feed', 'd', utc(3), { ...OLD, rebuild: 2 });
  const original = restoreDays.datasets.feed.find((p) => p.tag === 'feed-d-20261103');
  const revised = buildRoot({
    live: { root: restoreDays, digest: restoreDigest },
    psl: PSL,
    now: '2026-11-17T02:20:00Z',
    replace: [{ old: [original.manifest], new: revision }],
  });
  const revisedDigest = f.reg.seedRoot(revised);
  f.inventory.push({
    dataset: 'feed',
    tag: revision.pack.tag,
    digest: revision.pack.manifest,
    repo: revision.pack.repo,
    annotations: { 'dev.pkgforge.domains.span.start': revision.pack.span.start, 'dev.pkgforge.domains.span.end': revision.pack.span.end },
  });
  save(f.inventoryPath, f.inventory);
  const planAt = (digest, out) => {
    const args = [...f.planArgs];
    args[args.indexOf('--ref') + 1] = digest;
    args[args.indexOf('--out') + 1] = join(f.dir, out);
    return call(args);
  };
  for (const [i, [now, reason]] of [
    ['2026-11-17T02:30:00Z', /changes withdrawals like a rollback/],
    ['2026-12-20T02:30:00Z', /beyond the 31-day withdrawal window.*ambiguous/],
  ].entries()) {
    const restored = rollbackRoot({ live: { root: revised, digest: revisedDigest }, target: f.compacted.root, between: [restoreDays], psl: PSL, now });
    const after = f.reg.seedRoot(restored);
    assert.ok(restored.datasets.feed.some((p) => p.manifest === f.compacted.root.datasets.feed[0].manifest));
    assert.equal(
      restored.withdrawn.some((p) => p.manifest === revision.pack.manifest),
      i === 0,
    );
    save(f.edgePath, [{ before: { digest: revisedDigest }, after: { digest: after } }]);
    const ambiguous = await planAt(after, `bad-${i}`);
    assert.equal(ambiguous.code, 1, ambiguous.text);
    assert.match(ambiguous.text, reason);

    save(f.edgePath, [{ before: { digest: f.pinned.digest }, after: { digest: f.compacted.digest } }]);
    const proved = await planAt(after, `good-${i}`);
    assert.equal(proved.code, 0, proved.text);
    const { plan } = read(join(f.dir, `good-${i}`, 'history-plan.json'));
    assert.equal(plan.replay[1].carry.manifest, original.manifest);
  }
});

test('historical plan follows legitimate week and month compactions to their canonical days', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-history-nested-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reg = registry();
  t.after(() => reg.close());
  const daily = DEFINITIONS.flatMap((dataset) => Array.from({ length: 30 }, (_, i) => pack(dataset, 'd', utc(i + 1), OLD)));
  const originals = buildRoot({ live: null, psl: PSL, now: '2026-12-01T00:00:00Z', add: daily });
  const originalDigest = reg.seedRoot(originals);
  const weeks = DEFINITIONS.map((dataset) => pack(dataset, 'w', utc(2), OLD));
  const withWeeks = buildRoot({
    live: { root: originals, digest: originalDigest },
    psl: PSL,
    now: '2026-12-01T00:01:00Z',
    replace: weeks.map((week) => ({
      old: originals.datasets[week.dataset].filter((p) => p.span.start >= week.pack.span.start && p.span.end <= week.pack.span.end).map((p) => p.manifest),
      new: week,
    })),
  });
  const weekDigest = reg.seedRoot(withWeeks);
  const withMonths = buildRoot({
    live: { root: withWeeks, digest: weekDigest },
    psl: PSL,
    now: '2026-12-01T00:02:00Z',
    replace: DEFINITIONS.map((dataset) => ({ old: withWeeks.datasets[dataset].map((p) => p.manifest), new: pack(dataset, 'm', utc(1), OLD) })),
  });
  const monthDigest = reg.seedRoot(withMonths);
  const inventory = join(dir, 'inventory.json');
  const edges = join(dir, 'edges.json');
  save(
    inventory,
    daily.map(({ dataset, pack: p }) => ({
      dataset,
      tag: p.tag,
      digest: p.manifest,
      repo: p.repo,
      annotations: { 'dev.pkgforge.domains.span.start': p.span.start, 'dev.pkgforge.domains.span.end': p.span.end },
    })),
  );
  save(edges, [
    { before: { digest: originalDigest }, after: { digest: weekDigest } },
    { before: { digest: weekDigest }, after: { digest: monthDigest } },
  ]);
  const output = join(dir, 'plan');
  const result = await call(['plan', '--ref', monthDigest, '--inventory', inventory, '--edges', edges, '--from', '2026-11-01', '--to', '2026-11-30', '--out', output]);
  assert.equal(result.code, 0, result.text);
  const { plan } = read(join(output, 'history-plan.json'));
  assert.equal(plan.replay.length, 30);
  assert.equal(Object.keys(plan.evidence).length, 4);
  assert.deepEqual(
    plan.targets.map((t) => t.pack.tag),
    ['domains-m-202611', 'feed-m-202611'],
  );
  assert.equal(plan.replay[2].carry.manifest, originals.datasets.feed[2].manifest);
});

test('historical build refuses a tampered archive blob', async (t) => {
  const f = await fixture(t);
  const planned = await call(f.planArgs);
  assert.equal(planned.code, 0, planned.text);
  const target = join(f.inputDir, 'domains-d-20261103', 'idx');
  const index = readFileSync(target);
  index[index.length - 1] ^= 1;
  writeFileSync(target, index);
  const built = await call(f.buildArgs);
  assert.equal(built.code, 1, built.text);
  assert.match(built.text, /domains-d-20261103: archive layer idx does not match its manifest/);
});

test('history omits an equivalent span but keeps same-record summary, time-copy and late-input replacements', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'compact-history-equivalence-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const reg = registry();
  t.after(() => reg.close());
  const day = dayOf('2026-11-03');
  const tags = { domains: day.domainsTag, feed: day.feedTag };
  const edges = join(dir, 'edges.json');
  const sources = join(dir, 'sources.json');
  save(edges, []);
  save(sources, { sources: REGISTRY });

  async function rebuild(archive, label, extra = []) {
    const entries = DEFINITIONS.map((dataset) => entryOfOutput(join(archive, tags[dataset]), dataset, tags[dataset]));
    const root = reg.seedRoot(buildRoot({ live: null, psl: PSL, now: utc(5), add: [...entries, ...extra] }));
    const inventory = join(dir, `${label}-inventory.json`);
    save(
      inventory,
      entries.map(({ dataset, pack }) => ({ dataset, tag: pack.tag, digest: pack.manifest, repo: pack.repo, annotations: read(join(archive, pack.tag, 'manifest.json')).annotations })),
    );
    const planDir = join(dir, `${label}-plan`);
    const planned = await call(['plan', '--ref', root, '--inventory', inventory, '--edges', edges, '--from', day.date, '--to', day.date, '--out', planDir]);
    assert.equal(planned.code, 0, planned.text);
    const output = join(dir, `${label}-build`);
    const built = await call(['build', '--plan', join(planDir, 'history-plan.json'), '--inputs', archive, '--out', output, '--sources', sources, '--run', label === 'seed' ? '10' : '11']);
    assert.equal(built.code, 0, built.text);
    return { output, report: read(join(output, 'history-build.json')) };
  }

  const seedArchive = join(dir, 'seed-archive');
  for (const dataset of DEFINITIONS) writeDir(seedArchive, await tierPack(dataset, 'd', day.start, [], OLD));
  const seed = await rebuild(seedArchive, 'seed');
  const ready = (label, alter) => {
    const archive = join(dir, `${label}-archive`);
    for (const dataset of DEFINITIONS) {
      const from = join(seed.output, 'days', tags[dataset]);
      const to = join(archive, tags[dataset]);
      mkdirSync(to, { recursive: true });
      for (const name of readdirSync(from)) copyFileSync(join(from, name), join(to, name));
      if (alter !== undefined && dataset === 'feed') {
        const file = join(to, 'manifest.json');
        const manifest = read(file);
        const changed = manifest.layers.find((p) => p.annotations['org.opencontainers.image.title'] === alter);
        assert.ok(changed, alter);
        changed.digest = digest(`stale ${alter}`);
        save(file, manifest);
      }
    }
    return archive;
  };

  const unchanged = await rebuild(ready('same'), 'same');
  assert.deepEqual(unchanged.report.replacements, []);
  for (const title of [SUMMARY_TITLE, TIME_IDX_TITLE]) {
    const result = await rebuild(ready(title, title), title);
    assert.equal(result.report.publicationReady, false);
    assert.deepEqual(
      result.report.replacements.map((p) => p.dataset),
      ['feed'],
    );
    const [replacement] = result.report.replacements;
    assert.equal(replacement.new.pack.sha256, replacement.old[0].pack.sha256, 'record identity is unchanged');
    assert.deepEqual(replacement.new.sources, replacement.old[0].sources);
  }

  const archive = ready('late');
  const late = await segment('thc-ct', day.start, day.end, [], { quarantine: true });
  writeDir(archive, late);
  const result = await rebuild(archive, 'late', [entryOf(late)]);
  const replacement = result.report.replacements.find((p) => p.dataset === 'domains');
  assert.ok(replacement, 'the empty late input still needs a domains replacement');
  assert.equal(replacement.new.pack.sha256, replacement.old[0].pack.sha256);
  assert.equal(replacement.old[1].manifest, late.digest);
  assert.equal(result.report.publicationReady, false);
});

test('history rejects repeated flags before reading any files or roots', async () => {
  const plan = await call([
    'plan',
    '--ref',
    'latest',
    '--inventory',
    'absent-inventory.json',
    '--edges',
    'absent-edges.json',
    '--from',
    '2026-11-02',
    '--to',
    '2026-11-15',
    '--out',
    'unused',
    '--ref=other',
  ]);
  assert.equal(plan.code, 2, plan.text);
  assert.match(plan.text, /--ref is given twice/);
  const built = await call(['build', '--plan', 'absent-plan.json', '--inputs', 'one', '--out', 'unused', '--inputs', 'two']);
  assert.equal(built.code, 2, built.text);
  assert.match(built.text, /--inputs is given twice/);
});
