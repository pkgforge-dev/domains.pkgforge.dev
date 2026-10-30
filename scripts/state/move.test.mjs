// scripts/state/move.mjs and moveTag of scripts/state/lib.mjs: the guarded
// move of state:latest and of ledger-delta (D2, D6 and D8 of DOM-024), against
// the GHCR double of scripts/root/fixture.mjs. A second writer is planted with
// the double's hooks.beforeFetch, before the n-th read of a tag with the
// token. Every state, filter, delta and digest is synthetic.
//
//   node scripts/test.mjs scripts/state --name move
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { artifactType, ledgerDeltaRunTag, stateRunTag } from '@domains/ghcr';
import { BloomFilter, EPOCH_MS, HashDelta, hashKey } from '@domains/ledger';
import { emptyState, encodeState, parseState } from '@domains/state';
import { call, inRegistry, verbs } from '../ingest/fixture.mjs';
import { sha } from '../root/fixture.mjs';
import { EXIT, main } from './move.mjs';

const TYPE = artifactType('state');
const secs = (iso) => (Date.parse(iso) - EPOCH_MS) / 1000;
const TITLE = 'org.opencontainers.image.title';

// A state whose cursor of fixture-stream is { next: n }, updated `at`.
const stateAt = (at, n) => ({ ...emptyState(at), cursors: { 'fixture-stream': { next: n } }, moved: { 'fixture-stream': { at, run: '7' } } });

function writeState(tmp, state, name = 'next.json') {
  const path = join(tmp, name);
  writeFileSync(path, encodeState(state));
  return path;
}

// The layer bytes the double's tag `state:TAG` holds, or null.
function layerAt(reg, tag) {
  const text = reg.w.manifests.get(`state:${tag}`);
  if (text === undefined) return null;
  return reg.bytes.get(JSON.parse(text).layers[0].digest);
}
const digestAt = (reg, tag) => {
  const text = reg.w.manifests.get(`state:${tag}`);
  return text === undefined ? null : sha(text);
};

// A filter of the table through the end of `day`, holding `keys`, and its delta's object in the double.
function filterOf(day, keys = []) {
  const f = BloomFilter.forKeys(Math.max(10, keys.length), { asOf: secs(`${day}T00:00:00Z`) + 86_400 });
  for (const k of keys) f.add(hashKey(k));
  return f;
}
function seedDelta(reg, delta, filterTag) {
  const bytes = delta.encode();
  return reg.seed('state', 'ledger-delta', TYPE, { 'dev.pkgforge.domains.sha256': sha(bytes).slice(7), 'dev.pkgforge.domains.filter': filterTag }, [{ title: 'delta.dlbd', bytes }]);
}

test('move: the first state moves latest to its run tag, under the guard, tags the day snapshot and reads back with no credential', () =>
  inRegistry(async (reg, tmp) => {
    const next = stateAt('2026-10-30T08:30:12Z', 2);
    const r = await call(main, ['state', '--file', writeState(tmp, next), '--expect', 'none'], { reg });
    assert.equal(r.code, EXIT.ok, r.text);
    const run = stateRunTag('2026-10-30T08:30:12Z');
    const digest = digestAt(reg, run);
    assert.deepEqual(r.out, [
      'live state:latest none',
      `pushed ghcr.io/pkgforge-dev/domains.pkgforge.dev/state:${run} ${digest}`,
      `moved state:latest none -> ${digest}, read back with no credential`,
      `snapshot state:state-20261030 ${digest}`,
    ]);
    assert.equal(digestAt(reg, 'latest'), digest);
    assert.equal(digestAt(reg, 'state-20261030'), digest);
    const m = JSON.parse(reg.w.manifests.get('state:latest'));
    assert.equal(m.artifactType, TYPE);
    assert.equal(m.layers[0].annotations[TITLE], 'state.json');
    assert.deepEqual(m.annotations['org.opencontainers.image.created'], '2026-10-30T08:30:12Z');
    assert.deepEqual(parseState(layerAt(reg, 'latest')), next);
    // The guard read latest with the token before the push and again before the move, and latest moved last.
    const v = verbs(reg);
    const latestReads = reg.calls.flatMap((c, i) => (c.verb === 'manifest fetch' && c.args.at(-1).endsWith('state:latest') ? [i] : []));
    const tagAt = reg.calls.findIndex((c) => c.verb === 'tag' && c.args.at(-1) === 'latest');
    assert.ok(latestReads.filter((i) => i < v.indexOf('copy')).length >= 2, v.join(' '));
    assert.ok(
      latestReads.some((i) => i > v.indexOf('copy') && i < tagAt),
      v.join(' '),
    );
  }));

test('move: a state equal to the live one but for updated is unchanged, and nothing is written', () =>
  inRegistry(async (reg, tmp) => {
    assert.equal((await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T08:30:12Z', 2)), '--expect', 'none'], { reg })).code, EXIT.ok);
    const live = digestAt(reg, 'latest');
    const copies = verbs(reg).filter((v) => v === 'copy').length;
    const r = await call(main, ['state', '--file', writeState(tmp, { ...stateAt('2026-10-30T08:30:12Z', 2), updated: '2026-10-30T08:45:00Z' }, 'again.json'), '--expect', live], { reg });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out, [`live state:latest ${live}`, `unchanged state:latest ${live}`]);
    assert.equal(verbs(reg).filter((v) => v === 'copy').length, copies);
    // A state that differs in a cursor is not the live one: it moves.
    const other = await call(main, ['state', '--file', writeState(tmp, { ...stateAt('2026-10-30T08:30:12Z', 3), updated: '2026-10-30T08:50:00Z' }, 'other.json'), '--expect', live], { reg });
    assert.equal(other.code, EXIT.ok, other.text);
    assert.ok(
      other.out.some((l) => /^moved state:latest sha256:[0-9a-f]{64} -> sha256:/.test(l)),
      other.text,
    );
  }));

test('move: a planted second writer refuses move.mjs state, and latest is left as that writer left it with nothing tagged', () =>
  inRegistry(async (reg, tmp) => {
    assert.equal((await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T08:00:00Z', 1)), '--expect', 'none'], { reg })).code, EXIT.ok);
    const live = digestAt(reg, 'latest');
    const theirs = reg.seed('state', null, TYPE, {}, [{ title: 'state.json', bytes: encodeState(stateAt('2026-10-30T08:10:00Z', 5)) }]);
    for (const n of [1, 3]) {
      // The n-th read of latest with the token in this run: 1 is before the push, 3 before the move.
      let fetches = 0;
      reg.hooks.beforeFetch = (key) => {
        if (key !== 'state:latest') return;
        fetches += 1;
        if (fetches === n) reg.w.manifests.set('state:latest', reg.w.manifests.get(`state:${theirs}`));
      };
      const tags = verbs(reg).filter((v) => v === 'tag').length;
      const r = await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T08:20:00Z', 3), `n${n}.json`), '--expect', live], { reg });
      assert.equal(r.code, EXIT.fault, r.text);
      assert.equal(r.out.at(-1), `refused state:latest holds ${theirs}, and this run read ${live}: another writer moved it. The live one is kept`);
      assert.equal(digestAt(reg, 'latest'), theirs);
      assert.equal(verbs(reg).filter((v) => v === 'tag').length, tags, 'nothing tagged');
      if (n === 1) assert.equal(reg.w.manifests.has(`state:${stateRunTag('2026-10-30T08:20:00Z')}`), false, 'refused before the push');
      reg.w.manifests.set('state:latest', reg.w.manifests.get(`state:${live}`));
      reg.hooks.beforeFetch = undefined;
    }
  }));

test('move: an oras tag that fails while latest still holds the digest this run read is tried again, and latest moves', () =>
  inRegistry(async (reg, tmp) => {
    assert.equal((await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T08:00:00Z', 1)), '--expect', 'none'], { reg })).code, EXIT.ok);
    const live = digestAt(reg, 'latest');
    let fails = 0;
    const flaky = async (args, opts) => {
      if (args[0] === 'tag' && args.at(-1) === 'latest' && fails === 0) {
        fails += 1;
        return { code: 1, stdout: '', stderr: 'Error: 502 Bad Gateway\n' };
      }
      return reg.oras(args, opts);
    };
    const r = await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T08:10:00Z', 2), 'b.json'), '--expect', live], { reg, extra: { oras: flaky } });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(fails, 1);
    assert.match(r.text, /^move: oras tag state-20261030t081000z as latest: attempt 1 of \d+ failed \(exit 1\): Error: 502 Bad Gateway; again in \d+ s$/m);
    const moved = digestAt(reg, stateRunTag('2026-10-30T08:10:00Z'));
    assert.ok(r.out.includes(`moved state:latest ${live} -> ${moved}, read back with no credential`), r.text);
    assert.equal(digestAt(reg, 'latest'), moved);
  }));

test('move: the day snapshot is the first state moved that day, and a later move leaves it', () =>
  inRegistry(async (reg, tmp) => {
    assert.equal((await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T00:05:00Z', 1)), '--expect', 'none'], { reg })).code, EXIT.ok);
    const first = digestAt(reg, 'latest');
    const r = await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T23:55:00Z', 2), 'b.json'), '--expect', first], { reg });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out.at(-1), 'snapshot state:state-20261030 present');
    assert.equal(digestAt(reg, 'state-20261030'), first);
    const next = await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-31T00:00:01Z', 3), 'c.json'), '--expect', digestAt(reg, 'latest')], { reg });
    assert.equal(next.out.at(-1), `snapshot state:state-20261031 ${digestAt(reg, 'latest')}`);
  }));

test('move: --onto starts the empty delta of the filter when none is live, expected none', () =>
  inRegistry(async (reg, tmp) => {
    const f = filterOf('2026-10-29', ['com.alpha-synthetic']);
    const file = join(tmp, 'filter.dlbf');
    writeFileSync(file, f.encode());
    const r = await call(main, ['ledger-delta', '--onto', file], { reg, now: '2026-10-30T02:00:07Z' });
    assert.equal(r.code, EXIT.ok, r.text);
    const run = ledgerDeltaRunTag('2026-10-30T02:00:07Z');
    assert.deepEqual(r.out.slice(0, 2), ['live state:ledger-delta none', 'started state:ledger-delta empty, paired with state:ledger-filter-20261029']);
    assert.match(r.out[2], new RegExp(`^pushed \\S+/state:${run} sha256:`));
    const d = HashDelta.decode(layerAt(reg, 'ledger-delta'));
    assert.deepEqual([d.size, d.filterAsOf, d.filterCrc], [0, f.asOf, f.crc]);
    const annotations = JSON.parse(reg.w.manifests.get('state:ledger-delta')).annotations;
    assert.equal(annotations['dev.pkgforge.domains.filter'], 'ledger-filter-20261029');
    // The run object names the hash of its delta's bytes.
    assert.equal(annotations['dev.pkgforge.domains.sha256'], sha(layerAt(reg, 'ledger-delta')).slice(7));
  }));

test('move: --onto leaves a delta that pairs with the filter, rebases one of an older filter, and refuses one of a newer filter', () =>
  inRegistry(async (reg, tmp) => {
    const older = filterOf('2026-10-28', ['com.alpha-synthetic']);
    const newer = filterOf('2026-10-29', ['com.alpha-synthetic', 'com.beta-synthetic']);
    const file = join(tmp, 'filter.dlbf');
    writeFileSync(file, newer.encode());
    // Paired already: present, nothing written.
    const paired = seedDelta(reg, HashDelta.empty(newer), 'ledger-filter-20261029');
    const p = await call(main, ['ledger-delta', '--onto', file], { reg });
    assert.equal(p.code, EXIT.ok, p.text);
    assert.equal(p.out.at(-1), `present state:ledger-delta ${paired}: it pairs with state:ledger-filter-20261029 already`);
    assert.equal(
      verbs(reg).some((v) => v === 'copy'),
      false,
    );
    // An older filter's delta: the hashes the newer filter holds leave it.
    const old = HashDelta.empty(older);
    for (const k of ['com.beta-synthetic', 'net.gamma-synthetic']) old.add(hashKey(k));
    const live = seedDelta(reg, old, 'ledger-filter-20261028');
    const r = await call(main, ['ledger-delta', '--onto', file], { reg });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out[0], `live state:ledger-delta ${live}`);
    assert.equal(r.out[1], 'rebased state:ledger-delta 2 to 1 hash(es) onto state:ledger-filter-20261029');
    assert.match(r.out.at(-1), new RegExp(`^moved state:ledger-delta ${live} -> sha256:[0-9a-f]{64}, read back with no credential$`));
    const d = HashDelta.decode(layerAt(reg, 'ledger-delta'));
    assert.deepEqual([d.size, d.filterAsOf, d.has(hashKey('net.gamma-synthetic'))], [1, newer.asOf, true]);
    // The newer filter's delta onto the older filter: refused, the live delta kept.
    const olderFile = join(tmp, 'older.dlbf');
    writeFileSync(olderFile, older.encode());
    const held = digestAt(reg, 'ledger-delta');
    const back = await call(main, ['ledger-delta', '--onto', olderFile], { reg });
    assert.equal(back.code, EXIT.fault, back.text);
    assert.match(back.out.at(-1), /^refused state:ledger-delta sha256:[0-9a-f]{64} pairs with the filter of as_of \d+, and state:ledger-filter-20261028 is as_of \d+/);
    assert.equal(digestAt(reg, 'ledger-delta'), held);
  }));

test('move: ledger-delta --file is unchanged on the same bytes and moves to other bytes under the guard', () =>
  inRegistry(async (reg, tmp) => {
    const f = filterOf('2026-10-29');
    const d = HashDelta.empty(f);
    const live = seedDelta(reg, d, 'ledger-filter-20261029');
    const same = join(tmp, 'same.dlbd');
    writeFileSync(same, d.encode());
    const u = await call(main, ['ledger-delta', '--file', same, '--expect', live, '--filter', 'ledger-filter-20261029'], { reg });
    assert.equal(u.code, EXIT.ok, u.text);
    assert.equal(u.out.at(-1), `unchanged state:ledger-delta ${live}`);
    d.add(hashKey('com.delta-synthetic'));
    const other = join(tmp, 'other.dlbd');
    writeFileSync(other, d.encode());
    const stale = await call(main, ['ledger-delta', '--file', other, '--expect', `sha256:${'0'.repeat(64)}`, '--filter', 'ledger-filter-20261029'], { reg });
    assert.equal(stale.code, EXIT.fault);
    assert.match(stale.out.at(-1), /^refused state:ledger-delta holds sha256:[0-9a-f]{64}, and this run read sha256:0{64}/);
    const m = await call(main, ['ledger-delta', '--file', other, '--expect', live, '--filter', 'ledger-filter-20261029'], { reg });
    assert.equal(m.code, EXIT.ok, m.text);
    assert.deepEqual(layerAt(reg, 'ledger-delta'), new Uint8Array(readFileSync(other)));
  }));

test('move: no token, an --expect that is not a digest, a file that does not parse and a bad verb are exit 2', () =>
  inRegistry(async (reg, tmp) => {
    const file = writeState(tmp, stateAt('2026-10-30T08:00:00Z', 1));
    const none = await call(main, ['state', '--file', file, '--expect', 'none'], { reg, env: { GITHUB_ACTOR: 'a' } });
    assert.equal(none.code, EXIT.usage);
    assert.match(none.text, /REGISTRY_TOKEN .+ and GITHUB_ACTOR are needed/);
    const bad = join(tmp, 'bad.json');
    writeFileSync(bad, '{"format":"domains.state.v1"}');
    for (const argv of [
      ['state', '--file', file, '--expect', 'sha256:x'],
      ['state', '--file', bad, '--expect', 'none'],
      ['state', '--file', file],
      ['root', '--file', file, '--expect', 'none'],
      ['ledger-delta', '--file', file, '--expect', 'none', '--filter', 'ledger-filter-20261029'],
      ['ledger-delta', '--file', file, '--expect', 'none', '--filter', 'filter-20261029'],
      ['ledger-delta', '--onto', file],
    ]) {
      assert.equal((await call(main, argv, { reg })).code, EXIT.usage, argv.join(' '));
    }
    assert.deepEqual(
      verbs(reg).filter((v) => v !== 'login'),
      [],
      'nothing read or written but logins',
    );
  }));

test('move: a state older than the live one is refused, the live one kept: a state never moves back', () =>
  inRegistry(async (reg, tmp) => {
    assert.equal((await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T08:30:12Z', 9)), '--expect', 'none'], { reg })).code, EXIT.ok);
    const live = digestAt(reg, 'latest');
    const r = await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-29T08:30:12Z', 2), 'old.json'), '--expect', live], { reg });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.out.at(-1), /^refused state:latest sha256:[0-9a-f]{64} is the state of 2026-10-30T08:30:12Z, and .*old\.json is of 2026-10-29T08:30:12Z: a state never moves back/);
    assert.equal(digestAt(reg, 'latest'), live);
    assert.equal(digestAt(reg, 'state-20261029'), null, 'no snapshot of the older day');
    assert.equal(reg.w.manifests.has(`state:${stateRunTag('2026-10-29T08:30:12Z')}`), false, 'nothing pushed');
  }));

test('move: ledger-delta --file never moves back to an older filter, and --filter is the filter of the delta itself', () =>
  inRegistry(async (reg, tmp) => {
    const older = filterOf('2026-10-28');
    const newer = filterOf('2026-10-29');
    const live = seedDelta(reg, HashDelta.empty(newer), 'ledger-filter-20261029');
    const back = join(tmp, 'back.dlbd');
    writeFileSync(back, HashDelta.empty(older).encode());
    const r = await call(main, ['ledger-delta', '--file', back, '--expect', live, '--filter', 'ledger-filter-20261028'], { reg });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(
      r.out.at(-1),
      /^refused state:ledger-delta sha256:[0-9a-f]{64} pairs with the filter of as_of \d+, and .*back\.dlbd with the filter of as_of \d+: a delta never moves back to an older filter/,
    );
    assert.equal(digestAt(reg, 'ledger-delta'), live);
    // Another filter of the live delta's own as_of is refused too.
    const twin = BloomFilter.forKeys(20, { asOf: newer.asOf });
    twin.add(hashKey('com.other-synthetic'));
    const same = join(tmp, 'same.dlbd');
    writeFileSync(same, HashDelta.empty(twin).encode());
    const s = await call(main, ['ledger-delta', '--file', same, '--expect', live, '--filter', 'ledger-filter-20261029'], { reg });
    assert.equal(s.code, EXIT.fault, s.text);
    assert.match(s.out.at(-1), /nor to another filter of its own as_of/);
    // The annotation names the delta's own filter: any other --filter is exit 2, before anything is read.
    const fwd = join(tmp, 'fwd.dlbd');
    writeFileSync(fwd, HashDelta.empty(newer).encode());
    const calls = reg.calls.length;
    const f = await call(main, ['ledger-delta', '--file', fwd, '--expect', live, '--filter', 'ledger-filter-20990101'], { reg });
    assert.equal(f.code, EXIT.usage, f.text);
    assert.match(f.text, /--filter ledger-filter-20990101 is not the filter .*fwd\.dlbd pairs with, which is ledger-filter-20261029/);
    assert.equal(reg.calls.length, calls);
  }));

test('move: the read back of a moved tag with no credential: another digest is exit 1, not public yet is read again, never public is exit 4', () =>
  inRegistry(async (reg, tmp) => {
    const base = reg.w.intercept;
    const latest = (url, init) => init.method !== 'HEAD' && url.endsWith('/state/manifests/latest');
    // Another manifest under latest when it is read back.
    const other = reg.seed('state', null, TYPE, {}, [{ title: 'state.json', bytes: encodeState(stateAt('2026-10-30T07:00:00Z', 1)) }]);
    reg.w.intercept = (url, init) => (latest(url, init) ? base(url.replace(/latest$/, other), init) : base(url, init));
    const a = await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T08:00:00Z', 1), 'a.json'), '--expect', 'none'], { reg });
    assert.equal(a.code, EXIT.fault, a.text);
    assert.match(a.text, new RegExp(`move: FAIL .*state:latest reads as ${other} with no credential, not sha256:[0-9a-f]{64}`));
    // Not public for the first two reads, then public: moved, after two pauses.
    reg.w.intercept = base;
    reg.w.manifests.delete('state:latest');
    let misses = 0;
    reg.w.intercept = (url, init) => (latest(url, init) && ++misses <= 2 ? reg.w.response(404, '{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', {}, { url }) : base(url, init));
    const b = await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T08:10:00Z', 2), 'b.json'), '--expect', 'none'], { reg });
    assert.equal(b.code, EXIT.ok, b.text);
    assert.equal(b.err.filter((l) => /the anonymous read of state:latest: .*again in 10 s/.test(l)).length, 2, b.text);
    // Never public: PRIVATE PACKAGE, exit 4.
    const moved = digestAt(reg, 'latest');
    reg.w.intercept = (url, init) => (latest(url, init) ? reg.w.response(404, '{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', {}, { url }) : base(url, init));
    const c = await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T08:20:00Z', 3), 'c.json'), '--expect', moved], { reg });
    assert.equal(c.code, EXIT.private, c.text);
    assert.ok(c.out.includes('PRIVATE PACKAGE'), c.text);
    assert.match(c.text, /state:latest did not read with no credential after 3 attempts/);
    reg.w.intercept = base;
  }));

test('move: a run tag that holds another manifest is exit 1, a run object that is not public is exit 4, a live delta that is no delta exit 1', () =>
  inRegistry(async (reg, tmp) => {
    const next = stateAt('2026-10-30T08:00:00Z', 1);
    // The run tag holds another state already: push.mjs exits 3, and nothing moves.
    reg.seed('state', stateRunTag(next.updated), TYPE, {}, [{ title: 'state.json', bytes: encodeState(stateAt('2026-10-30T08:00:00Z', 7)) }]);
    const a = await call(main, ['state', '--file', writeState(tmp, next, 'a.json'), '--expect', 'none'], { reg });
    assert.equal(a.code, EXIT.fault, a.text);
    assert.match(a.text, /move: FAIL scripts\/ghcr\/push\.mjs exited 3 for state:state-20261030t080000z/);
    assert.equal(digestAt(reg, 'latest'), null);
    // The pushed run object does not read with no credential: push.mjs exits 4, and so does the move.
    const base = reg.w.intercept;
    reg.w.intercept = (url, init) =>
      /\/state\/manifests\/(sha256:|state-20261030t081000z)/.test(url) ? reg.w.response(404, '{"errors":[{"code":"MANIFEST_UNKNOWN"}]}', {}, { url }) : base(url, init);
    const b = await call(main, ['state', '--file', writeState(tmp, stateAt('2026-10-30T08:10:00Z', 2), 'b.json'), '--expect', 'none'], { reg });
    assert.equal(b.code, EXIT.private, b.text);
    assert.match(b.text, /move: FAIL scripts\/ghcr\/push\.mjs exited 4 for state:state-20261030t081000z/);
    assert.equal(digestAt(reg, 'latest'), null);
    reg.w.intercept = base;
    // A live ledger-delta whose layer is no delta: exit 1, nothing moved.
    const bytes = new TextEncoder().encode('not a delta');
    const live = reg.seed('state', 'ledger-delta', TYPE, { 'dev.pkgforge.domains.sha256': sha(bytes).slice(7) }, [{ title: 'delta.dlbd', bytes }]);
    const file = join(tmp, 'filter.dlbf');
    writeFileSync(file, filterOf('2026-10-29').encode());
    const c = await call(main, ['ledger-delta', '--onto', file], { reg });
    assert.equal(c.code, EXIT.fault, c.text);
    assert.match(c.text, /move: FAIL .* the live ledger-delta does not read as a delta/);
    assert.equal(digestAt(reg, 'ledger-delta'), live);
    // A GHCR error is exit 2, and an error move does not know is 70.
    reg.w.intercept = (url, init) => (url.includes('/state/manifests/ledger-delta') ? reg.w.response(500, 'synthetic outage', {}, { url }) : base(url, init));
    const d = await call(main, ['ledger-delta', '--onto', file], { reg });
    assert.equal(d.code, EXIT.usage, d.text);
    reg.w.intercept = base;
    const e = await call(main, ['ledger-delta', '--onto', file], {
      reg,
      extra: {
        now: () => {
          throw new TypeError('a planted defect');
        },
      },
    });
    assert.equal(e.code, EXIT.internal, e.text);
    assert.match(e.text, /move: internal error: TypeError: a planted defect/);
  }));

test('move: a flag of another verb names itself, a flag given twice and a RUNNER_TEMP that cannot be used are exit 2', () =>
  inRegistry(async (reg, tmp) => {
    const file = writeState(tmp, stateAt('2026-10-30T08:00:00Z', 1));
    const onto = await call(main, ['state', '--onto', file], { reg });
    assert.equal(onto.code, EXIT.usage, onto.text);
    assert.match(onto.text, /^move: state takes no flag --onto$/m);
    // ledger-delta --onto names its form: --expect is a flag of ledger-delta --file.
    const expect = await call(main, ['ledger-delta', '--onto', file, '--expect', 'none'], { reg });
    assert.equal(expect.code, EXIT.usage, expect.text);
    assert.match(expect.text, /^move: ledger-delta --onto takes no flag --expect$/m);
    const twice = await call(main, ['state', '--file', file, '--file', file, '--expect', 'none'], { reg });
    assert.equal(twice.code, EXIT.usage, twice.text);
    assert.match(twice.text, /--file is given twice/);
    const temp = await call(main, ['state', '--file', file, '--expect', 'none'], { reg, extra: { tmp: join(tmp, 'no-such-dir') } });
    assert.equal(temp.code, EXIT.usage, temp.text);
    assert.match(temp.text, /the temporary directory .*no-such-dir \(RUNNER_TEMP\) cannot be used/);
    assert.deepEqual(reg.calls, []);
  }));

test('move: --onto refuses another filter of the live delta own as_of, and leaves the delta of the same filter present', () =>
  inRegistry(async (reg, tmp) => {
    const f = filterOf('2026-10-29', ['com.alpha-synthetic']);
    const live = seedDelta(reg, HashDelta.empty(f), 'ledger-filter-20261029');
    // Another filter of the same as_of: another crc.
    const twin = filterOf('2026-10-29', ['com.alpha-synthetic', 'com.beta-synthetic', 'net.gamma-synthetic']);
    assert.equal(twin.asOf, f.asOf);
    assert.notEqual(twin.crc, f.crc);
    const file = join(tmp, 'twin.dlbf');
    writeFileSync(file, twin.encode());
    const r = await call(main, ['ledger-delta', '--onto', file], { reg });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(
      r.out.at(-1),
      /^refused state:ledger-delta sha256:[0-9a-f]{64} pairs with the filter of as_of \d+, and state:ledger-filter-20261029 is as_of \d+: a delta never moves back to an older filter, nor to another filter of its own as_of$/,
    );
    assert.equal(digestAt(reg, 'ledger-delta'), live);
  }));
