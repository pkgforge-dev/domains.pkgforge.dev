// scripts/ingest/run.mjs and its disk writer: one adapter run, verified and
// pushed, and its cursor proposal
// (D10 to D12, D17 to D19 and D21 to D23 of DOM-024). The two synthetic fixture
// adapters of scripts/ingest/fixtures/ are held to the adapter contract by
// runAdapter of @domains/adapter (the harness), then run by run.mjs against the
// GHCR double of scripts/root/fixture.mjs: packages/ghcr's reader runs its
// production dial on the world's fetch, push.mjs runs in process with the
// double's oras, and no test reaches the network. A planted adapter is a copy
// of a fixture with one fault put in, in a temporary directory.
//
//   node scripts/test.mjs scripts/ingest --name run
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRegistry, ContractError, renderRegistry, runAdapter, validateBits, validateSourceFile } from '@domains/adapter';
import { readRecordings } from '@domains/adapter/node';
import { ANNOTATION_MAX_CHARS } from '@domains/compact';
import { emptyState, parseProposal, proposalFile } from '@domains/state';
import { ANNOTATION_MAX_CHARS as PUSH_ANNOTATION_MAX_CHARS } from '../ghcr/push.mjs';
import { sha } from '../root/fixture.mjs';
import { BITS } from '../verify-pack.mjs';
import { ADAPTERS, call, copied, inRegistry, inTmp, LANES_FILE, PSL, PSL_FILE, RECORDINGS, SOURCES, seedRoot, stateFile } from './fixture.mjs';
import { EXIT, main } from './run.mjs';
import { diskWriter, RAW_PART_BYTES, WriteFault, writeRaw } from './writer.mjs';

const SCRIPT = fileURLToPath(new URL('./run.mjs', import.meta.url));
const NOW = '2026-10-30T08:35:00Z';
const RUN = '40000000001';
const bits = () => validateBits(JSON.parse(readFileSync(BITS, 'utf8')));
const sourcesOf = (adapter, dir = ADAPTERS) => validateSourceFile(JSON.parse(readFileSync(join(dir, adapter, 'source.json'), 'utf8')), bits()).sources;
const argsOf = (adapter, out, more = [], adapters = ADAPTERS, now = NOW) => [
  '--adapter',
  adapter,
  '--out',
  out,
  '--adapters',
  adapters,
  '--sources',
  SOURCES,
  '--recordings',
  RECORDINGS(adapter),
  '--now',
  now,
  '--run',
  RUN,
  ...more,
];
const W0 = ['2026-10-30T08:00:00Z', '2026-10-30T08:10:00Z'];
const W1 = ['2026-10-30T08:10:00Z', '2026-10-30T08:20:00Z'];
const SEG0 = 'oi-cs.20261030t080000z.20261030t081000z';
const SEG1 = 'oi-cs.20261030t081000z.20261030t082000z';
const proposalAt = (out, adapter) => join(out, 'proposals', proposalFile(adapter));
const digestOf = (reg, tag) => sha(reg.w.manifests.get(`obs:${tag}`));
const manifestOf = (reg, tag) => JSON.parse(reg.w.manifests.get(`obs:${tag}`));

// A copy of the fixture `adapter` in `tmp` with `from` replaced by `to` in its
// module: the adapters directory. Each copy has a path of its own, since a
// module is imported once a path.
let plantedCopies = 0;
function planted(tmp, adapter, from, to) {
  const dir = join(tmp, `planted-${++plantedCopies}`);
  cpSync(join(ADAPTERS, adapter), join(dir, adapter), { recursive: true });
  const src = join(dir, adapter, 'src', 'index.ts');
  const text = readFileSync(src, 'utf8');
  assert.ok(text.includes(from), `the fixture holds ${from}`);
  writeFileSync(src, text.replace(from, to));
  return dir;
}

// A state of the file fixture whose history of isc-new is seven accepted days of `count` bytes.
function historyState(tmp, count) {
  const days = ['21', '22', '23', '24', '25', '26', '27'].map((d) => ({ day: `2026-10-${d}`, count, quarantined: false }));
  return stateFile(tmp, { ...emptyState('2026-10-28T00:00:00Z'), history: { 'isc-new': days } });
}

test('run: each fixture adapter keeps the adapter contract under the harness, and the fixture registry is their build', async () => {
  const stream = await import(pathToFileURL(join(ADAPTERS, 'fixture-stream', 'src', 'index.ts')).href);
  const s = await runAdapter(stream, { recordings: readRecordings(RECORDINGS('fixture-stream')), cursor: null, now: NOW, sources: sourcesOf('fixture-stream') });
  assert.deepEqual(
    s.first.result.segments.map((x) => [x.dataset, x.window.start]),
    [
      ['names', W0[0]],
      ['domains', W0[0]],
      ['names', W1[0]],
      ['domains', W1[0]],
    ],
  );
  assert.deepEqual(s.first.result.cursor, { next: 2 });
  assert.deepEqual(s.next.result.segments, []);
  const file = await import(pathToFileURL(join(ADAPTERS, 'fixture-file', 'src', 'index.ts')).href);
  const f = await runAdapter(file, { recordings: readRecordings(RECORDINGS('fixture-file')), cursor: null, now: NOW, sources: sourcesOf('fixture-file') });
  assert.deepEqual(
    f.first.result.segments.map((x) => [x.window.start, x.raw.bytes]),
    [
      ['2026-10-28T00:00:00Z', 79],
      ['2026-10-29T00:00:00Z', 42],
    ],
  );
  assert.deepEqual(f.first.result.cursor, { last_day: '2026-10-29' });
  assert.deepEqual(f.next.result.segments, []);
  const files = ['fixture-file', 'fixture-stream'].map((a) => ({ adapter: a, text: readFileSync(join(ADAPTERS, a, 'source.json'), 'utf8') }));
  assert.equal(renderRegistry(buildRegistry(files, bits())), readFileSync(SOURCES, 'utf8'));
});

test('run: a live run with no state pushes each raw object before its segments and writes the proposal of the run', () =>
  inRegistry(async (reg, tmp) => {
    const { digest: rootDigest } = seedRoot(reg);
    const out = join(tmp, 'out');
    const r = await call(main, argsOf('fixture-stream', out, ['--lane', 'kafka', '--lanes', LANES_FILE, '--psl', 'root']), { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    // D21 of DOM-024: state:latest reads as absent with no credential, and with the token too: the first state.
    assert.equal(r.out[0], 'cursor fixture-stream none (state:latest none)');
    assert.equal(r.out[1], `psl ${PSL} (root:latest ${rootDigest})`);
    assert.deepEqual(
      r.out.filter((l) => l.startsWith('segment ')),
      [
        `segment obs:${SEG0} oi-cs names ${W0.join(' ')} records 4 verdict ok`,
        `segment obs:${SEG0}-d oi-cs domains ${W0.join(' ')} records 3 verdict ok`,
        `segment obs:${SEG1} oi-cs names ${W1.join(' ')} records 2 verdict ok`,
        `segment obs:${SEG1}-d oi-cs domains ${W1.join(' ')} records 2 verdict ok`,
      ],
    );
    assert.ok(r.out.includes(`raw obs:raw-${SEG0} oi-cs ${W0.join(' ')} bytes 106 members 1`), r.text);
    // The raw lane objects first, then the segments (D10 of DOM-024).
    assert.deepEqual(copied(reg), [`raw-${SEG0}`, `raw-${SEG1}`, SEG0, `${SEG0}-d`, SEG1, `${SEG1}-d`]);
    assert.equal(r.out.filter((l) => l.startsWith('pushed ghcr.io/pkgforge-dev/domains.pkgforge.dev/obs:')).length, 6);
    // A segment's manifest: a segment of tier seg, and the annotations that
    // D12 of DOM-024 names.
    const m = manifestOf(reg, `${SEG0}-d`);
    assert.equal(m.artifactType, 'application/vnd.pkgforge.domains.segment.v1');
    const a = m.annotations;
    assert.deepEqual(
      [
        a['dev.pkgforge.domains.tier'],
        a['dev.pkgforge.domains.dataset'],
        a['dev.pkgforge.domains.source'],
        a['dev.pkgforge.domains.precision'],
        a['dev.pkgforge.domains.adapter'],
        a['dev.pkgforge.domains.parser'],
        a['dev.pkgforge.domains.cursor.before'],
        a['dev.pkgforge.domains.cursor.after'],
        a['dev.pkgforge.domains.url'],
        a['dev.pkgforge.domains.fetched'],
        a['dev.pkgforge.domains.raw'],
        a['dev.pkgforge.domains.run'],
        a['dev.pkgforge.domains.psl'],
        a['org.opencontainers.image.created'],
      ],
      ['seg', 'domains', 'oi-cs', 'second', 'fixture-stream', 'fixture-stream/1', '{"next":0}', '{"next":1}', 'https://stream.example.test/window/', NOW, `raw-${SEG0}`, RUN, PSL, W0[1]],
    );
    assert.equal(Object.hasOwn(a, 'dev.pkgforge.domains.quarantine'), false);
    // The raw lane object: raw.000 and members.json, the hash of the bytes.
    const raw = manifestOf(reg, `raw-${SEG0}`);
    assert.equal(raw.artifactType, 'application/vnd.pkgforge.domains.raw.v1');
    assert.deepEqual(
      raw.layers.map((l) => l.annotations['org.opencontainers.image.title']),
      ['raw.000', 'members.json'],
    );
    const body = readFileSync(join(RECORDINGS('fixture-stream'), 'window-0.http.json'), 'utf8');
    const bytes = Buffer.from(JSON.parse(body).response.body_base64, 'base64');
    assert.equal(raw.annotations['dev.pkgforge.domains.sha256'], sha(bytes).slice(7));
    assert.equal(raw.layers[0].digest, sha(bytes));
    const members = JSON.parse(new TextDecoder().decode(reg.bytes.get(raw.layers[1].digest)));
    assert.deepEqual(members, { end: W0[1], format: 'domains.raw-members.v1', members: [{ length: bytes.length, offset: 0, sha256: sha(bytes).slice(7) }], source: 'oi-cs', start: W0[0] });
    // The proposal of section 2.4: each digest the one its tag holds.
    const p = parseProposal(readFileSync(proposalAt(out, 'fixture-stream')));
    const seg = (tag, dataset, w, count) => ({ ref: `obs:${tag}`, digest: digestOf(reg, tag), source: 'oi-cs', dataset, start: w[0], end: w[1], count, quarantined: false });
    assert.deepEqual(p, {
      format: 'domains.proposal.v1',
      adapter: 'fixture-stream',
      lane: 'kafka',
      run: RUN,
      attempt: 1,
      at: NOW,
      before: null,
      after: { next: 2 },
      segments: [seg(SEG0, 'names', W0, 4), seg(`${SEG0}-d`, 'domains', W0, 3), seg(SEG1, 'names', W1, 2), seg(`${SEG1}-d`, 'domains', W1, 2)],
      raw: [
        { ref: `obs:raw-${SEG0}`, digest: digestOf(reg, `raw-${SEG0}`), source: 'oi-cs', start: W0[0], end: W0[1] },
        { ref: `obs:raw-${SEG1}`, digest: digestOf(reg, `raw-${SEG1}`), source: 'oi-cs', start: W1[0], end: W1[1] },
      ],
      history: [],
    });
    assert.equal(r.out.at(-1), `proposal ${proposalAt(out, 'fixture-stream')} segments 4 raw 2 history 0 cursor moved`);
    // The token reached oras on stdin, in the logins alone.
    for (const c of reg.calls) assert.equal(c.input !== '', c.verb === 'login', c.verb);

    // A re-run with the same inputs finds every tag present and writes the same proposal.
    const copies = copied(reg).length;
    const again = join(tmp, 'again');
    const r2 = await call(main, argsOf('fixture-stream', again, ['--lane', 'kafka', '--lanes', LANES_FILE, '--psl', 'root']), { reg, now: NOW });
    assert.equal(r2.code, EXIT.ok, r2.text);
    assert.equal(r2.out.filter((l) => /^present ghcr\.io\/\S+\/obs:\S+ sha256:[0-9a-f]{64} \(/.test(l)).length, 6, r2.text);
    assert.equal(copied(reg).length, copies, 'no copy on a re-run');
    assert.deepEqual(readFileSync(proposalAt(again, 'fixture-stream')), readFileSync(proposalAt(out, 'fixture-stream')));
  }));

test('run: a quarantine verdict pushes the segment with dev.pkgforge.domains.quarantine=1 and proposes it quarantined', () =>
  inRegistry(async (reg, tmp) => {
    const state = historyState(tmp, 200);
    const out = join(tmp, 'out');
    const r = await call(main, argsOf('fixture-file', out, ['--state', state, '--psl', PSL_FILE]), { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out[0], `cursor fixture-file none (${state})`);
    assert.deepEqual(
      r.out.filter((l) => l.startsWith('segment ')).map((l) => l.split(' ').at(-1)),
      ['quarantine', 'quarantine'],
    );
    const p = parseProposal(readFileSync(proposalAt(out, 'fixture-file')));
    assert.deepEqual(
      p.segments.map((s) => [s.ref.replace(/\.[0-9a-f]{12}-d$/, ''), s.quarantined]),
      [
        ['obs:isc-new.20261028', true],
        ['obs:isc-new.20261029', true],
      ],
    );
    assert.deepEqual(p.history, [
      { source: 'isc-new', day: '2026-10-28', count: 79, quarantined: true },
      { source: 'isc-new', day: '2026-10-29', count: 42, quarantined: true },
    ]);
    for (const s of p.segments) {
      const m = manifestOf(reg, s.ref.slice(4));
      assert.equal(m.annotations['dev.pkgforge.domains.quarantine'], '1');
      // A file source keeps its file in the segment's own layer raw
      // (D10 of DOM-024).
      assert.equal(m.layers.at(-1).annotations['org.opencontainers.image.title'], 'raw');
    }
    // No raw lane object for a file source.
    assert.equal(
      copied(reg).some((t) => t.startsWith('raw-')),
      false,
    );
  }));

test('run: a hold verdict pushes nothing, writes no proposal and exits 1', () =>
  inRegistry(async (reg, tmp) => {
    const state = historyState(tmp, 20);
    const out = join(tmp, 'out');
    const r = await call(main, argsOf('fixture-file', out, ['--state', state, '--psl', PSL_FILE]), { reg, now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /^segment obs:isc-new\.20261028\.[0-9a-f]{12}-d isc-new domains \S+ \S+ records 3 verdict hold$/m);
    assert.match(r.text, /verdict ok$/m);
    assert.match(r.text, /nothing of this adapter run is pushed, and no proposal is written \(D18 of DOM-024\)/);
    assert.deepEqual(reg.calls, [], 'no oras call: nothing pushed, no login');
    assert.equal(existsSync(join(out, 'proposals')), false);
  }));

test('run: a second-precision window across an hour edge and a second segment under one tag are refused, nothing pushed', () =>
  inRegistry(async (reg, tmp) => {
    const late = '2026-10-30T09:35:00Z';
    const straddle = planted(tmp, 'fixture-stream', 'Date.parse("2026-10-30T08:00:00Z")', 'Date.parse("2026-10-30T08:55:00Z")');
    const state = stateFile(tmp, emptyState(NOW));
    const a = await call(main, argsOf('fixture-stream', join(tmp, 'a'), ['--state', state, '--psl', PSL_FILE], straddle, late), { reg, now: late });
    assert.equal(a.code, EXIT.fault, a.text);
    assert.match(a.text, /FAIL straddle: segment "oi-cs": the window 2026-10-30T08:55:00Z to 2026-10-30T09:05:00Z crosses an hour edge/);
    const twice = planted(tmp, 'fixture-stream', 'ctx.writer.write({ ...draft, dataset: "domains" }', 'ctx.writer.write({ ...draft, dataset: "names" }');
    const b = await call(main, argsOf('fixture-stream', join(tmp, 'b'), ['--state', state, '--psl', PSL_FILE], twice), { reg, now: NOW });
    assert.equal(b.code, EXIT.fault, b.text);
    assert.match(b.text, /FAIL tag: segment "oi-cs" names 2026-10-30T08:00:00Z to 2026-10-30T08:10:00Z: a segment of this source, window and dataset was written already in this run/);
    assert.deepEqual(reg.calls, []);
  }));

test('run: the writer refuses a dataset with no tag, another raw input of one window, and a file over its one layer', () =>
  inTmp(async (tmp) => {
    const row = { id: 'oi-cs', precision: 'second', datasets: ['names', 'domains', 'feed'], parser: 'x/1', urls: ['https://stream.example.test/'] };
    const w = diskWriter({ dir: join(tmp, 'w'), adapter: 'fixture-stream', sources: [row], psl: PSL, run: RUN, fetched: NOW });
    mkdirSync(join(tmp, 'w'));
    const draft = { source: 'oi-cs', window: { start: W0[0], end: W0[1] }, cursorBefore: null, cursorAfter: { next: 1 }, precision: 'second' };
    const rec = [{ key: 'com.alpha-synthetic', flags: 0, sources: [{ bit: 4, first: 26_121_600, last: 26_121_600 }], evidence: [] }];
    await assert.rejects(w.write({ ...draft, dataset: 'feed' }, [], undefined), (e) => e instanceof WriteFault && e.code === 'tag');
    await w.write({ ...draft, dataset: 'domains' }, rec, new TextEncoder().encode('first'));
    await assert.rejects(w.write({ ...draft, dataset: 'names' }, [], new TextEncoder().encode('second')), (e) => e instanceof WriteFault && e.code === 'raw');
    await assert.rejects(w.write({ ...draft, source: 'oi-nrd', dataset: 'names' }, [], undefined), (e) => e instanceof ContractError && e.check === 'source');
    // writeRaw streams in parts of at most partBytes; a file source has one.
    async function* chunks() {
      yield new Uint8Array(5).fill(1);
      yield new Uint8Array(7).fill(2);
    }
    const many = await writeRaw(chunks(), join(tmp, 'many'), { maxParts: Number.MAX_SAFE_INTEGER, what: 'raw', partBytes: 4 });
    assert.deepEqual([many.bytes, many.files.length, readdirSync(join(tmp, 'many')).sort()], [12, 3, ['raw.000', 'raw.001', 'raw.002']]);
    await assert.rejects(writeRaw(chunks(), join(tmp, 'one'), { maxParts: 1, what: 'raw', partBytes: 4 }), (e) => e instanceof WriteFault && e.code === 'raw-size');
    assert.equal(RAW_PART_BYTES, 1024 * 1024 * 1024);
  }));

test('run: a cursor whose canonical JSON passes 1024 characters, the longest annotation value packManifest and the push tool take, is WriteFault cursor before anything is written; 1024 is written', () =>
  inTmp(async (tmp) => {
    // One number in the three places: packManifest, the push tool and the writer.
    assert.deepEqual([ANNOTATION_MAX_CHARS, PUSH_ANNOTATION_MAX_CHARS], [1024, 1024]);
    const row = { id: 'oi-cs', precision: 'second', datasets: ['names', 'domains'], parser: 'x/1', urls: ['https://stream.example.test/'] };
    const w = diskWriter({ dir: join(tmp, 'w'), adapter: 'fixture-stream', sources: [row], psl: PSL, run: RUN, fetched: NOW });
    mkdirSync(join(tmp, 'w'));
    const rec = [{ key: 'com.alpha-synthetic', flags: 0, sources: [{ bit: 4, first: 26_121_600, last: 26_121_600 }], evidence: [] }];
    // {"p":"x...x"} is 8 characters around the padding: 1016 of it is 1024 in all.
    const cursorOf = (chars) => ({ p: 'x'.repeat(chars - 8) });
    const draft = { source: 'oi-cs', dataset: 'domains', window: { start: W0[0], end: W0[1] }, cursorBefore: null, cursorAfter: cursorOf(1024), precision: 'second' };
    for (const field of ['cursorBefore', 'cursorAfter']) {
      await assert.rejects(
        w.write({ ...draft, [field]: cursorOf(1025) }, rec, undefined),
        (e) =>
          e instanceof WriteFault &&
          e.code === 'cursor' &&
          e.message.includes(`${field} as canonical JSON is 1025 characters, over 1024; it is the annotation dev.pkgforge.domains.cursor.${field === 'cursorBefore' ? 'before' : 'after'}`),
        field,
      );
    }
    assert.deepEqual(readdirSync(join(tmp, 'w')), [], 'a refused cursor writes nothing');
    await w.write(draft, rec, undefined);
    assert.equal(w.segments[0].manifest.annotations['dev.pkgforge.domains.cursor.after'].length, 1024);
  }));

test('run: an adapter whose cursor passes 1024 characters fails the run with FAIL cursor, exit 1, and pushes nothing', () =>
  inRegistry(async (reg, tmp) => {
    const long = planted(tmp, 'fixture-stream', 'readWindow(next, { next }, { next: next + 1 }, ctx)', 'readWindow(next, { next }, { next: next + 1, pad: "x".repeat(1020) }, ctx)');
    const state = stateFile(tmp, emptyState(NOW));
    const out = join(tmp, 'out');
    const r = await call(main, argsOf('fixture-stream', out, ['--state', state, '--psl', PSL_FILE], long), { reg, now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /FAIL cursor: segment "oi-cs": cursorAfter as canonical JSON is 1039 characters, over 1024; it is the annotation dev\.pkgforge\.domains\.cursor\.after/);
    assert.deepEqual(reg.calls, [], 'no oras call: nothing pushed, no login');
    assert.equal(existsSync(join(out, 'proposals')), false);
  }));

test('run: --no-push verifies, pushes nothing and needs no token; a push with no token is exit 2 before the adapter runs', () =>
  inRegistry(async (reg, tmp) => {
    const state = stateFile(tmp, emptyState(NOW));
    const out = join(tmp, 'out');
    const r = await call(main, argsOf('fixture-stream', out, ['--state', state, '--psl', PSL_FILE, '--no-push']), { reg, now: NOW, env: {} });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out.at(-1), 'no push: --no-push; 4 segment(s) and 2 raw object(s) verified');
    assert.deepEqual(reg.calls, []);
    assert.equal(existsSync(join(out, 'proposals')), false);
    const none = join(tmp, 'none');
    const n = await call(main, argsOf('fixture-stream', none, ['--state', state, '--psl', PSL_FILE]), { reg, now: NOW, env: { GITHUB_ACTOR: 'synthetic-actor' } });
    assert.equal(n.code, EXIT.usage, n.text);
    assert.match(n.text, /a push needs REGISTRY_TOKEN/);
    assert.equal(existsSync(join(none, 'work')), false, 'the adapter did not run');
  }));

test('run: a state that exists and does not read with no credential is exit 4, and so is one no token can tell from absent', () =>
  inRegistry(async (reg, tmp) => {
    // Planted: state:latest exists (the token read finds it) and its anonymous read is refused.
    reg.w.manifests.set('state:latest', JSON.stringify({ schemaVersion: 2 }));
    const base = reg.w.intercept;
    reg.w.intercept = (url, init) => (url.includes('/state/manifests/') ? reg.w.response(404, '{"errors":[{"code":"NAME_UNKNOWN"}]}', {}, { url }) : base(url, init));
    const r = await call(main, argsOf('fixture-stream', join(tmp, 'a'), ['--psl', PSL_FILE]), { reg, now: NOW });
    assert.equal(r.code, EXIT.private, r.text);
    assert.deepEqual(r.out, ['PRIVATE PACKAGE']);
    assert.match(r.text, /state:latest holds sha256:[0-9a-f]{64}, and it does not read with no credential/);
    const local = await call(main, argsOf('fixture-stream', join(tmp, 'b'), ['--psl', PSL_FILE, '--no-push']), { reg, now: NOW, env: {} });
    assert.equal(local.code, EXIT.private, local.text);
    assert.match(local.text, /no token is given to tell an absent state from a private one/);
  }));

test('run: a backfill writes the window it is given and proposes the live cursor as before and after', () =>
  inRegistry(async (reg, tmp) => {
    const live = { ...emptyState(NOW), cursors: { 'fixture-stream': { next: 2 } }, moved: { 'fixture-stream': { at: NOW, run: RUN } } };
    const state = stateFile(tmp, live);
    const out = join(tmp, 'out');
    const r = await call(main, argsOf('fixture-stream', out, ['--state', state, '--psl', PSL_FILE, '--from', W0[0], '--to', W0[1]]), { reg, now: NOW });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out[0], `cursor fixture-stream {"next":2} (${state})`);
    const p = parseProposal(readFileSync(proposalAt(out, 'fixture-stream')));
    assert.deepEqual([p.before, p.after, p.segments.length, p.raw.length], [{ next: 2 }, { next: 2 }, 2, 1]);
    assert.equal(r.out.at(-1), `proposal ${proposalAt(out, 'fixture-stream')} segments 2 raw 1 history 0 cursor kept`);
    // An adapter with no backfill cannot take a window.
    const f = await call(main, argsOf('fixture-file', join(tmp, 'f'), ['--state', state, '--psl', PSL_FILE, '--from', '2026-10-28T00:00:00Z', '--to', '2026-10-29T00:00:00Z']), { reg, now: NOW });
    assert.equal(f.code, EXIT.usage, f.text);
    assert.match(f.text, /exports no backfill function/);
  }));

test("run: the adapter's own faults are printed and make the exit 1 after its proposal is written", () =>
  inRegistry(async (reg, tmp) => {
    const dir = planted(
      tmp,
      'fixture-stream',
      'stats: { windows: segments.length / 2 }, errors: [] };',
      'stats: { windows: segments.length / 2 }, errors: [{ source: SOURCE, code: "planted", detail: "a planted fault" }] };',
    );
    const state = stateFile(tmp, emptyState(NOW));
    const out = join(tmp, 'out');
    const r = await call(main, argsOf('fixture-stream', out, ['--state', state, '--psl', PSL_FILE], dir), { reg, now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.ok(r.out.includes('fault oi-cs planted a planted fault'), r.text);
    assert.ok(existsSync(proposalAt(out, 'fixture-stream')));
  }));

test('run: no such adapter, a registry row unlike its source.json, an adapter outside --lane and a bad flag are exit 2', () =>
  inTmp(async (tmp) => {
    const state = stateFile(tmp, emptyState(NOW));
    const common = ['--state', state, '--psl', PSL_FILE, '--no-push'];
    const absent = await call(main, argsOf('fixture-none', join(tmp, 'a'), common));
    assert.equal(absent.code, EXIT.usage);
    assert.match(absent.text, /no adapter fixture-none/);
    const changed = planted(tmp, 'fixture-stream', 'export const BIT = 4;', 'export const BIT = 4;');
    writeFileSync(join(changed, 'fixture-stream', 'source.json'), readFileSync(join(ADAPTERS, 'fixture-stream', 'source.json'), 'utf8').replace('"cadence": "PT10M"', '"cadence": "PT5M"'));
    const drift = await call(main, argsOf('fixture-stream', join(tmp, 'b'), common, changed));
    assert.equal(drift.code, EXIT.usage);
    assert.match(drift.text, /the registry row of oi-cs is not .+source\.json's/);
    const lane = await call(main, argsOf('fixture-stream', join(tmp, 'c'), [...common, '--lane', 'feeds', '--lanes', LANES_FILE]));
    assert.equal(lane.code, EXIT.usage);
    assert.match(lane.text, /fixture-stream is not in the lane feeds/);
    for (const extra of [
      ['--lane', 'vps'],
      ['--now', '2026-10-30T08:35Z'],
      ['--bogus', 'x'],
      ['--run', 'local'],
    ]) {
      assert.equal((await call(main, argsOf('fixture-stream', join(tmp, 'd'), [...common, ...extra]))).code, EXIT.usage, extra.join(' '));
    }
    assert.equal((await call(main, ['--adapter', 'fixture-stream', '--out', join(tmp, 'e'), '--run', RUN])).code, EXIT.usage, 'no --psl');
  }));

test('run: the production defaults run an adapter from the command line with --no-push', () =>
  inTmp(async (tmp) => {
    const state = stateFile(tmp, emptyState(NOW));
    const r = spawnSync(process.execPath, [SCRIPT, ...argsOf('fixture-file', join(tmp, 'out'), ['--state', state, '--psl', PSL_FILE, '--no-push'])], { encoding: 'utf8' });
    assert.equal(r.status, EXIT.ok, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines[0], `cursor fixture-file none (${state})`);
    assert.equal(lines[1], `psl ${PSL} (${PSL_FILE})`);
    assert.equal(lines.at(-1), 'no push: --no-push; 2 segment(s) and 0 raw object(s) verified');
  }));
