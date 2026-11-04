// scripts/state/advance.mjs: the next state from one run's proposals, and the
// owed packs settled against the live root (D4, D5 and D24 of DOM-024), against
// the GHCR double of scripts/root/fixture.mjs, and the walk of the chain of
// roots that settles a segment a compaction replaced (DOM-063, the tests
// named `replaced segment`). The proposals are the ones
// scripts/ingest/run.mjs writes for the two fixture adapters, beside planted
// files: one that does not parse, one whose `before` is not the live cursor,
// one naming a tag GHCR does not hold, and two of one adapter. The root's
// entries are synthetic (packages/root/test/helpers.ts).
//
//   node scripts/test.mjs scripts/state --name advance
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactType, GhcrError, segTag } from '@domains/ghcr';
import { buildRoot, sourcesLayer } from '@domains/root';
import { emptyState, encodeProposal, encodeState, OWED_DAYS, parseProposal, parseState, propose, STATE_MAX_BYTES, settle } from '@domains/state';
import { digestOf, pack } from '../../packages/root/test/helpers.ts';
import { ADAPTERS, call, inRegistry, PSL, PSL_FILE, RECORDINGS, SOURCES, seedRoot, stateFile } from '../ingest/fixture.mjs';
import { main as runMain } from '../ingest/run.mjs';
import { EPOCH_MS } from '@domains/ledger';
import { ROOT } from '../files.mjs';
import { RateLimitError } from '../ghcr/rate.mjs';
import { Fault } from '../root/lib.mjs';
import { loadRegistry } from '../verify-pack.mjs';
import { CHAIN_ROOTS, CHAIN_SECONDS, chainLine, filterTagOf, gapHeldBy, heldBy, newestFilterTag, replacedOnChain } from './lib.mjs';
import { ADVANCE_FORMAT, EXIT, main } from './advance.mjs';

const NOW = '2026-10-30T08:40:00Z';
const TYPE = artifactType('state');
const D = (c) => `sha256:${c.repeat(64)}`;

// The proposals of the two fixture adapters, run against the double into `dir`.
async function fixtureProposals(reg, tmp) {
  const empty = stateFile(tmp, emptyState('2026-10-30T08:00:00Z'), 'empty.json');
  const out = join(tmp, 'lanes');
  for (const adapter of ['fixture-stream', 'fixture-file']) {
    const r = await call(
      runMain,
      [
        '--adapter',
        adapter,
        '--out',
        out,
        '--adapters',
        ADAPTERS,
        '--sources',
        SOURCES,
        '--recordings',
        RECORDINGS(adapter),
        '--psl',
        PSL_FILE,
        '--state',
        empty,
        '--now',
        '2026-10-30T08:35:00Z',
        '--run',
        '40000000001',
      ],
      { reg, now: '2026-10-30T08:35:00Z' },
    );
    assert.equal(r.code, 0, r.text);
  }
  return join(out, 'proposals');
}

test('advance: accepted, dropped and settled proposals, and the next state they give', () =>
  inRegistry(async (reg, tmp) => {
    const dir = await fixtureProposals(reg, tmp);
    const stream = parseProposal(readFileSync(join(dir, 'proposal.fixture-stream.json')));
    // Planted: a file that does not parse, a stale before, a tag GHCR lacks, two proposals of one adapter.
    writeFileSync(join(dir, 'proposal.broken.json'), '{"format":"domains.proposal.v1"');
    writeFileSync(join(dir, 'proposal.fixture-old.json'), encodeProposal(propose({ ...stream, adapter: 'fixture-old', before: { next: 9 } })));
    const gone = segTag('oi-cs', '2026-10-30T09:00:00Z', '2026-10-30T09:10:00Z');
    const goneSeg = { ref: `obs:${gone}`, digest: D('a'), source: 'oi-cs', dataset: 'names', start: '2026-10-30T09:00:00Z', end: '2026-10-30T09:10:00Z', count: 1, quarantined: false };
    writeFileSync(join(dir, 'proposal.fixture-gone.json'), encodeProposal(propose({ ...stream, adapter: 'fixture-gone', segments: [goneSeg], raw: [] })));
    writeFileSync(join(dir, 'twice-1.json'), encodeProposal(propose({ ...stream, adapter: 'fixture-twice' })));
    writeFileSync(join(dir, 'twice-2.json'), encodeProposal(propose({ ...stream, adapter: 'fixture-twice', after: { next: 3 } })));
    // The live root names one owed segment and covers one owed hour pack.
    const seg = pack('names', 'seg', '2026-10-30T07:00:00Z', { sources: ['oi-cs'] });
    const day = pack('feed', 'd', '2026-10-29T00:00:00Z', { sources: ['oi-cs'] });
    seedRoot(reg, { now: '2026-10-30T08:00:00Z', add: [seg, day] });
    const kept = {
      ref: `obs:${segTag('oi-cs', '2026-10-30T06:00:00Z', '2026-10-30T06:10:00Z')}`,
      digest: D('b'),
      dataset: 'names',
      tier: 'seg',
      start: '2026-10-30T06:00:00Z',
      end: '2026-10-30T06:10:00Z',
      since: '2026-10-30T06:30:00Z',
    };
    const owed = [
      {
        ref: `obs:${segTag('oi-cs', '2026-10-20T08:00:00Z', '2026-10-20T08:10:00Z')}`,
        digest: D('c'),
        dataset: 'names',
        tier: 'seg',
        start: '2026-10-20T08:00:00Z',
        end: '2026-10-20T08:10:00Z',
        since: '2026-10-20T08:30:00Z',
      },
      { ref: 'feed:feed-h-2026102905', digest: D('d'), dataset: 'feed', tier: 'h', start: '2026-10-29T05:00:00Z', end: '2026-10-29T06:00:00Z', since: '2026-10-29T06:20:00Z' },
      kept,
      { ref: `obs:${seg.pack.tag}`, digest: seg.pack.manifest, dataset: 'names', tier: 'seg', start: seg.pack.span.start, end: seg.pack.span.end, since: '2026-10-30T07:30:00Z' },
    ];
    const live = { ...emptyState('2026-10-30T07:30:00Z'), owed };
    const liveDigest = reg.seed('state', 'latest', TYPE, {}, [{ title: 'state.json', bytes: encodeState(live) }]);
    const out = join(tmp, 'state');
    const r = await call(main, ['--proposals', dir, '--out', out, '--now', NOW, '--run', '40000000002'], { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out[0], `live state:latest ${liveDigest}`);
    assert.deepEqual(
      r.out.filter((l) => l.startsWith('settled ')).map((l) => l.split(' ').slice(0, 3).join(' ')),
      [`settled ${owed[0].ref} expired`, 'settled feed:feed-h-2026102905 covered', `settled ${owed[3].ref} held`],
    );
    assert.deepEqual(
      r.out.filter((l) => l.startsWith('accepted ')),
      ['accepted fixture-file segments 2 raw 0 history 2 cursor moved', 'accepted fixture-stream segments 4 raw 2 history 0 cursor moved'],
    );
    assert.deepEqual(
      r.out.filter((l) => l.startsWith('dropped ')).map((l) => l.split(' ').slice(0, 3).join(' ')),
      ['dropped - invalid', 'dropped fixture-gone missing-tag', 'dropped fixture-old stale-before', 'dropped fixture-twice duplicate', 'dropped fixture-twice duplicate'],
    );
    assert.equal(r.out.at(-1), 'next changed owed 7');
    const next = parseState(readFileSync(join(out, 'next.json')));
    assert.deepEqual(next.cursors, { 'fixture-file': { last_day: '2026-10-29' }, 'fixture-stream': { next: 2 } });
    assert.deepEqual(next.moved['fixture-stream'], { at: NOW, run: '40000000002' });
    assert.deepEqual(
      next.history['isc-new'].map((h) => h.day),
      ['2026-10-28', '2026-10-29'],
    );
    assert.equal(next.updated, NOW);
    assert.ok(next.owed.some((o) => o.ref === kept.ref));
    assert.deepEqual(next.owed.filter((o) => o.since === NOW).length, 6);
    const file = JSON.parse(readFileSync(join(out, 'advance.json'), 'utf8'));
    assert.deepEqual([file.format, file.live, file.changed, file.accepted], [ADVANCE_FORMAT, liveDigest, true, ['fixture-file', 'fixture-stream']]);
    assert.equal(file.dropped.length, 5);
    assert.equal(file.settled.length, 3);
    assert.deepEqual(readdirSync(out).sort(), ['advance.json', 'next.json']);
  }));

test('advance: with no state and no proposal, the next state is empty and unchanged', () =>
  inRegistry(async (reg, tmp) => {
    const out = join(tmp, 'state');
    const r = await call(main, ['--proposals', join(tmp, 'absent'), '--out', out, '--now', NOW], { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out, ['live state:latest none', 'next unchanged owed 0']);
    assert.deepEqual(parseState(readFileSync(join(out, 'next.json'))), emptyState(NOW));
    assert.deepEqual(JSON.parse(readFileSync(join(out, 'advance.json'), 'utf8')), { accepted: [], changed: false, dropped: [], format: ADVANCE_FORMAT, live: null, settled: [] });
    mkdirSync(join(tmp, 'empty'));
    const e = await call(main, ['--proposals', join(tmp, 'empty'), '--out', join(tmp, 'state2'), '--now', NOW, '--run', 'local'], { reg, now: NOW });
    assert.equal(e.code, EXIT.ok, e.text);
  }));

test('advance: a live state that does not validate is exit 1, a private one exit 4, and usage exit 2', () =>
  inRegistry(async (reg, tmp) => {
    reg.seed('state', 'latest', TYPE, {}, [{ title: 'state.json', bytes: new TextEncoder().encode('{"format":"domains.state.v1"}\n') }]);
    const bad = await call(main, ['--proposals', tmp, '--out', join(tmp, 'a'), '--now', NOW], { reg, now: NOW });
    assert.equal(bad.code, EXIT.fault, bad.text);
    assert.match(bad.text, /state:latest: state\.json/);
    const base = reg.w.intercept;
    reg.w.intercept = (url, init) => (url.includes('/state/manifests/') ? reg.w.response(404, '{"errors":[{"code":"NAME_UNKNOWN"}]}', {}, { url }) : base(url, init));
    const priv = await call(main, ['--proposals', tmp, '--out', join(tmp, 'b'), '--now', NOW], { reg, now: NOW });
    assert.equal(priv.code, EXIT.private, priv.text);
    assert.deepEqual(priv.out, ['PRIVATE PACKAGE']);
    for (const argv of [
      ['--out', join(tmp, 'c')],
      ['--proposals', tmp],
      ['--proposals', tmp, '--out', join(tmp, 'd'), '--run', 'x1'],
      ['--proposals', tmp, '--out', join(tmp, 'e'), '--now', 'today'],
    ]) {
      assert.equal((await call(main, argv, { reg, now: NOW })).code, EXIT.usage, argv.join(' '));
    }
    const twice = await call(main, ['--proposals', tmp, '--proposals', tmp, '--out', join(tmp, 'f'), '--now', NOW], { reg, now: NOW });
    assert.equal(twice.code, EXIT.usage, twice.text);
    assert.match(twice.text, /^advance: --proposals is given twice$/m);
    assert.equal(existsSync(join(tmp, 'f')), false);
  }));

test('advance: a --proposals that is a file is exit 2, and an error advance does not know is exit 70 with its stack', () =>
  inRegistry(async (reg, tmp) => {
    const file = join(tmp, 'proposal.fixture-file.json');
    writeFileSync(file, '{}\n');
    const r = await call(main, ['--proposals', file, '--out', join(tmp, 'a'), '--now', NOW], { reg, now: NOW });
    assert.equal(r.code, EXIT.usage, r.text);
    assert.match(r.text, /^advance: --proposals .+proposal\.fixture-file\.json is not a directory$/m);
    const planted = await call(main, ['--proposals', tmp, '--out', join(tmp, 'b')], {
      reg,
      now: NOW,
      extra: {
        now: () => {
          throw new TypeError('a planted defect');
        },
      },
    });
    assert.equal(planted.code, EXIT.internal, planted.text);
    assert.match(planted.text, /^advance: internal error: TypeError: a planted defect$/m);
    assert.match(planted.text, /^ {4}at /m);
    assert.deepEqual(reg.calls, [], 'nothing read or written');
  }));

test('advance: heldBy names a pack the root holds, a digest it withdrew, and an hour pack a feed pack of a higher tier spans', () => {
  const seg = pack('names', 'seg', '2026-10-30T07:00:00Z', { sources: ['oi-cs'] });
  const day = pack('feed', 'd', '2026-10-29T00:00:00Z', { sources: ['oi-cs'] });
  const root = { ...buildRoot({ live: null, psl: PSL, now: '2026-10-30T08:00:00Z', add: [seg, day] }), withdrawn: [{ manifest: D('e'), at: '2026-10-30T08:00:00Z' }] };
  const held = heldBy(root);
  const item = (ref, o = {}) => ({ ref, digest: D('f'), dataset: 'names', tier: 'seg', start: '2026-10-30T06:00:00Z', end: '2026-10-30T06:10:00Z', since: NOW, ...o });
  assert.equal(held(item(`obs:${seg.pack.tag}`))?.code, 'held');
  assert.equal(held(item(`obs:${segTag('oi-cs', '2026-10-30T06:00:00Z', '2026-10-30T06:10:00Z')}`, { digest: D('e') }))?.code, 'withdrawn');
  const hour = (h) =>
    item(`feed:feed-h-${h.replaceAll(/[-T:]/g, '').slice(0, 10)}`, { dataset: 'feed', tier: 'h', start: h, end: new Date(Date.parse(h) + 3_600_000).toISOString().replace('.000Z', 'Z') });
  assert.equal(held(hour('2026-10-29T23:00:00Z'))?.code, 'covered');
  assert.equal(held(hour('2026-10-30T00:00:00Z')), null);
  // A segment is never covered by a higher tier: a pack built while it was owed does not hold it.
  assert.equal(held(item(`obs:${segTag('oi-cs', '2026-10-29T06:00:00Z', '2026-10-29T06:10:00Z')}`, { start: '2026-10-29T06:00:00Z', end: '2026-10-29T06:10:00Z' })), null);
  assert.equal(heldBy(null)(item('obs:x')), null);
});

// A live state of `n` owed segments of oi-cs, ten minutes each up to 2026-10-30T08:00:00Z, owed since `since`.
function owedState(n, since) {
  const end = Date.parse('2026-10-30T08:00:00Z');
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const owed = Array.from({ length: n }, (_, i) => {
    const start = iso(end - (n - i) * 600_000);
    const stop = iso(end - (n - i - 1) * 600_000);
    return { ref: `obs:${segTag('oi-cs', start, stop)}`, digest: D('c'), dataset: 'names', tier: 'seg', start, end: stop, since };
  });
  return { ...emptyState(since), owed };
}

test('advance: a next state over 1 MiB is exit 1, naming the packs owed and the oldest, and writes nothing', () =>
  inRegistry(async (reg, tmp) => {
    const dir = await fixtureProposals(reg, tmp);
    // Owed items of one size: as many as leave room for fewer than the six the fixture proposals owe.
    const one = encodeState(owedState(1, '2026-10-30T08:00:00Z')).length - encodeState(owedState(0, '2026-10-30T08:00:00Z')).length;
    const n = Math.floor((STATE_MAX_BYTES - encodeState(owedState(0, '2026-10-30T08:00:00Z')).length) / (one + 1)) - 2;
    const live = owedState(n, '2026-10-30T08:00:00Z');
    assert.ok(encodeState(live).length <= STATE_MAX_BYTES);
    reg.seed('state', 'latest', TYPE, {}, [{ title: 'state.json', bytes: encodeState(live) }]);
    const out = join(tmp, 'state');
    const r = await call(main, ['--proposals', dir, '--out', out, '--now', NOW, '--run', '40000000002'], { reg, now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /advance: FAIL state\.json is \d+ bytes, over 1048576: \d+ pack\(s\) owed, the oldest since 2026-10-30T08:00:00Z; nothing is written/);
    assert.ok(r.text.includes(`: ${n + 6} pack(s) owed`), r.text);
    assert.deepEqual(readdirSync(out), []);
    // Nothing is written, so no line says a proposal was accepted.
    assert.equal(r.out.length, 1, r.text);
    assert.match(r.out[0], /^live state:latest sha256:[0-9a-f]{64}$/);
  }));

test('advance: a .json name that is no file is dropped invalid; a GHCR error of a HEAD is exit 2; a RUNNER_TEMP that cannot be used is exit 2', () =>
  inRegistry(async (reg, tmp) => {
    const dir = await fixtureProposals(reg, tmp);
    mkdirSync(join(dir, 'x.json'));
    // A file whose parse error quotes its own line breaks: the dropped line is one line.
    writeFileSync(join(dir, 'forged.json'), 'x\n::error::forged line\r\n');
    const r = await call(main, ['--proposals', dir, '--out', join(tmp, 'a'), '--now', NOW], { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.ok(r.out.includes('dropped - invalid x.json: not a file'), r.text);
    assert.match(r.out.find((l) => l.startsWith('dropped - invalid forged.json: ')) ?? '', /x\\n::error/);
    for (const l of r.out) assert.ok(!/[\r\n]/.test(l), JSON.stringify(l));
    // Only a 401, 403 or 404 is an absent tag: a 500 to a HEAD stops the job, and no proposal is dropped as missing.
    const base = reg.w.intercept;
    reg.w.intercept = (url, init) => (init.method === 'HEAD' && url.includes('/obs/manifests/') ? reg.w.response(500, 'synthetic outage', {}, { url }) : base(url, init));
    const h = await call(main, ['--proposals', dir, '--out', join(tmp, 'b'), '--now', NOW], { reg, now: NOW });
    assert.equal(h.code, EXIT.usage, h.text);
    assert.ok(!h.out.some((l) => l.startsWith('dropped ') && l.includes('missing-tag')), h.text);
    assert.equal(existsSync(join(tmp, 'b', 'next.json')), false);
    reg.w.intercept = base;
    const t = await call(main, ['--proposals', dir, '--out', join(tmp, 'c'), '--now', NOW], { reg, now: NOW, extra: { tmp: join(tmp, 'no-such-dir') } });
    assert.equal(t.code, EXIT.usage, t.text);
    assert.match(t.text, /the temporary directory .*no-such-dir \(RUNNER_TEMP\) cannot be used/);
  }));

test('advance: a run that only settles an owed pack writes a changed next state', () =>
  inRegistry(async (reg, tmp) => {
    const old = owedState(1, '2026-10-01T00:00:00Z');
    reg.seed('state', 'latest', TYPE, {}, [{ title: 'state.json', bytes: encodeState(old) }]);
    const out = join(tmp, 'state');
    const r = await call(main, ['--proposals', join(tmp, 'none'), '--out', out, '--now', NOW], { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.match(r.out[1], /^settled obs:oi-cs\.20261030t075000z\.20261030t080000z expired /);
    assert.equal(r.out.at(-1), 'next changed owed 0');
    assert.equal(JSON.parse(readFileSync(join(out, 'advance.json'), 'utf8')).changed, true);
    assert.equal(parseState(readFileSync(join(out, 'next.json'))).updated, NOW);
  }));

test('advance: a state:latest of another type, of two layers, of another layer title or over 1 MiB is exit 1; a token read needs both REGISTRY_TOKEN and GITHUB_ACTOR', () =>
  inRegistry(async (reg, tmp) => {
    const bytes = encodeState(emptyState('2026-10-30T08:00:00Z'));
    const cases = [
      [artifactType('root'), [{ title: 'state.json', bytes }], /is "application\/vnd\.pkgforge\.domains\.root\.v1", not application\/vnd\.pkgforge\.domains\.state\.v1/],
      [
        TYPE,
        [
          { title: 'state.json', bytes },
          { title: 'other.json', bytes },
        ],
        /does not hold the one layer state\.json/,
      ],
      [TYPE, [{ title: 'next.json', bytes }], /does not hold the one layer state\.json/],
      [TYPE, [{ title: 'state.json', bytes: new Uint8Array(STATE_MAX_BYTES + 1).fill(0x20) }], /is 1048577 B; a layer here is 1 B to 1048576 B/],
    ];
    for (const [type, layers, re] of cases) {
      reg.seed('state', 'latest', type, {}, layers);
      const r = await call(main, ['--proposals', join(tmp, 'none'), '--out', join(tmp, `o${cases.indexOf(cases.find((c) => c[0] === type && c[1] === layers))}`), '--now', NOW], { reg, now: NOW });
      assert.equal(r.code, EXIT.fault, r.text);
      assert.match(r.text, re);
    }
    reg.w.manifests.delete('state:latest');
    // No state at all, and a token without its actor: no token read, so absent and private cannot be told apart.
    const half = await call(main, ['--proposals', join(tmp, 'none'), '--out', join(tmp, 'half'), '--now', NOW], { reg, now: NOW, env: { REGISTRY_TOKEN: 'synthetic-test-token' } });
    assert.equal(half.code, EXIT.private, half.text);
    assert.match(half.text, /no token is given to tell an absent state from a private one/);
    const actor = await call(main, ['--proposals', join(tmp, 'none'), '--out', join(tmp, 'actor'), '--now', NOW], { reg, now: NOW, env: { GITHUB_ACTOR: 'synthetic-actor' } });
    assert.equal(actor.code, EXIT.private, actor.text);
    assert.deepEqual(reg.calls, [], 'no login without both');
  }));

test('advance: heldBy holds an hour at the very start of a feed day pack, and no hour before it, no pack of another dataset or repository; the newest filter is the latest day', () => {
  const day = pack('feed', 'd', '2026-10-29T00:00:00Z', { sources: ['oi-cs'] });
  const names = pack('names', 'd', '2026-10-28T00:00:00Z', { sources: ['oi-cs'] });
  const root = buildRoot({ live: null, psl: PSL, now: '2026-10-30T08:00:00Z', add: [day, names] });
  const held = heldBy(root);
  const hour = (h, o = {}) => ({
    ref: `feed:feed-h-${h.replaceAll(/[-T:]/g, '').slice(0, 10)}`,
    digest: D('f'),
    dataset: 'feed',
    tier: 'h',
    start: h,
    end: new Date(Date.parse(h) + 3_600_000).toISOString().replace('.000Z', 'Z'),
    since: NOW,
    ...o,
  });
  assert.equal(held(hour('2026-10-29T00:00:00Z'))?.code, 'covered');
  assert.equal(held(hour('2026-10-28T23:00:00Z')), null);
  // A names day pack spans the hour of 2026-10-28: it covers no feed hour.
  assert.equal(held(hour('2026-10-28T05:00:00Z')), null);
  // The same tag in another repository is not the pack the root names.
  assert.equal(held({ ...hour('2026-10-30T01:00:00Z'), ref: `names:${day.pack.tag}` }), null);
  assert.equal(held({ ...hour('2026-10-30T01:00:00Z'), ref: `feed:${day.pack.tag}` })?.code, 'held');
  // An hour pack of another build of the hour (its -r2) does not cover it: only a tier above the hour does.
  const rebuilt = pack('feed', 'h', '2026-10-30T00:00:00Z', { sources: ['oi-cs'], rebuild: 2 });
  const withHour = heldBy(buildRoot({ live: null, psl: PSL, now: '2026-10-30T08:00:00Z', add: [day, rebuilt] }));
  assert.equal(withHour(hour('2026-10-30T00:00:00Z')), null);
  assert.equal(withHour({ ...hour('2026-10-30T00:00:00Z'), ref: `feed:${rebuilt.pack.tag}` })?.code, 'held');
  assert.equal(newestFilterTag(['ledger-delta', 'ledger-filter-20261028', 'ledger-filter-20261030', 'ledger-delta-20261031t000000z', 'ledger-filter-20261029']), 'ledger-filter-20261030');
  assert.equal(newestFilterTag(['ledger-delta']), null);
  // A filter's tag is the day whose end is its as_of; an as_of mid-day is no filter's.
  const asOf = (Date.parse('2026-10-30T00:00:00Z') - EPOCH_MS) / 1000;
  assert.equal(filterTagOf({ asOf }), 'ledger-filter-20261029');
  assert.throws(
    () => filterTagOf({ asOf: asOf + 3600 }),
    (e) => e instanceof Fault && /is not the end of a UTC day/.test(e.message),
  );
});

// ---------------------------------------------------------------- DOM-063: a replaced segment

// The roots of a chain, oldest first, each built by buildRoot from the one
// before: { now, add, replace }. Each digest is synthetic (digestOf of its
// root_seq). { live, byDigest, readOlder, reads }: readOlder answers a root by
// its digest and records its root_seq in reads.
function chainOf(steps) {
  const byDigest = new Map();
  let live = null;
  for (const s of steps) {
    const root = buildRoot({ live, psl: PSL, now: s.now, add: s.add ?? [], replace: s.replace ?? [] });
    const digest = digestOf(`root ${root.root_seq}`);
    byDigest.set(digest, root);
    live = { root, digest };
  }
  const reads = [];
  const readOlder = async (digest) => {
    const root = byDigest.get(digest);
    reads.push(root.root_seq);
    return root;
  };
  return { live: live.root, byDigest, readOlder, reads };
}

// The owed item of a segment's pack entry, owed since `since`.
const owedOf = (np, since, o = {}) => ({ ref: `obs:${np.pack.tag}`, digest: np.pack.manifest, dataset: np.dataset, tier: 'seg', start: np.pack.span.start, end: np.pack.span.end, since, ...o });

// The case of DOM-024's Found of 2026-11-01T07:56Z, in small: root_seq 2 adds
// the segment x, owed since 07:00; root_seq 3, a compaction, replaces y and x
// with the day pack names-d-20261029; root_seq 4 adds z. w lies in the same
// day of the same source, and no root named it; v is of another source.
const SEG = (start, source = 'oi-cs') => pack('names', 'seg', start, { sources: [source] });
const d28 = pack('names', 'd', '2026-10-28T00:00:00Z', { sources: ['oi-cs'] });
const d29 = pack('names', 'd', '2026-10-29T00:00:00Z', { sources: ['oi-cs'] });
const y = SEG('2026-10-29T00:00:00Z');
const x = SEG('2026-10-29T00:10:00Z');
const w = SEG('2026-10-29T00:20:00Z');
const v = SEG('2026-10-29T01:00:00Z', 'isc-new');
const z = SEG('2026-10-30T00:00:00Z');
const SINCE = '2026-10-30T07:00:00Z';
const STEPS = [
  { now: '2026-10-30T06:00:00Z', add: [d28, y] },
  { now: '2026-10-30T07:30:00Z', add: [x] },
  { now: '2026-10-30T07:40:00Z', replace: [{ old: [y.pack.manifest, x.pack.manifest], new: d29 }] },
  { now: '2026-10-30T07:50:00Z', add: [z] },
];
const LINE = 'chain read 2 root(s), root_seq 3 to 2, for 2 owed segment(s) that a live pack of a higher tier spans: 1 held, 1 named by no root while owed, 0 undecided';

// The chain of STEPS seeded in the double, each root under its dated tag, the
// last one as latest; the digest of each root, oldest first.
function seedChain(reg) {
  let live = null;
  const digests = [];
  for (const [i, s] of STEPS.entries()) {
    const root = buildRoot({ live, psl: PSL, now: s.now, add: s.add ?? [], replace: s.replace ?? [] });
    const digest = reg.seedRoot(root, { latest: i === STEPS.length - 1, sources: sourcesLayer({ registry: loadRegistry(SOURCES), root }) });
    digests.push(digest);
    live = { root, digest };
  }
  return digests;
}

test('advance: a replaced segment that a promotion added and a later root replaced settles as held, and an owed segment no root named while it was owed stays owed', () =>
  inRegistry(async (reg, tmp) => {
    const digests = seedChain(reg);
    // y, owed one second more than OWED_DAYS before NOW, is no candidate of the
    // walk (root_seq 2 named it): settle expires it.
    const owed = [owedOf(y, '2026-10-23T08:39:59Z'), owedOf(x, SINCE), owedOf(w, SINCE, { digest: D('a') }), owedOf(v, SINCE, { digest: D('b') }), owedOf(z, SINCE)];
    reg.seed('state', 'latest', TYPE, {}, [{ title: 'state.json', bytes: encodeState({ ...emptyState(SINCE), owed }) }]);
    const from = reg.w.requests.length;
    const out = join(tmp, 'state');
    const r = await call(main, ['--proposals', join(tmp, 'none'), '--out', out, '--now', NOW], { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out[1], LINE, r.text);
    assert.deepEqual(
      r.out.filter((l) => l.startsWith('settled ')),
      [
        `settled obs:${y.pack.tag} expired obs:${y.pack.tag} is owed since 2026-10-23T08:39:59Z, more than ${OWED_DAYS} days before ${NOW}, and no root names it`,
        `settled obs:${x.pack.tag} held root_seq 2 named obs:${x.pack.tag} (${x.pack.manifest}), root_seq 3 replaced it, and names:names-d-20261029 (tier d, 2026-10-29T00:00:00Z to 2026-10-30T00:00:00Z) holds it in root_seq 4`,
        `settled obs:${z.pack.tag} held root_seq 4 names obs:${z.pack.tag} (${z.pack.manifest})`,
      ],
    );
    // w and v stay owed: no root named w while it was owed, and no live pack carries v's source.
    assert.deepEqual(
      parseState(readFileSync(join(out, 'next.json'))).owed.map((o) => o.ref),
      [`obs:${w.pack.tag}`, `obs:${v.pack.tag}`],
    );
    // The walk read root_seq 3 and 2 by digest, each its manifest and its
    // root.json alone: the live root's three layers and one layer of each.
    const urls = reg.w.requests.slice(from).map((q) => q.url);
    const manifests = urls.filter((u) => /\/root\/manifests\/sha256:/.test(u)).map((u) => u.slice(u.lastIndexOf('/') + 1));
    assert.deepEqual(manifests, [digests[2], digests[1]]);
    assert.equal(urls.filter((u) => /\/root\/blobs\/sha256:/.test(u)).length, 3 + 2, urls.join('\n'));
  }));

test('replaced segment: the walk decides each candidate at the first root that names it, or that holds no pack spanning it, and reads nothing with no candidate', async () => {
  const c = chainOf(STEPS);
  const hour = { ref: 'feed:feed-h-2026102900', digest: D('c'), dataset: 'feed', tier: 'h', start: '2026-10-29T00:00:00Z', end: '2026-10-29T01:00:00Z', since: SINCE };
  const walk = await replacedOnChain(c.live, [owedOf(x, SINCE), owedOf(w, SINCE, { digest: D('a') }), owedOf(v, SINCE, { digest: D('b') }), owedOf(z, SINCE), hour], c.readOlder);
  assert.deepEqual(c.reads, [3, 2]);
  assert.deepEqual([...walk.replaced.keys()], [`obs:${x.pack.tag}`]);
  assert.deepEqual(
    { candidates: walk.candidates, read: walk.read, oldest: walk.oldest, unnamed: walk.unnamed, open: walk.open, stopped: walk.stopped },
    { candidates: 2, read: 2, oldest: 2, unnamed: 1, open: 0, stopped: null },
  );
  assert.equal(chainLine(c.live, walk), LINE);
  // heldBy asks the live root first, then the walk's map: x is held, w is not, and z is held by the live root.
  const held = heldBy(c.live, walk.replaced);
  assert.equal(held(owedOf(x, SINCE)).code, 'held');
  assert.match(held(owedOf(x, SINCE)).detail, /^root_seq 2 named obs:oi-cs\.20261029t001000z\.20261029t002000z \(sha256:[0-9a-f]{64}\), root_seq 3 replaced it, and names:names-d-20261029 /);
  assert.equal(held(owedOf(w, SINCE, { digest: D('a') })), null);
  assert.equal(held(owedOf(z, SINCE)).detail, `root_seq 4 names obs:${z.pack.tag} (${z.pack.manifest})`);
  // Without the walk's map the live root alone holds no replaced segment.
  assert.equal(heldBy(c.live)(owedOf(x, SINCE)), null);
  // No candidate: nothing is read, and no line is printed.
  const none = chainOf(STEPS);
  const quiet = await replacedOnChain(none.live, [owedOf(z, SINCE), owedOf(v, SINCE, { digest: D('b') }), hour], none.readOlder);
  assert.deepEqual([none.reads, quiet.candidates, chainLine(none.live, quiet)], [[], 0, null]);
});

test('replaced segment: a root created before the segment was owed, a digest that differs and a withdrawn digest give no held', async () => {
  // Owed after root_seq 3 was created: root_seq 3 cannot name it, so the walk stops there.
  const late = chainOf(STEPS);
  const lw = await replacedOnChain(late.live, [owedOf(w, '2026-10-30T07:45:00Z', { digest: D('a') })], late.readOlder);
  assert.deepEqual([late.reads, lw.unnamed, lw.replaced.size], [[3], 1, 0]);
  // A root that names the ref under another manifest does not name this segment.
  const other = chainOf(STEPS);
  const ow = await replacedOnChain(other.live, [owedOf(x, SINCE, { digest: D('9') })], other.readOlder);
  assert.deepEqual([other.reads, ow.replaced.size, ow.unnamed], [[3, 2], 0, 1]);
  // A digest the live root withdrew is no candidate: settle takes it as withdrawn.
  const gone = chainOf(STEPS);
  const live = { ...gone.live, withdrawn: [{ manifest: x.pack.manifest, at: '2026-10-30T07:50:00Z' }] };
  const gw = await replacedOnChain(live, [owedOf(x, SINCE)], gone.readOlder);
  assert.deepEqual([gone.reads, gw.candidates], [[], 0]);
  assert.equal(heldBy(live, gw.replaced)(owedOf(x, SINCE)).code, 'withdrawn');
});

// Four more roots after root_seq 4: x is named 6 roots back from root_seq 8.
const LONG = [...STEPS, ...Array.from({ length: 4 }, (_, i) => ({ now: `2026-10-30T08:0${i}:00Z`, add: [SEG(`2026-10-30T00:${(i + 1) * 10}:00Z`)] }))];

test('replaced segment: the walk stops at CHAIN_ROOTS roots, at CHAIN_SECONDS, at the first root, at a root_seq out of order and at a read that fails, and the segment stays owed', async () => {
  const long = LONG;
  // The bounds DOM-063's Decision and docs/architecture.md section 5.4 state.
  assert.deepEqual([CHAIN_ROOTS, CHAIN_SECONDS], [96, 120]);
  assert.ok(readFileSync(join(ROOT, 'docs', 'architecture.md'), 'utf8').includes(`A walk reads at most ${CHAIN_ROOTS} roots and ${CHAIN_SECONDS} seconds`), 'section 5.4 states the bounds');
  const full = chainOf(long);
  assert.equal((await replacedOnChain(full.live, [owedOf(x, SINCE)], full.readOlder)).replaced.size, 1);
  assert.deepEqual(full.reads, [7, 6, 5, 4, 3, 2]);
  const capped = chainOf(long);
  const cw = await replacedOnChain(capped.live, [owedOf(x, SINCE)], capped.readOlder, { max: 3 });
  assert.deepEqual([capped.reads, cw.replaced.size, cw.open, cw.stopped], [[7, 6, 5], 0, 1, 'the walk reads at most 3 roots']);
  assert.equal(
    chainLine(capped.live, cw),
    'chain read 3 root(s), root_seq 7 to 5, for 1 owed segment(s) that a live pack of a higher tier spans: 0 held, 0 named by no root while owed, 1 undecided; the walk stopped: the walk reads at most 3 roots',
  );
  // 50 s on the clock between asks: the third read would start at 150 s, past 120 s.
  const slow = chainOf(long);
  let t = 0;
  const clock = () => {
    t += 50_000;
    return t;
  };
  const tw = await replacedOnChain(slow.live, [owedOf(x, SINCE)], slow.readOlder, { clock });
  assert.deepEqual([slow.reads, tw.stopped], [[7, 6], 'the walk reads for at most 120 s']);
  // The day pack is in every root back to the first, so nothing decides w before the chain ends.
  const first = chainOf([
    { now: '2026-10-30T06:00:00Z', add: [d28, d29] },
    { now: '2026-10-30T07:50:00Z', add: [z] },
  ]);
  const fw = await replacedOnChain(first.live, [owedOf(w, '2026-10-30T05:00:00Z', { digest: D('a') })], first.readOlder);
  assert.deepEqual([first.reads, fw.open, fw.stopped], [[1], 1, 'root_seq 1 is the first root']);
  // A previous that answers a root of another root_seq ends the walk.
  const gap = chainOf(STEPS);
  const skip = async (digest) => (digest === digestOf('root 3') ? gap.byDigest.get(digestOf('root 2')) : gap.readOlder(digest));
  const sw = await replacedOnChain(gap.live, [owedOf(x, SINCE)], skip);
  assert.deepEqual([sw.replaced.size, sw.open, sw.stopped], [0, 1, 'the previous of root_seq 4 is root_seq 2, not 3']);
  // A read that fails with a Fault, a GhcrError or a RateLimitError ends the walk; another error passes through.
  const { live } = chainOf(STEPS);
  for (const e of [new Fault('synthetic fault'), new GhcrError('missing', 'synthetic 404', 404), new RateLimitError('synthetic pause cap')]) {
    const failing = async () => {
      throw e;
    };
    const ew = await replacedOnChain(live, [owedOf(x, SINCE)], failing);
    assert.deepEqual([ew.read, ew.open, ew.stopped], [0, 1, `the read of ${digestOf('root 3')}, the previous of root_seq 4, failed: ${e.message}`]);
  }
  const defect = async () => {
    throw new TypeError('a planted defect');
  };
  await assert.rejects(replacedOnChain(live, [owedOf(x, SINCE)], defect), /a planted defect/);
});

// The case of STEPS in one dataset and one source: d28 and y, then x, then
// the day pack of 2026-10-29 replacing y and x, then a segment of 2026-10-30.
function scenario(dataset, source) {
  const seg = (start) => pack(dataset, 'seg', start, { sources: [source] });
  const day = (start) => pack(dataset, 'd', start, { sources: [source] });
  const sy = seg('2026-10-29T00:00:00Z');
  const sx = seg('2026-10-29T00:10:00Z');
  const steps = [
    { now: '2026-10-30T06:00:00Z', add: [day('2026-10-28T00:00:00Z'), sy] },
    { now: '2026-10-30T07:30:00Z', add: [sx] },
    { now: '2026-10-30T07:40:00Z', replace: [{ old: [sy.pack.manifest, sx.pack.manifest], new: day('2026-10-29T00:00:00Z') }] },
    { now: '2026-10-30T07:50:00Z', add: [seg('2026-10-30T00:00:00Z')] },
  ];
  return { steps, x: sx };
}

test('replaced segment: a segment of domains, and one of oi-nrd-fqdn, settle as held by the day pack of their own dataset and source', async () => {
  for (const [dataset, source, holder] of [
    ['domains', 'oi-cs', 'names:domains-d-20261029'],
    ['names', 'oi-nrd-fqdn', 'names:names-d-20261029'],
  ]) {
    const s = scenario(dataset, source);
    const c = chainOf(s.steps);
    const walk = await replacedOnChain(c.live, [owedOf(s.x, SINCE)], c.readOlder);
    assert.deepEqual([walk.candidates, walk.replaced.size, c.reads], [1, 1, [3, 2]], `${dataset} ${source}`);
    assert.ok(walk.replaced.get(`obs:${s.x.pack.tag}`).includes(`root_seq 3 replaced it, and ${holder} (tier d, `), `${dataset} ${source}`);
  }
});

test('replaced segment: the edges of the walk: the default of CHAIN_ROOTS roots, a budget spent to the second, a previous that is no older, and a root created in the second the segment was owed', async () => {
  // 99 roots after root_seq 4: with no `max`, the walk reads CHAIN_ROOTS of them.
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const many = Array.from({ length: CHAIN_ROOTS + 3 }, (_, i) => ({ now: iso(Date.parse('2026-10-30T08:00:00Z') + i * 60_000), add: [SEG(iso(Date.parse('2026-10-30T00:10:00Z') + i * 600_000))] }));
  const deep = chainOf([...STEPS, ...many]);
  const dw = await replacedOnChain(deep.live, [owedOf(x, SINCE)], deep.readOlder);
  assert.deepEqual([dw.read, dw.replaced.size, dw.open, dw.stopped], [CHAIN_ROOTS, 0, 1, `the walk reads at most ${CHAIN_ROOTS} roots`]);
  // 60 s on the clock between asks: after one read exactly 120 s have passed, and the walk stops.
  const even = chainOf(LONG);
  let t = 0;
  const clock = () => {
    t += 60_000;
    return t;
  };
  const ew = await replacedOnChain(even.live, [owedOf(x, SINCE)], even.readOlder, { clock });
  assert.deepEqual([even.reads, ew.stopped], [[7], `the walk reads for at most ${CHAIN_SECONDS} s`]);
  // A previous that answers the live root again ends the walk.
  const same = chainOf(STEPS);
  const sw = await replacedOnChain(same.live, [owedOf(x, SINCE)], async () => same.live);
  assert.deepEqual([sw.read, sw.replaced.size, sw.open, sw.stopped], [1, 0, 1, 'the previous of root_seq 4 is root_seq 4, not 3']);
  // root_seq 3, created at 07:40:00Z, the second x was owed, is not before
  // it: the walk reads on to root_seq 2, which names it.
  const edge = chainOf(STEPS);
  const gw = await replacedOnChain(edge.live, [owedOf(x, '2026-10-30T07:40:00Z')], edge.readOlder);
  assert.deepEqual([edge.reads, gw.replaced.size], [[3, 2], 1]);
});

test('replaced segment: heldBy answers from the live root and its withdrawn before the walk map, a segment the live root names costs no read, and a walk whose first read failed prints no root', async () => {
  const c = chainOf(STEPS);
  const map = new Map([
    [`obs:${z.pack.tag}`, 'from the walk'],
    [`obs:${x.pack.tag}`, 'from the walk'],
  ]);
  assert.equal(heldBy(c.live, map)(owedOf(z, SINCE)).detail, `root_seq 4 names obs:${z.pack.tag} (${z.pack.manifest})`);
  const gone = { ...c.live, withdrawn: [{ manifest: x.pack.manifest, at: '2026-10-30T07:50:00Z' }] };
  assert.equal(heldBy(gone, map)(owedOf(x, SINCE)).code, 'withdrawn');
  // A root no writer builds (checkLiveSet refuses a segment inside a pack of
  // its source): it names x beside d29, and x is no candidate.
  const named = structuredClone(c.live);
  named.datasets.names.push(x.pack);
  const nw = await replacedOnChain(named, [owedOf(x, SINCE)], c.readOlder);
  assert.deepEqual([nw.candidates, c.reads], [0, []]);
  const failed = await replacedOnChain(c.live, [owedOf(x, SINCE)], async () => {
    throw new Fault('synthetic fault');
  });
  assert.equal(
    chainLine(c.live, failed),
    `chain read no root for 1 owed segment(s) that a live pack of a higher tier spans: 0 held, 0 named by no root while owed, 1 undecided; the walk stopped: the read of ${digestOf('root 3')}, the previous of root_seq 4, failed: synthetic fault`,
  );
});

test("replaced segment: a read that pauses for GHCR's 429 pauses no further than CHAIN_SECONDS, and the segment stays owed", async () => {
  const c = chainOf(STEPS);
  let t = 0;
  const pauses = [];
  const clock = () => t;
  const sleep = async (ms) => {
    pauses.push(ms);
    t += ms;
  };
  // A read that meets a 429 at each ask, and pauses 20 s each time as readPaused does with random() 0,
  // up to readPaused's cap of 600 s.
  const readOlder = async (_digest, pause) => {
    for (let paused = 0; paused < 600_000; paused += 20_000) await pause(20_000);
    throw new RateLimitError('GHCR answered 429 again after 600 s of pauses');
  };
  const walk = await replacedOnChain(c.live, [owedOf(x, SINCE)], readOlder, { clock, sleep });
  assert.deepEqual([t, pauses.length], [CHAIN_SECONDS * 1000, 6]);
  assert.deepEqual(
    [walk.read, walk.open, walk.stopped],
    [0, 1, `the read of ${digestOf('root 3')}, the previous of root_seq 4, failed: a pause of 20 s for GHCR's 429 would end past the walk's ${CHAIN_SECONDS} s`],
  );
});

test("advance: a replaced segment whose walk meets GHCR's 429 at each read pauses CHAIN_SECONDS at most, exits 0 and keeps the segment owed", () =>
  inRegistry(async (reg, tmp) => {
    const digests = seedChain(reg);
    reg.seed('state', 'latest', TYPE, {}, [{ title: 'state.json', bytes: encodeState({ ...emptyState(SINCE), owed: [owedOf(x, SINCE), owedOf(z, SINCE)] }) }]);
    // The double answers 429 to each GET of a root manifest by its digest: the walk's reads alone.
    const inner = reg.w.intercept;
    reg.w.intercept = (url, init) =>
      /\/root\/manifests\/sha256:[0-9a-f]{64}$/.test(url) && (init.method ?? 'GET') === 'GET'
        ? reg.w.response(429, '{"errors":[{"code":"TOOMANYREQUESTS","message":"rate limited"}]}', { 'content-type': 'application/json' }, { url })
        : inner(url, init);
    let clock = Date.parse(NOW);
    let slept = 0;
    const sleep = async (ms) => {
      clock += ms;
      slept += ms;
    };
    const out = join(tmp, 'state');
    const r = await call(main, ['--proposals', join(tmp, 'none'), '--out', out, '--now', NOW], { reg, now: NOW, extra: { now: () => clock, sleep } });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(slept, CHAIN_SECONDS * 1000, r.text);
    // Six pauses of 20 s; readPaused prints the seventh before the walk's sleep refuses it.
    assert.equal(r.err.filter((l) => /GHCR answered 429; pausing 20 s/.test(l)).length, 7, r.text);
    assert.equal(
      r.out[1],
      `chain read no root for 1 owed segment(s) that a live pack of a higher tier spans: 0 held, 0 named by no root while owed, 1 undecided; the walk stopped: the read of ${digests[2]}, the previous of root_seq 4, failed: a pause of 20 s for GHCR's 429 would end past the walk's ${CHAIN_SECONDS} s`,
      r.text,
    );
    assert.deepEqual(
      r.out.filter((l) => l.startsWith('settled ')),
      [`settled obs:${z.pack.tag} held root_seq 4 names obs:${z.pack.tag} (${z.pack.manifest})`],
    );
    assert.deepEqual(
      parseState(readFileSync(join(out, 'next.json'))).owed.map((o) => o.ref),
      [`obs:${x.pack.tag}`],
    );
  }));

test('replaced segment: a segment owed a second time after a compaction replaced it stays owed, since no root of its second owing names it', async () => {
  // x was named by root_seq 2 and replaced by root_seq 3 (07:40:00Z) in its
  // first owing, and is owed again at 07:45:00Z, as a backfill window
  // dispatched again owes it: root_seq 3 was created before, and the walk stops there.
  const c = chainOf(STEPS);
  const again = owedOf(x, '2026-10-30T07:45:00Z');
  const walk = await replacedOnChain(c.live, [again], c.readOlder);
  assert.deepEqual([c.reads, walk.replaced.size, walk.unnamed, walk.open], [[3], 0, 1, 0]);
  assert.equal(heldBy(c.live, walk.replaced)(again), null);
});

test('replaced segment: an owed segment older than OWED_DAYS is no candidate and costs no read, and settle expires it; one owed exactly OWED_DAYS is walked for', async () => {
  const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
  const day7 = iso(Date.parse(NOW) - OWED_DAYS * 86_400_000);
  const old = owedOf(x, iso(Date.parse(day7) - 1000));
  const c = chainOf(STEPS);
  const ow = await replacedOnChain(c.live, [old], c.readOlder, { now: NOW });
  assert.deepEqual([ow.candidates, c.reads], [0, []]);
  const s = settle({ ...emptyState(old.since), owed: [old] }, heldBy(c.live, ow.replaced), NOW);
  assert.deepEqual(
    s.settled.map((e) => e.code),
    ['expired'],
  );
  // With no `now` nothing is left out: the walk finds root_seq 2 naming it.
  const all = chainOf(STEPS);
  assert.equal((await replacedOnChain(all.live, [old], all.readOlder)).replaced.size, 1);
  const edge = chainOf(STEPS);
  const ew = await replacedOnChain(edge.live, [owedOf(x, day7)], edge.readOlder, { now: NOW });
  assert.deepEqual([ew.candidates, ew.replaced.size, edge.reads], [1, 1, [3, 2]]);
});

// D17 of DOM-029: THC's file of 2026-10-29 lands after its day pack was built
// without it. root_seq 2 adds the late day segment beside names-d-20261029,
// root_seq 3 (the daily's absorb) replaces both with names-d-20261029-r2,
// which carries thc-ct, and root_seq 4 adds another pack. The day pack of
// root_seq 2 spans the segment and lacks its source, and the walk still
// settles it at root_seq 2, which names it; a quarantined segment, which the
// absorb takes into names and domains alike, settles the same way.
test('replaced segment: a late day segment that an absorb took into the day pack under -r2 settles as held at the root that named it beside the day pack', async () => {
  for (const quarantine of [false, true]) {
    const day = pack('names', 'd', '2026-10-29T00:00:00Z', { sources: ['oi-cs'] });
    const late = pack('names', 'seg', '2026-10-29T00:00:00Z', { sources: ['thc-ct'], end: '2026-10-30T00:00:00Z', quarantine });
    const r2 = pack('names', 'd', '2026-10-29T00:00:00Z', { sources: ['oi-cs', 'thc-ct'], rebuild: 2 });
    assert.equal(r2.pack.tag, 'names-d-20261029-r2');
    const steps = [
      { now: '2026-10-30T06:00:00Z', add: [d28, day] },
      { now: '2026-10-30T07:30:00Z', add: [late] },
      { now: '2026-10-30T07:40:00Z', replace: [{ old: [day.pack.manifest, late.pack.manifest], new: r2 }] },
      { now: '2026-10-30T07:50:00Z', add: [z] },
    ];
    const c = chainOf(steps);
    const owed = owedOf(late, SINCE);
    const walk = await replacedOnChain(c.live, [owed], c.readOlder, { now: NOW });
    assert.deepEqual([walk.candidates, walk.replaced.size, walk.unnamed, walk.open, c.reads], [1, 1, 0, 0, [3, 2]], `quarantine ${quarantine}`);
    assert.equal(
      walk.replaced.get(owed.ref),
      `root_seq 2 named ${owed.ref} (${late.pack.manifest}), root_seq 3 replaced it, and names:names-d-20261029-r2 (tier d, 2026-10-29T00:00:00Z to 2026-10-30T00:00:00Z) holds it in root_seq 4`,
    );
    const s = settle({ ...emptyState(SINCE), owed: [owed] }, heldBy(c.live, walk.replaced), NOW);
    assert.deepEqual([s.settled.map((e) => e.code), s.state.owed], [['held'], []], `quarantine ${quarantine}`);
    // The day pack of root_seq 2, beside the segment, lacks thc-ct: had the
    // walk not met the root naming it first, the segment would stay owed.
    assert.equal(
      c.byDigest
        .get(digestOf('root 2'))
        .datasets.names.find((p) => p.tag === 'names-d-20261029')
        .sources.includes('thc-ct'),
      false,
    );
  }
});

test('advance: a pending gap day settles when the live root lists it, or when a live segment of its source spans the whole day; the rest stay pending and are printed', () =>
  inRegistry(async (reg, tmp) => {
    const day21 = pack('names', 'seg', '2026-10-21T00:00:00Z', { sources: ['isc-new'], end: '2026-10-22T00:00:00Z' });
    // Ten minutes of 10-23 are not the day.
    const part23 = pack('names', 'seg', '2026-10-22T00:00:00Z', { sources: ['isc-new'], end: '2026-10-23T00:10:00Z' });
    seedRoot(reg, { now: '2026-10-30T08:00:00Z', add: [day21, part23], gaps: { 'isc-new': ['2026-10-20'] } });
    const live = { ...emptyState('2026-10-30T07:30:00Z'), gaps: { 'isc-new': ['2026-10-20', '2026-10-21', '2026-10-23'] } };
    reg.seed('state', 'latest', TYPE, {}, [{ title: 'state.json', bytes: encodeState(live) }]);
    const out = join(tmp, 'state');
    const r = await call(main, ['--proposals', join(tmp, 'none'), '--out', out, '--now', NOW], { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out.slice(1), [
      'settled gap isc-new 2026-10-20 root_seq 1 lists 2026-10-20 in gaps.isc-new',
      `settled gap isc-new 2026-10-21 root_seq 1 names obs:${day21.pack.tag}, a segment of isc-new over 2026-10-21`,
      'gap isc-new 2026-10-23 pending',
      'next changed owed 0',
    ]);
    // A state whose only change is a settled gap is written.
    assert.equal(JSON.parse(readFileSync(join(out, 'advance.json'), 'utf8')).changed, true);
    const next = parseState(readFileSync(join(out, 'next.json')));
    assert.deepEqual(next.gaps, { 'isc-new': ['2026-10-23'] });
    assert.equal(next.updated, NOW);
  }));

test('advance: a gap-only proposal is accepted and its day is pending; with every gap settled the next state has no key gaps', () =>
  inRegistry(async (reg, tmp) => {
    seedRoot(reg, { now: '2026-10-30T08:00:00Z', gaps: { 'isc-new': ['2026-10-04'] } });
    const dir = join(tmp, 'proposals');
    mkdirSync(dir);
    const gapOnly = propose({
      adapter: 'fixture-file',
      lane: null,
      run: '40000000001',
      attempt: 1,
      at: NOW,
      before: null,
      after: null,
      segments: [],
      raw: [],
      history: [],
      gaps: [{ source: 'isc-new', day: '2026-10-09' }],
    });
    writeFileSync(join(dir, 'proposal.fixture-file.20261009.json'), encodeProposal(gapOnly));
    const out = join(tmp, 'state');
    const r = await call(main, ['--proposals', dir, '--out', out, '--now', NOW, '--run', '40000000002'], { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.ok(r.out.includes('accepted fixture-file segments 0 raw 0 history 0 cursor kept'), r.text);
    assert.ok(r.out.includes('gap isc-new 2026-10-09 pending'), r.text);
    const next = parseState(readFileSync(join(out, 'next.json')));
    assert.deepEqual(next.gaps, { 'isc-new': ['2026-10-09'] });
    // The next run, once the root lists the day: settled, and the key goes.
    const settled = settle(next, () => null, NOW, gapHeldBy({ root_seq: 2, gaps: { 'isc-new': ['2026-10-04', '2026-10-09'] }, datasets: {} }));
    assert.deepEqual(
      settled.settledGaps.map((g) => g.day),
      ['2026-10-09'],
    );
    assert.equal(Object.hasOwn(settled.state, 'gaps'), false);
    assert.equal(Object.hasOwn(JSON.parse(new TextDecoder().decode(encodeState(settled.state))), 'gaps'), false);
    // No root yet: nothing is held.
    assert.equal(gapHeldBy(null)('isc-new', '2026-10-09'), null);
  }));
