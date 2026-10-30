// scripts/state/hours.mjs: the hour packs a live run owes (D7 to D9 of DOM-024),
// against the GHCR double of scripts/root/fixture.mjs: the segments are real
// packs of synthetic records (packages/compact/test/daily-helpers.ts) in obs,
// owed by the next state; the filter and the delta are real DLBF and DLBD
// objects of state; scripts/compact/hour.mjs, verify-pack.mjs and push.mjs
// run in process. The hour is 2026-10-30 08:00 to 09:00 of oi-cs (bit 4).
//
//   node scripts/test.mjs scripts/state --name hours
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactType, segTag } from '@domains/ghcr';
import { BloomFilter, EPOCH_MS, HashDelta, hashKey } from '@domains/ledger';
import { IDX_TITLE, partTitle } from '@domains/pack';
import { emptyState, encodeState, parseState } from '@domains/state';
import { segment } from '../../packages/compact/test/daily-helpers.ts';
import { call, copied, inRegistry, SOURCES, seedRoot } from '../ingest/fixture.mjs';
import { sha } from '../root/fixture.mjs';
import { main as verifyMain } from '../verify-pack.mjs';
import { EXIT, main, REQUIRE } from './hours.mjs';

const digestOf = (reg, tag) => {
  const text = reg.w.manifests.get(`state:${tag}`);
  return text === undefined ? null : sha(text);
};

const TYPE = artifactType('state');
const NOW = '2026-10-30T09:05:00Z';
const secs = (iso) => (Date.parse(iso) - EPOCH_MS) / 1000;
const rec = (key, iso) => ({ key, flags: 0, sources: [{ bit: 4, first: secs(iso), last: secs(iso) }], evidence: [] });

// A domains segment of oi-cs over [start, end) in obs, and its owed item.
async function seedSegment(reg, start, end, records) {
  const s = await segment('oi-cs', start, end, records, { precision: 'second' });
  const tag = segTag('oi-cs', start, end, 'd');
  const digest = reg.seed('obs', tag, artifactType('segment'), s.json.annotations, [...s.parts.map((bytes, i) => ({ title: partTitle(i), bytes })), { title: IDX_TITLE, bytes: s.idx }]);
  return { ref: `obs:${tag}`, digest, dataset: 'domains', tier: 'seg', start, end, since: '2026-10-30T09:00:00Z' };
}

// A filter of the table through 2026-10-29 that holds com.alpha-synthetic, in state.
function seedFilter(reg, day = '2026-10-29', keys = ['com.alpha-synthetic']) {
  const f = BloomFilter.forKeys(10, { asOf: secs(`${day}T00:00:00Z`) + 86_400 });
  for (const k of keys) f.add(hashKey(k));
  const bytes = f.encode();
  reg.seed('state', `ledger-filter-${day.replaceAll('-', '')}`, TYPE, { 'dev.pkgforge.domains.sha256': sha(bytes).slice(7) }, [{ title: 'filter.dlbf', bytes }]);
  return f;
}

function seedDelta(reg, delta) {
  const bytes = delta.encode();
  return reg.seed('state', 'ledger-delta', TYPE, { 'dev.pkgforge.domains.sha256': sha(bytes).slice(7) }, [{ title: 'delta.dlbd', bytes }]);
}

// The world of one test: the root, the hour's two segments (or `windows` of
// them) owed by next.json, and its path.
async function hourWorld(
  reg,
  tmp,
  {
    windows = [
      ['08:00', '08:30'],
      ['08:30', '09:00'],
    ],
    extra = [],
    hour = '08',
  } = {},
) {
  seedRoot(reg);
  const at = (hm) => `2026-10-30T${hm}:00Z`;
  const records = {
    '08:00': [rec('com.alpha-synthetic', at('08:01')), rec('com.beta-synthetic', at('08:12'))],
    '08:30': [rec('net.gamma-synthetic', at('08:59'))],
    '07:00': [rec('org.delta-synthetic', at('07:05'))],
  };
  const owed = [];
  for (const [s, e] of windows)
    owed.push(
      await seedSegment(
        reg,
        at(s),
        at(e),
        [...(records[s] ?? []), ...extra].sort((a, b) => (a.key < b.key ? -1 : 1)),
      ),
    );
  const next = join(tmp, 'next.json');
  writeFileSync(next, encodeState({ ...emptyState('2026-10-30T09:00:00Z'), owed: owed.sort((a, b) => (a.start < b.start ? -1 : 1)) }));
  return { next, owed, tag: `feed-h-20261030${hour}` };
}

const argsOf = (next, out, more = [], lookback = '1') => ['--next', next, '--out', out, '--now', NOW, '--lookback', lookback, '--run', '40000000003', '--sources', SOURCES, ...more];

test('hours: with no ledger-filter tag no hour pack is built, and the next state stays', () =>
  inRegistry(async (reg, tmp) => {
    const w = await hourWorld(reg, tmp);
    const before = readFileSync(w.next);
    const r = await call(main, argsOf(w.next, join(tmp, 'out')), { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out.at(-1), 'ledger none: state holds no ledger-filter tag; no hour pack is built until compact-daily.yml writes the first');
    assert.deepEqual(copied(reg), []);
    assert.deepEqual(readFileSync(w.next), before);
  }));

test('hours: the absent delta is healed, the hour pack is pushed before ledger-delta moves, and the pack is owed', () =>
  inRegistry(async (reg, tmp) => {
    const w = await hourWorld(reg, tmp);
    const f = seedFilter(reg);
    const r = await call(main, argsOf(w.next, join(tmp, 'out')), { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.match(r.text, /^ledger filter state:ledger-filter-20261029 sha256:[0-9a-f]{64} delta none$/m);
    assert.match(r.text, /^started state:ledger-delta empty, paired with state:ledger-filter-20261029$/m);
    const pack = sha(reg.w.manifests.get(`feed:${w.tag}`));
    assert.ok(r.out.includes(`hour 2026103008 built feed:${w.tag} ${pack}`), r.text);
    assert.equal(r.out.at(-1), `owed feed:${w.tag}`);
    // The pack's copy comes before the move of ledger-delta to the hour's delta.
    const copyAt = reg.calls.findIndex((c) => c.verb === 'copy' && c.args.at(-1).endsWith(`feed:${w.tag}`));
    const moves = reg.calls.flatMap((c, i) => (c.verb === 'tag' && c.args.at(-1) === 'ledger-delta' ? [i] : []));
    assert.equal(moves.length, 2, 'the heal, then the hour');
    assert.ok(moves[0] < copyAt && copyAt < moves[1], reg.calls.map((c) => c.verb).join(' '));
    // The delta holds the hour's new domains and pairs with the filter; the run tags differ.
    const d = HashDelta.decode(reg.bytes.get(JSON.parse(reg.w.manifests.get('state:ledger-delta')).layers[0].digest));
    assert.deepEqual([d.filterAsOf, d.filterCrc, d.size, d.has(hashKey('net.gamma-synthetic')), d.has(hashKey('com.alpha-synthetic'))], [f.asOf, f.crc, 2, true, false]);
    assert.ok(reg.w.manifests.has('state:ledger-delta-20261030t090500z') && reg.w.manifests.has('state:ledger-delta-20261030t090501z'));
    const next = parseState(readFileSync(w.next));
    assert.deepEqual(
      next.owed.find((o) => o.ref === `feed:${w.tag}`),
      { ref: `feed:${w.tag}`, digest: pack, dataset: 'feed', tier: 'h', start: '2026-10-30T08:00:00Z', end: '2026-10-30T09:00:00Z', since: NOW },
    );
    // A re-run finds the build and owes it once: nothing more is built or pushed.
    const copies = copied(reg).length;
    const again = await call(main, argsOf(w.next, join(tmp, 'again')), { reg, now: NOW });
    assert.equal(again.code, EXIT.ok, again.text);
    assert.equal(again.out.at(-1), 'hours none to build');
    assert.equal(copied(reg).length, copies);
  }));

test('hours: a build of a closed hour that the root lacks and next does not owe is owed', () =>
  inRegistry(async (reg, tmp) => {
    const w = await hourWorld(reg, tmp);
    const { digest } = await reg.seedPack('feed', w.tag, { dataset: 'feed', tier: 'h', start: '2026-10-30T08:00:00Z', end: '2026-10-30T09:00:00Z', sources: ['oi-cs'] });
    const r = await call(main, argsOf(w.next, join(tmp, 'out')), { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out, [`owed feed:${w.tag}`, 'hours none to build']);
    assert.equal(parseState(readFileSync(w.next)).owed.find((o) => o.ref === `feed:${w.tag}`)?.digest, digest);
  }));

test('hours: the first hour that waits stops the run with exit 3, and no later hour is built', () =>
  inRegistry(async (reg, tmp) => {
    // 07:00 holds a segment to 07:30 alone: a hole to 08:00. 08:00 is whole.
    const w = await hourWorld(reg, tmp, {
      windows: [
        ['07:00', '07:30'],
        ['08:00', '08:30'],
        ['08:30', '09:00'],
      ],
    });
    seedFilter(reg);
    const r = await call(main, argsOf(w.next, join(tmp, 'out'), [], '2'), { reg, now: NOW });
    assert.equal(r.code, EXIT.wait, r.text);
    assert.equal(r.out.at(-1), 'hour 2026103007 wait');
    assert.match(r.text, /^verdict wait feed:feed-h-2026103007 /m);
    assert.equal(
      copied(reg).some((t) => t.startsWith('feed-h-')),
      false,
      'no hour pack pushed',
    );
  }));

test('hours: an hour that scripts/compact/hour.mjs cannot build stops the run with its exit code, and no later hour is built', () =>
  inRegistry(async (reg, tmp) => {
    const w = await hourWorld(reg, tmp, {
      windows: [
        ['07:00', '08:00'],
        ['08:00', '08:30'],
        ['08:30', '09:00'],
      ],
    });
    seedFilter(reg);
    // Planted: GHCR answers 500 to the manifest of the segment of 07:00.
    const base = reg.w.intercept;
    reg.w.intercept = (url, init) => (url.includes('/obs/manifests/oi-cs.20261030t070000z.') ? reg.w.response(500, 'synthetic outage', {}, { url }) : base(url, init));
    const r = await call(main, argsOf(w.next, join(tmp, 'out'), [], '2'), { reg, now: NOW });
    reg.w.intercept = base;
    assert.equal(r.code, EXIT.usage, r.text);
    assert.match(r.text, /^hours: scripts\/compact\/hour\.mjs exited 2 for the hour 2026103007; no later hour is built$/m);
    assert.ok(!r.out.some((l) => l.startsWith('hour 2026103008') || l.startsWith('hour feed:feed-h-2026103008')), r.text);
    assert.equal(
      copied(reg).some((t) => t.startsWith('feed-h-')),
      false,
      'no hour pack pushed',
    );
  }));

test('hours: a delta of an older filter is rebased before the hour, and a pack that fails its verify pushes nothing', () =>
  inRegistry(async (reg, tmp) => {
    // Planted: the segment holds co.uk, a public suffix, which the verifier's name check refuses.
    const w = await hourWorld(reg, tmp, { extra: [rec('uk.co', '2026-10-30T08:02:00Z')] });
    const older = BloomFilter.forKeys(10, { asOf: secs('2026-10-29T00:00:00Z') });
    const old = HashDelta.empty(older);
    old.add(hashKey('com.alpha-synthetic'));
    old.add(hashKey('org.epsilon-synthetic'));
    const live = seedDelta(reg, old);
    seedFilter(reg);
    const r = await call(main, argsOf(w.next, join(tmp, 'out')), { reg, now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /^rebased state:ledger-delta 2 to 1 hash\(es\) onto state:ledger-filter-20261029$/m);
    assert.match(r.text, new RegExp(`^moved state:ledger-delta ${live} -> sha256:[0-9a-f]{64}, read back with no credential$`, 'm'));
    assert.match(r.text, /FAIL name /);
    assert.match(r.text, /verdict fail: nothing of the hour is pushed, and ledger-delta stays/);
    assert.equal(
      copied(reg).some((t) => t.startsWith('feed-h-')),
      false,
    );
    assert.equal(reg.calls.filter((c) => c.verb === 'tag' && c.args.at(-1) === 'ledger-delta').length, 1, 'the heal alone moved the delta');
  }));

test('hours: usage, a --next that is not a state and no token are exit 2', () =>
  inRegistry(async (reg, tmp) => {
    const w = await hourWorld(reg, tmp);
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{}');
    const cases = [
      [argsOf(bad, join(tmp, 'a')), /does not read as a state/],
      [argsOf(w.next, join(tmp, 'b'), [], '49'), /--lookback "49" is not a whole number of 1 to 48/],
      [argsOf(w.next, join(tmp, 'b0'), [], '0'), /--lookback "0" is not a whole number of 1 to 48/],
      [['--next', w.next, '--out', join(tmp, 'c'), '--now', NOW, '--run', 'local'], /the run "local" is not a workflow run id/],
      [['--out', join(tmp, 'd')], /--next is needed/],
      // A flag of one value given twice is refused, never the last taken.
      [argsOf(w.next, join(tmp, 'f'), ['--lookback', '6']), /--lookback is given twice/],
      [argsOf(w.next, join(tmp, 'g'), ['extra']), /"extra" is not a flag/],
      [argsOf(w.next, join(tmp, 'h'), ['--bogus', 'x']), /unknown flag --bogus/],
      [[...argsOf(w.next, join(tmp, 'i')).slice(0, -2), '--sources'], /--sources needs a value/],
    ];
    for (const [argv, re] of cases) {
      const r = await call(main, argv, { reg, now: NOW });
      assert.equal(r.code, EXIT.usage, argv.join(' '));
      assert.match(r.text, re, argv.join(' '));
    }
    // The 48 hours of the range are taken.
    const ok = await call(main, argsOf(w.next, join(tmp, 'j'), [], '48'), { reg, now: NOW });
    assert.notEqual(ok.code, EXIT.usage, ok.text);
    // A RUNNER_TEMP that is no directory is exit 2, not a defect of the script.
    const t = await call(main, argsOf(w.next, join(tmp, 'k')), { reg, now: NOW, extra: { tmp: join(tmp, 'no-such-dir') } });
    assert.equal(t.code, EXIT.usage, t.text);
    assert.match(t.text, /the temporary directory .*no-such-dir \(RUNNER_TEMP\) cannot be used/);
    const none = await call(main, argsOf(w.next, join(tmp, 'e')), { reg, now: NOW, env: { GITHUB_RUN_ID: '1' } });
    assert.equal(none.code, EXIT.usage);
    assert.match(none.text, /REGISTRY_TOKEN .+ and GITHUB_ACTOR are needed/);
  }));

test('hours: each hour pack is verified with the checks of REQUIRE, precision for one source and time for records; a push that fails or a verify of another verdict stops the run and moves no delta', () =>
  inRegistry(async (reg, tmp) => {
    const w = await hourWorld(reg, tmp);
    seedFilter(reg);
    const seen = [];
    const verify = (argv, io) => {
      seen.push(argv[argv.indexOf('--require') + 1]);
      return verifyMain(argv, io);
    };
    // The verify that could not run: a fault, nothing pushed, no delta moved past its heal.
    const broken = await call(main, argsOf(w.next, join(tmp, 'a')), { reg, now: NOW, extra: { verify: async () => 2 } });
    assert.equal(broken.code, EXIT.fault, broken.text);
    assert.match(broken.text, /feed:feed-h-2026103008 verdict none \(verify-pack\.mjs exited 2\): nothing of the hour is pushed, and ledger-delta stays/);
    assert.equal(reg.w.manifests.has(`feed:${w.tag}`), false);
    // A push of the hour pack that fails: exit 1, the delta stays where the heal left it.
    const healed = digestOf(reg, 'ledger-delta');
    const failing = async (args, opts) => (args[0] === 'copy' && args.at(-1).endsWith(`feed:${w.tag}`) ? { code: 1, stdout: '', stderr: 'Error: synthetic failure\n' } : reg.oras(args, opts));
    const pushed = await call(main, argsOf(w.next, join(tmp, 'b')), { reg, now: NOW, extra: { oras: failing, verify } });
    assert.equal(pushed.code, EXIT.fault, pushed.text);
    assert.equal(digestOf(reg, 'ledger-delta'), healed, 'no move after a failed push');
    assert.deepEqual(seen, [`${REQUIRE.join(',')},precision,time`]);
    assert.deepEqual(REQUIRE, ['dataset', 'length', 'count', 'sha256', 'psl', 'sources']);
  }));

test('hours: an hour that starts at the filter as_of is built, and the hours before it are not', () =>
  inRegistry(async (reg, tmp) => {
    const w = await hourWorld(reg, tmp, {
      windows: [
        ['07:00', '07:30'],
        ['08:00', '08:30'],
        ['08:30', '09:00'],
      ],
    });
    // The filter of the table through 2026-10-30T08:00:00Z: as_of is the start of the hour of 08.
    const f = BloomFilter.forKeys(10, { asOf: secs('2026-10-30T08:00:00Z') });
    f.add(hashKey('com.alpha-synthetic'));
    const bytes = f.encode();
    reg.seed('state', 'ledger-filter-20261029', TYPE, { 'dev.pkgforge.domains.sha256': sha(bytes).slice(7) }, [{ title: 'filter.dlbf', bytes }]);
    const r = await call(main, argsOf(w.next, join(tmp, 'out'), [], '2'), { reg, now: NOW });
    assert.ok(
      r.out.some((l) => l.startsWith('hour 2026103008 ')),
      r.text,
    );
    assert.ok(!r.out.some((l) => l.startsWith('hour 2026103007 ')), r.text);
  }));
