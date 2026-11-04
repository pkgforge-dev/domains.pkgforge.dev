// scripts/ingest/thc-plan.mjs (DOM-029, design D19, D22 and section 6.3):
// the plan of a backfill of THC's dumps, in process, against the GHCR double
// of scripts/root/fixture.mjs (the state, the root, the tags and manifests of
// obs, the lists of ref) and the hosts' answers through --recordings: THC's
// own listing and index of 2026-11-02T04:29Z (adapters/thc-ct/fixtures/recorded/,
// recorded by adapters/thc-ct/record.mjs), or synthetic ones written here.
// The root's packs are synthetic (packages/root/test/helpers.ts).
//
//   node scripts/test.mjs scripts/ingest --name thc-plan
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { base64Of, checkBand, RECORDING_FORMAT } from '@domains/adapter';
import { artifactType, fileTag, refTag } from '@domains/ghcr';
import { buildRoot, sourcesLayer, TIER_ANNOTATION } from '@domains/root';
import { advance, emptyState, encodeState, parseProposal, parseState } from '@domains/state';
import { HOSTS } from '../../adapters/thc-ct/src/index.ts';
import { hours, pack } from '../../packages/root/test/helpers.ts';
import { ROOT } from '../files.mjs';
import { DEFAULT_SOURCES, loadRegistry } from '../verify-pack.mjs';
import { call, inRegistry, PSL, seedList } from './fixture.mjs';
import { EXIT, MAX_DAYS, main, PLAN_FORMAT } from './thc-plan.mjs';

const RECORDED = join(ROOT, 'adapters', 'thc-ct', 'fixtures', 'recorded');
const REGISTRY = loadRegistry(DEFAULT_SOURCES);
const BAND = REGISTRY.find((r) => r.id === 'thc-ct').band;
const RUN = '41000000077';
const CURSOR = { next: '2026-11-01', open: [] };
const STATE = { ...emptyState('2026-11-01T01:00:00Z'), cursors: { 'thc-ct': CURSOR }, moved: { 'thc-ct': { at: '2026-11-01T01:00:00Z', run: '41000000001' } } };
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const next = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
const posix = (p) => p.replaceAll('\\', '/');
// A list other than the root's: a stand-in whose bytes hash to it (pslFile holds a list to its hash alone).
const listOf = (text) => ({ bytes: new TextEncoder().encode(text), sha: sha256(text) });
const OTHER = listOf('// synthetic list one\n');
const OTHER2 = listOf('// synthetic list two\n');

// The root (with the real registry's sources layer), state:latest, the lists and the segments of obs.
function seedWorld(reg, { state = STATE, add = [], gaps = {}, lists = [], segments = [] } = {}) {
  seedList(reg);
  for (const l of lists)
    reg.seed('ref', refTag('psl', l.sha), artifactType('ref'), { 'dev.pkgforge.domains.sha256': l.sha }, [{ title: 'public_suffix_list.dat', bytes: l.bytes, mediaType: 'text/plain' }]);
  const root = buildRoot({ live: null, psl: PSL, now: '2026-11-01T00:00:00Z', add, gaps });
  reg.seedRoot(root, { sources: sourcesLayer({ registry: REGISTRY, root }) });
  if (state !== null) reg.seed('state', 'latest', artifactType('state'), {}, [{ title: 'state.json', bytes: encodeState(state) }]);
  const digests = new Map();
  for (const s of segments) digests.set(tagOf(s.day, s.file, s.dataset), seedSegment(reg, s));
  return { root, digests };
}

// A thc-ct segment of `day` in obs: its manifest (the annotations adopt.mjs and
// the plan read) and its layers, the file as `raw`.
function seedSegment(reg, { day, dataset, file, psl = PSL, quarantine = false }) {
  const tag = fileTag('thc-ct', day, file.sha, dataset === 'domains' ? 'd' : undefined);
  const annotations = {
    'dev.pkgforge.domains.dataset': dataset,
    'dev.pkgforge.domains.count': '3',
    [TIER_ANNOTATION]: 'seg',
    'dev.pkgforge.domains.span.start': `${day}T00:00:00Z`,
    'dev.pkgforge.domains.span.end': `${next(day)}T00:00:00Z`,
    'dev.pkgforge.domains.source': 'thc-ct',
    'dev.pkgforge.domains.precision': 'day',
    'dev.pkgforge.domains.psl': psl,
    ...(quarantine ? { 'dev.pkgforge.domains.quarantine': '1' } : {}),
  };
  const layers = [
    { title: 'part.000', bytes: new TextEncoder().encode(`part ${tag}`) },
    { title: 'idx', bytes: new TextEncoder().encode(`idx ${tag}`) },
    { title: 'raw', bytes: file.bytes },
  ];
  return reg.seed('obs', tag, artifactType('segment'), annotations, layers);
}

const fileOf = (day, n) => {
  const bytes = new Uint8Array(n).fill(day.charCodeAt(9));
  return { bytes, sha: sha256(bytes), size: n };
};
const tagOf = (day, file, dataset) => fileTag('thc-ct', day, file.sha, dataset === 'domains' ? 'd' : undefined);
// A root entry of a thc-ct segment of `day` under its file tag.
function segEntry(dataset, day, file) {
  const p = pack(dataset, 'seg', `${day}T00:00:00Z`, { end: `${next(day)}T00:00:00Z`, sources: ['thc-ct'], salt: dataset });
  return { dataset, pack: { ...p.pack, tag: tagOf(day, file, dataset) } };
}

// The hosts' answers, synthetic, in DIR/hosts: the bucket's listing (one page)
// and, when given, cs2's index page.
function hosts(tmp, { listing = [], index = null, status = 200, body = null } = {}) {
  const dir = join(tmp, 'hosts');
  mkdirSync(dir, { recursive: true });
  const write = (name, url, s, type, text) =>
    writeFileSync(
      join(dir, `${name}.http.json`),
      JSON.stringify({
        format: RECORDING_FORMAT,
        origin: 'synthetic',
        request: { method: 'GET', url },
        response: { status: s, headers: { 'content-type': type }, body_base64: base64Of(new TextEncoder().encode(text)) },
      }),
    );
  const entries = listing.map(({ day, size, month }) => ({ type: 'file', path: `2026/${month ?? Number(day.slice(5, 7))}/${day}.txt.gz`, size, mtime: `${next(day)}T00:05:02.000Z` }));
  write('listing', HOSTS.listing, status, 'application/json', body ?? JSON.stringify(entries));
  if (index !== null) {
    const lines = index.map(({ day, bytes }) => `<a href="${day}.txt.gz">${day}.txt.gz</a>                                  ${next(day).slice(8, 10)}-Nov-2026 00:05           ${bytes}`);
    write('index', HOSTS.cs2, 200, 'text/html', `<html>\n<body>\n<pre><a href="../">../</a>\n${lines.join('\n')}\n</pre>\n</body>\n</html>\n`);
  }
  return dir;
}

const plan = (reg, tmp, { from, to, now, recordings, out = join(tmp, 'plan'), more = [] }) =>
  call(main, ['--from', from, '--to', to, '--out', out, '--recordings', recordings, '--now', now, '--run', RUN, ...more], { reg, now });
const lines = (r, prefix) => r.out.filter((l) => l.startsWith(prefix));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

test("thc-plan: over THC's recorded listing and index, the window 2026-09-01 to 2026-10-31 is 59 run legs under the root's list and the gap proposals of 10-04 and 10-09, and the band quarantines 10-05, 10-06 and 10-15 (design M12)", () =>
  inRegistry(async (reg, tmp) => {
    seedWorld(reg);
    const r = await plan(reg, tmp, { from: '2026-09-01', to: '2026-10-31', now: '2026-11-02T04:30:00Z', recordings: RECORDED });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.match(r.out[0], /^state state:latest sha256:[0-9a-f]{64} cursor \{"next":"2026-11-01","open":\[\]\}$/);
    assert.match(r.out[1], new RegExp(`^root root:latest sha256:[0-9a-f]{64} root_seq 1 psl ${PSL}$`));
    assert.ok(r.out.includes('listing 60 day files'), r.text);
    // cs2's index is read for 10-04, the first day the listing lacks.
    assert.ok(r.out.includes('index 30 day files'), r.text);
    assert.ok(r.out.includes('tags 0 thc-ct tags of the window'), r.text);
    const days = lines(r, 'day ');
    assert.equal(days.length, 61);
    assert.deepEqual(
      days.filter((l) => !/ run \d+ hf ok psl /.test(l)),
      [
        'day 2026-10-04 gap',
        `day 2026-10-05 run 168001883 hf quarantine psl ${PSL.slice(0, 12)}`,
        `day 2026-10-06 run 294318949 hf quarantine psl ${PSL.slice(0, 12)}`,
        'day 2026-10-09 gap',
        `day 2026-10-15 run 76999576 hf quarantine psl ${PSL.slice(0, 12)}`,
      ],
    );
    assert.ok(
      days.some((l) => /^day 2026-10-07 run \d+ hf ok /.test(l)),
      'the step change accepts 10-07',
    );
    assert.equal(r.out.at(-1), 'legs 59 adopted 0 gaps 2');
    assert.equal(r.out.at(-2), `psl ${PSL} ref:${refTag('psl', PSL)}`);

    const out = join(tmp, 'plan');
    assert.deepEqual(readdirSync(out).sort(), ['matrix.json', 'plan.json', 'proposals', `psl-${PSL.slice(0, 12)}.dat`, 'state.json']);
    const matrix = readJson(join(out, 'matrix.json'));
    assert.equal(matrix.include.length, 59);
    assert.ok(matrix.include.every((l) => l.psl === PSL.slice(0, 12)));
    assert.deepEqual(matrix.include[0], { day: '2026-09-01', psl: PSL.slice(0, 12) });
    assert.ok(!matrix.include.some((l) => l.day === '2026-10-04' || l.day === '2026-10-09'));
    assert.equal(sha256(readFileSync(join(out, `psl-${PSL.slice(0, 12)}.dat`))), PSL);
    const p = readJson(join(out, 'plan.json'));
    assert.deepEqual([p.format, p.from, p.to, p.now, p.days.length], [PLAN_FORMAT, '2026-09-01', '2026-10-31', '2026-11-02T04:30:00Z', 61]);
    assert.deepEqual(
      p.days.find((d) => d.day === '2026-10-31'),
      {
        day: '2026-10-31',
        action: 'run',
        bytes: 324537041,
        host: 'hf',
        verdict: 'ok',
        path: '2026/11/2026-10-31.txt.gz',
        psl: PSL,
        tags: [],
      },
    );
    assert.deepEqual(
      p.days.find((d) => d.day === '2026-10-04'),
      { day: '2026-10-04', action: 'gap', bytes: null, host: null, verdict: null, path: null, psl: null, tags: [] },
    );

    // The gap days are proposals of the plan's own, the live cursor kept.
    assert.deepEqual(readdirSync(join(out, 'proposals')).sort(), ['proposal.thc-ct.20261004.json', 'proposal.thc-ct.20261009.json']);
    const gap = parseProposal(readFileSync(join(out, 'proposals', 'proposal.thc-ct.20261004.json')));
    assert.deepEqual([gap.adapter, gap.run, gap.before, gap.after, gap.segments, gap.history, gap.gaps], ['thc-ct', RUN, CURSOR, CURSOR, [], [], [{ source: 'thc-ct', day: '2026-10-04' }]]);

    // The legs' state: the live state, with the 59 replayed days as thc-ct's history.
    const state = parseState(readFileSync(join(out, 'state.json')));
    assert.deepEqual(state.cursors, STATE.cursors);
    const history = state.history['thc-ct'];
    assert.equal(history.length, 59);
    assert.deepEqual(
      history.filter((h) => h.quarantined).map((h) => h.day),
      ['2026-10-05', '2026-10-06', '2026-10-15'],
    );
    // Each leg checks its day against the days before it (D14 of DOM-029): the verdict the plan printed.
    for (const d of p.days.filter((x) => x.action === 'run')) {
      const v = checkBand(
        d.bytes,
        history.filter((h) => h.day < d.day),
        BAND,
        { precision: 'day' },
      ).verdict;
      assert.equal(v, d.verdict, d.day);
    }
  }));

test("thc-plan: each action and each list: present by the root's segment, by a day pack that took thc-ct, by what state owes and by the root's gaps; adopt of a pair nobody holds; run under an existing tag's list, under the root's, and from cs2's index", () =>
  inRegistry(async (reg, tmp) => {
    const f = Object.fromEntries(['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'].map((d, i) => [d, fileOf(d, 1000 + i)]));
    const segs = (day, extra = {}) => ['names', 'domains'].map((dataset) => ({ day, dataset, file: f[day], ...extra }));
    const owed = (day) =>
      ['names', 'domains'].map((dataset) => ({
        ref: `obs:${tagOf(day, f[day], dataset)}`,
        digest: `sha256:${'0'.repeat(64)}`,
        dataset,
        tier: 'seg',
        start: `${day}T00:00:00Z`,
        end: `${next(day)}T00:00:00Z`,
        since: '2026-10-28T00:00:00Z',
      }));
    const state = { ...STATE, owed: owed('2026-10-22'), history: { 'thc-ct': [{ day: '2026-10-21', count: 777, quarantined: true }] } };
    const add = [
      segEntry('names', '2026-10-20', f['2026-10-20']),
      segEntry('domains', '2026-10-20', f['2026-10-20']),
      pack('names', 'd', '2026-10-21T00:00:00Z', { sources: ['oi-nrd', 'thc-ct'] }),
      pack('domains', 'd', '2026-10-21T00:00:00Z', { sources: ['oi-nrd', 'thc-ct'] }),
    ];
    const { digests } = seedWorld(reg, {
      state,
      add,
      gaps: { 'thc-ct': ['2026-10-27'] },
      lists: [OTHER],
      segments: [
        ...segs('2026-10-20'),
        ...segs('2026-10-21'),
        ...segs('2026-10-22'),
        ...segs('2026-10-23', { quarantine: true }),
        { day: '2026-10-24', dataset: 'names', file: f['2026-10-24'], psl: OTHER.sha },
      ],
    });
    const listing = ['2026-10-20', '2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25'].map((day) => ({ day, size: 300_000_000 }));
    const recordings = hosts(tmp, { listing, index: [{ day: '2026-10-26', bytes: 310_000_000 }] });
    const r = await plan(reg, tmp, { from: '2026-10-20', to: '2026-10-27', now: '2026-10-29T13:00:00Z', recordings });
    assert.equal(r.code, EXIT.ok, r.text);
    const t = (day, dataset) => tagOf(day, f[day], dataset);
    assert.deepEqual(lines(r, 'day '), [
      `day 2026-10-20 present names obs:${t('2026-10-20', 'names')} (root_seq 1), domains obs:${t('2026-10-20', 'domains')} (root_seq 1)`,
      'day 2026-10-21 present names names:names-d-20261021 (root_seq 1), domains names:domains-d-20261021 (root_seq 1)',
      `day 2026-10-22 present names obs:${t('2026-10-22', 'names')} (owed by state), domains obs:${t('2026-10-22', 'domains')} (owed by state)`,
      `day 2026-10-23 adopt ${t('2026-10-23', 'names')} ${t('2026-10-23', 'domains')}`,
      `day 2026-10-24 run 300000000 hf ok psl ${OTHER.sha.slice(0, 12)}`,
      `day 2026-10-25 run 300000000 hf ok psl ${PSL.slice(0, 12)}`,
      `day 2026-10-26 run 310000000 cs2 ok psl ${PSL.slice(0, 12)}`,
      'day 2026-10-27 present root_seq 1 lists the day in gaps.thc-ct, and no host lists a file',
    ]);
    assert.equal(r.out.at(-1), 'legs 3 adopted 1 gaps 0');
    const out = join(tmp, 'plan');
    assert.deepEqual(readJson(join(out, 'matrix.json')).include, [
      { day: '2026-10-24', psl: OTHER.sha.slice(0, 12) },
      { day: '2026-10-25', psl: PSL.slice(0, 12) },
      { day: '2026-10-26', psl: PSL.slice(0, 12) },
    ]);
    for (const l of [OTHER.sha, PSL]) assert.ok(existsSync(join(out, `psl-${l.slice(0, 12)}.dat`)), l);
    const days = readJson(join(out, 'plan.json')).days;
    assert.deepEqual(days.find((d) => d.day === '2026-10-24').tags, [t('2026-10-24', 'names')]);
    assert.deepEqual(days.find((d) => d.day === '2026-10-26').path, null);
    // The adopted pair: its proposal names both segments by the digest GHCR holds, marked, with its raw file's size.
    assert.deepEqual(readdirSync(join(out, 'proposals')), ['proposal.thc-ct.20261023.json']);
    const adopt = parseProposal(readFileSync(join(out, 'proposals', 'proposal.thc-ct.20261023.json')));
    assert.deepEqual(
      adopt.segments.map((s) => [s.ref, s.digest, s.quarantined]),
      ['names', 'domains'].map((ds) => [`obs:${t('2026-10-23', ds)}`, digests.get(t('2026-10-23', ds)), true]),
    );
    assert.deepEqual(adopt.history, [{ source: 'thc-ct', day: '2026-10-23', count: 1003, quarantined: true }]);
    assert.deepEqual([adopt.before, adopt.after], [CURSOR, CURSOR]);
    // The adopted day's own mark and size reach the legs' history; a day held by the root its listed size.
    const history = parseState(readFileSync(join(out, 'state.json'))).history['thc-ct'];
    assert.deepEqual(
      history.find((h) => h.day === '2026-10-23'),
      { day: '2026-10-23', count: 1003, quarantined: true },
    );
    assert.deepEqual(
      history.find((h) => h.day === '2026-10-20'),
      { day: '2026-10-20', count: 300_000_000, quarantined: false },
    );
    // A present day's stored item wins over its listed size.
    assert.deepEqual(
      history.find((h) => h.day === '2026-10-21'),
      { day: '2026-10-21', count: 777, quarantined: true },
    );
    // advance takes the adopted proposal against the tags GHCR holds.
    const a = advance(state, [adopt], (ref) => digests.get(ref.slice(4)) ?? null, { now: '2026-10-29T13:00:00Z', run: RUN });
    assert.deepEqual(a.dropped, []);
  }));

test("thc-plan: a day with no tag takes the one list of its live domains packs (D19), the root's when they hold two, and a run day is replayed as its leg checks it, whatever state stored for it", () =>
  inRegistry(async (reg, tmp) => {
    const add = [
      ...hours('domains', '2026-10-25', { sources: ['oi-nrd'], psl: OTHER2.sha }),
      ...hours('domains', '2026-10-26', { sources: ['oi-nrd'], psl: OTHER2.sha }).map((h, i) => (i === 5 ? { ...h, pack: { ...h.pack, psl: OTHER.sha } } : h)),
    ];
    const state = { ...STATE, history: { 'thc-ct': [{ day: '2026-10-25', count: 123, quarantined: true }] } };
    seedWorld(reg, { state, add, lists: [OTHER, OTHER2] });
    const recordings = hosts(tmp, {
      listing: [
        { day: '2026-10-25', size: 300_000_000 },
        { day: '2026-10-26', size: 300_000_000 },
      ],
    });
    const r = await plan(reg, tmp, { from: '2026-10-25', to: '2026-10-26', now: '2026-10-29T13:00:00Z', recordings });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(lines(r, 'day '), [`day 2026-10-25 run 300000000 hf ok psl ${OTHER2.sha.slice(0, 12)}`, `day 2026-10-26 run 300000000 hf ok psl ${PSL.slice(0, 12)}`]);
    assert.deepEqual(parseState(readFileSync(join(tmp, 'plan', 'state.json'))).history['thc-ct'], [
      { day: '2026-10-25', count: 300_000_000, quarantined: false },
      { day: '2026-10-26', count: 300_000_000, quarantined: false },
    ]);
    assert.ok(!r.out.some((l) => l.startsWith('index ')), 'every day is listed: cs2 is not read');
  }));

test('thc-plan: a day is held per dataset and only by a pack that carries thc-ct: a pair with only its names segment owed is adopted whole, a day pack of oi-nrd alone holds nothing, and a gap state holds pending is present', () =>
  inRegistry(async (reg, tmp) => {
    const f = fileOf('2026-10-24', 2000);
    const owedNames = {
      ref: `obs:${tagOf('2026-10-24', f, 'names')}`,
      digest: `sha256:${'0'.repeat(64)}`,
      dataset: 'names',
      tier: 'seg',
      start: '2026-10-24T00:00:00Z',
      end: '2026-10-25T00:00:00Z',
      since: '2026-10-28T00:00:00Z',
    };
    const state = { ...STATE, owed: [owedNames], gaps: { 'thc-ct': ['2026-10-26'] } };
    const add = [pack('names', 'd', '2026-10-25T00:00:00Z', { sources: ['oi-nrd'], psl: OTHER.sha }), pack('domains', 'd', '2026-10-25T00:00:00Z', { sources: ['oi-nrd'], psl: OTHER.sha })];
    seedWorld(reg, {
      state,
      add,
      lists: [OTHER],
      segments: [
        { day: '2026-10-24', dataset: 'names', file: f },
        { day: '2026-10-24', dataset: 'domains', file: f },
      ],
    });
    const recordings = hosts(tmp, {
      listing: [
        { day: '2026-10-24', size: 300_000_000 },
        { day: '2026-10-25', size: 300_000_000 },
      ],
      index: [],
    });
    const r = await plan(reg, tmp, { from: '2026-10-24', to: '2026-10-26', now: '2026-10-29T13:00:00Z', recordings });
    assert.equal(r.code, EXIT.ok, r.text);
    // The adopted day's own item, its 2,000 B file, is the baseline: 300 MB is above 4 times it.
    assert.deepEqual(lines(r, 'day '), [
      `day 2026-10-24 adopt ${tagOf('2026-10-24', f, 'names')} ${tagOf('2026-10-24', f, 'domains')}`,
      `day 2026-10-25 run 300000000 hf quarantine psl ${OTHER.sha.slice(0, 12)}`,
      'day 2026-10-26 present state holds the day pending in gaps.thc-ct, and no host lists a file',
    ]);
    assert.equal(r.out.at(-1), 'legs 1 adopted 1 gaps 0');
    // 62 days is the longest window: 2026-08-31 to 2026-10-31 passes the usage checks.
    const longest = await plan(reg, tmp, { from: '2026-08-31', to: '2026-10-31', now: '2026-11-02T13:00:00Z', recordings, out: join(tmp, 'longest') });
    assert.notEqual(longest.code, EXIT.usage, longest.text);
  }));

test('thc-plan: a day no host lists is refused before its gap instant and a gap from it, to the second; a refusal writes nothing and exits 1', () =>
  inRegistry(async (reg, tmp) => {
    seedWorld(reg);
    const recordings = hosts(tmp, { listing: [{ day: '2026-10-30', size: 300_000_000 }], index: [] });
    // 2026-10-31 becomes a gap at 2026-11-02T12:00:00Z.
    const early = await plan(reg, tmp, { from: '2026-10-30', to: '2026-10-31', now: '2026-11-02T11:59:59Z', recordings, out: join(tmp, 'early') });
    assert.equal(early.code, EXIT.fault, early.text);
    assert.deepEqual(lines(early, 'day '), [
      `day 2026-10-30 run 300000000 hf ok psl ${PSL.slice(0, 12)}`,
      'day 2026-10-31 unpublished no host lists the file, and the day becomes a gap only at 2026-11-02T12:00:00Z: --to names a day not published yet',
    ]);
    assert.match(early.text, /thc-plan: 1 day\(s\) refused \(2026-10-31\); nothing is written, and no leg runs/);
    assert.deepEqual(readdirSync(join(tmp, 'early')), [], 'nothing is written');
    const at = await plan(reg, tmp, { from: '2026-10-30', to: '2026-10-31', now: '2026-11-02T12:00:00Z', recordings, out: join(tmp, 'at') });
    assert.equal(at.code, EXIT.ok, at.text);
    assert.ok(at.out.includes('day 2026-10-31 gap'), at.text);
    assert.equal(at.out.at(-1), 'legs 1 adopted 0 gaps 1');
  }));

test('thc-plan: tags of two files nobody holds, and one tag of a pair whose file no host lists, are refused (exit 1) naming the tags', () =>
  inRegistry(async (reg, tmp) => {
    const a = fileOf('2026-10-20', 10);
    const b = fileOf('2026-10-20', 11);
    const c = fileOf('2026-10-21', 12);
    seedWorld(reg, {
      segments: [
        { day: '2026-10-20', dataset: 'names', file: a },
        { day: '2026-10-20', dataset: 'domains', file: a },
        { day: '2026-10-20', dataset: 'names', file: b },
        { day: '2026-10-20', dataset: 'domains', file: b },
        { day: '2026-10-21', dataset: 'domains', file: c },
      ],
    });
    const recordings = hosts(tmp, { listing: [{ day: '2026-10-20', size: 300_000_000 }], index: [] });
    const r = await plan(reg, tmp, { from: '2026-10-20', to: '2026-10-21', now: '2026-10-29T13:00:00Z', recordings });
    assert.equal(r.code, EXIT.fault, r.text);
    const [two, partial] = lines(r, 'day ');
    assert.match(two, new RegExp(`^day 2026-10-20 two-files its tags name 2 files \\(.*${tagOf('2026-10-20', a, 'names')}.*\\), and neither the root nor state holds the day`));
    assert.equal(partial, `day 2026-10-21 partial obs holds ${tagOf('2026-10-21', c, 'domains')} alone, and no host lists the file to build the other segment`);
    assert.deepEqual(readdirSync(join(tmp, 'plan')), []);
  }));

test('thc-plan: a usage error is exit 2 before anything is read', () =>
  inRegistry(async (reg, tmp) => {
    const base = ['--out', join(tmp, 'o'), '--run', RUN, '--now', '2026-11-02T00:00:00Z'];
    const cases = [
      [['--to', '2026-10-01', ...base], /--from is needed/],
      [['--from', '2026-10-01', ...base], /--to is needed/],
      [['--from', '2026-10-01', '--to', '2026-10-01', '--run', RUN], /--out is needed/],
      [['--from', '2026-02-30', '--to', '2026-10-01', ...base], /--from "2026-02-30" is not a calendar day/],
      [['--from', '2025-12-31', '--to', '2026-10-01', ...base], /from 2026-01-01/],
      [['--from', '2026-10-02', '--to', '2026-10-01', ...base], /--to 2026-10-01 is before --from 2026-10-02/],
      [['--from', '2026-07-31', '--to', '2026-10-01', ...base], new RegExp(`holds more than ${MAX_DAYS} days`)],
      [['--from', '2026-10-01', '--to', '2026-10-01', '--out', join(tmp, 'o'), '--now', '2026-11-02T00:00:00Z'], /is not a workflow run id/],
      [['--from', '2026-10-01', '--to', '2026-10-01', ...base, '--listing', 'x'], /unknown flag --listing/],
      [['--from', '2026-10-01', '--to', '2026-10-01', ...base, '--recordings', join(tmp, 'none')], /is not a directory/],
      [['--from', '2026-10-01', '--to', '2026-10-01', ...base, '--from', '2026-10-01'], /--from is given twice/],
    ];
    for (const [argv, re] of cases) {
      const r = await call(main, argv, { reg, now: '2026-11-02T00:00:00Z', env: {} });
      assert.equal(r.code, EXIT.usage, `${argv.join(' ')}\n${r.text}`);
      assert.match(r.text, re);
    }
    // 62 days is the most: 2026-08-31 to 2026-10-31.
    assert.equal(MAX_DAYS, 62);
    assert.equal(reg.w.unusedBodies().length, 0);
    // --out that holds a file is refused before a read.
    mkdirSync(join(tmp, 'full'));
    writeFileSync(join(tmp, 'full', 'x'), '');
    const full = await call(main, ['--from', '2026-10-01', '--to', '2026-10-01', '--out', join(tmp, 'full'), '--run', RUN], { reg, now: '2026-11-02T00:00:00Z', env: {} });
    assert.equal(full.code, EXIT.usage, full.text);
    assert.match(full.text, /holds files: thc-plan writes into a new directory/);
  }));

test('thc-plan: a listing that answers 503, does not parse or has no recording, and an index needed and failing, are exit 2; a state that does not read is PRIVATE PACKAGE, exit 4', () =>
  inRegistry(async (reg, tmp) => {
    seedWorld(reg);
    const run = (recordings, out, from = '2026-10-30', to = '2026-10-30') => plan(reg, tmp, { from, to, now: '2026-11-02T13:00:00Z', recordings, out: join(tmp, out) });
    const down = await run(hosts(join(tmp, 'a'), { status: 503 }), 'a-out');
    assert.equal(down.code, EXIT.usage, down.text);
    assert.match(down.text, /thc-plan: hf hf: GET https:\/\/huggingface\.co\/api\/buckets\/.* answered 503; nothing is planned/);
    const junk = await run(hosts(join(tmp, 'b'), { body: '{"not":"a list"}' }), 'b-out');
    assert.equal(junk.code, EXIT.usage, junk.text);
    assert.match(junk.text, /the page is not a JSON list/);
    mkdirSync(join(tmp, 'c'));
    const none = await run(join(tmp, 'c'), 'c-out');
    assert.equal(none.code, EXIT.usage, none.text);
    assert.match(none.text, /no recording/);
    // 10-31 is not listed: the index is read, and it has no recording.
    const index = await run(hosts(join(tmp, 'd'), { listing: [{ day: '2026-10-30', size: 1 }] }), 'd-out', '2026-10-30', '2026-10-31');
    assert.equal(index.code, EXIT.usage, index.text);
    assert.match(index.text, /thc-plan: cs2 cs2: GET https:\/\/cs2\.ip\.thc\.org\/ failed: .*no recording/);
    reg.w.manifests.delete('state:latest');
    const priv = await run(hosts(join(tmp, 'e'), { listing: [{ day: '2026-10-30', size: 1 }] }), 'e-out');
    assert.equal(priv.code, EXIT.private, priv.text);
    assert.ok(priv.out.includes('PRIVATE PACKAGE'), priv.text);
    assert.match(posix(priv.text), /state:latest did not read with no credential/);
  }));
