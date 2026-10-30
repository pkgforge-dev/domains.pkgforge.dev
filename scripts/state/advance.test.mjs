// scripts/state/advance.mjs: the next state from one run's proposals, and the
// owed packs settled against the live root (D4, D5 and D24 of DOM-024), against
// the GHCR double of scripts/root/fixture.mjs. The proposals are the ones
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
import { artifactType, segTag } from '@domains/ghcr';
import { buildRoot } from '@domains/root';
import { emptyState, encodeProposal, encodeState, parseProposal, parseState, propose, STATE_MAX_BYTES } from '@domains/state';
import { pack } from '../../packages/root/test/helpers.ts';
import { ADAPTERS, call, inRegistry, PSL, PSL_FILE, RECORDINGS, SOURCES, seedRoot, stateFile } from '../ingest/fixture.mjs';
import { main as runMain } from '../ingest/run.mjs';
import { EPOCH_MS } from '@domains/ledger';
import { Fault } from '../root/lib.mjs';
import { filterTagOf, heldBy, newestFilterTag } from './lib.mjs';
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
