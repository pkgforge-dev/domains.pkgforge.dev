// scripts/ingest/run.mjs at its doors (DOM-024): its arguments, the job's
// token, the adapter module and what it returns, the disk writer, the verdicts,
// the push and a re-run. Each case gives the run one input or one planted fault
// at a door, and holds what the run does with it. The fixtures are the ones of
// run.test.mjs: two synthetic adapters, their recordings and the GHCR double of
// scripts/root/fixture.mjs; a planted adapter is a copy of a fixture with one
// fault put in.
//
//   node scripts/test.mjs scripts/ingest --name run
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyState, parseProposal, proposalFile } from '@domains/state';
import { GhcrError, artifactType } from '@domains/ghcr';
import { main as advanceMain } from '../state/advance.mjs';
import { ACTOR, sha, TOKEN } from '../root/fixture.mjs';
import { main as verifyMain } from '../verify-pack.mjs';
import { ADAPTERS, call, copied, inRegistry, inTmp, PSL_FILE, RECORDINGS, SOURCES, seedRoot, stateFile } from './fixture.mjs';
import { EXIT, main, QUARANTINE, REQUIRE } from './run.mjs';
import { diskWriter, WriteFault, writeRaw } from './writer.mjs';

const NOW = '2026-10-30T08:35:00Z';
const RUN = '40000000001';
const SEG0 = 'oi-cs.20261030t080000z.20261030t081000z';
const PSL = '0232f4df0831911356e8ee1f4d5c3b6b12c0ed3f6bd66b0f81c8ab5d3d49e9ca';
const argsOf = (adapter, out, more = [], adapters = ADAPTERS, now = NOW, run = RUN) => [
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
  run,
  ...more,
];
const proposalAt = (out, adapter) => join(out, 'proposals', proposalFile(adapter));

let copies = 0;
function planted(tmp, adapter, edits, sourceJson = null) {
  const dir = join(tmp, `door-${++copies}`);
  cpSync(join(ADAPTERS, adapter), join(dir, adapter), { recursive: true });
  const src = join(dir, adapter, 'src', 'index.ts');
  let text = readFileSync(src, 'utf8');
  for (const [from, to] of edits) {
    assert.ok(text.includes(from), `the fixture holds ${from}`);
    text = text.replace(from, () => to);
  }
  writeFileSync(src, text);
  if (sourceJson !== null) writeFileSync(join(dir, adapter, 'source.json'), sourceJson);
  return dir;
}

test('run: a re-run of a window under another run and time finds its tags present, proposes the digests they hold, and advance accepts it', () =>
  inRegistry(async (reg, tmp) => {
    seedRoot(reg);
    const state = stateFile(tmp, emptyState('2026-10-30T08:00:00Z'));
    const first = await call(main, argsOf('fixture-stream', join(tmp, 'a'), ['--state', state, '--psl', PSL_FILE]), { reg, now: NOW });
    assert.equal(first.code, EXIT.ok, first.text);
    // Another run, another time: the manifests differ in run and fetched; the sha256 is the same.
    const later = '2026-10-30T08:50:00Z';
    const second = await call(main, argsOf('fixture-stream', join(tmp, 'b'), ['--state', state, '--psl', PSL_FILE], ADAPTERS, later, '40000000002'), { reg, now: later });
    assert.equal(second.code, EXIT.ok, second.text);
    const present = second.out.filter((l) => l.startsWith('present '));
    assert.equal(present.length, 6, second.text);
    for (const l of present) assert.match(l, /\(the same dev\.pkgforge\.domains\.sha256 and layers\)$/);
    const p = parseProposal(readFileSync(proposalAt(join(tmp, 'b'), 'fixture-stream')));
    for (const x of [...p.segments, ...p.raw]) assert.equal(x.digest, sha(reg.w.manifests.get(x.ref)), x.ref);
    // The job push accepts it: each tag holds the digest the proposal names.
    const r = await call(advanceMain, ['--proposals', join(tmp, 'b', 'proposals'), '--out', join(tmp, 'state'), '--now', later, '--run', '40000000002'], { reg, now: later });
    assert.equal(r.code, 0, r.text);
    assert.ok(r.out.includes('accepted fixture-stream segments 4 raw 2 history 0 cursor moved'), r.text);
    assert.ok(!r.out.some((l) => l.startsWith('dropped ')), r.text);
  }));

test('run: a proposal file already in --out stops a push run before the adapter runs, and nothing is pushed', () =>
  inRegistry(async (reg, tmp) => {
    const out = join(tmp, 'out');
    mkdirSync(join(out, 'proposals'), { recursive: true });
    writeFileSync(proposalAt(out, 'fixture-stream'), '{}');
    const state = stateFile(tmp, emptyState(NOW));
    const r = await call(main, argsOf('fixture-stream', out, ['--state', state, '--psl', PSL_FILE]), { reg, now: NOW });
    assert.equal(r.code, EXIT.usage, r.text);
    assert.match(r.text, /proposal\.fixture-stream\.json exists: run writes into a new directory/);
    assert.deepEqual(reg.calls, []);
    assert.equal(readFileSync(proposalAt(out, 'fixture-stream'), 'utf8'), '{}');
    assert.equal(existsSync(join(out, 'work', 'fixture-stream', SEG0)), false, 'the adapter did not run');
  }));

test("run: the job's token leaves process.env before the adapter module runs, and the push still logs in with it", () =>
  inRegistry(async (reg, tmp) => {
    const dir = planted(tmp, 'fixture-stream', [
      [
        'export async function run(cursor: Cursor, ctx: AdapterContext): Promise<RunResult> {',
        'export async function run(cursor: Cursor, ctx: AdapterContext): Promise<RunResult> {\n  (globalThis as Record<string, unknown>).__sawToken = process.env.REGISTRY_TOKEN;',
      ],
    ]);
    const state = stateFile(tmp, emptyState(NOW));
    const saved = { token: process.env.REGISTRY_TOKEN, actor: process.env.GITHUB_ACTOR };
    process.env.REGISTRY_TOKEN = TOKEN;
    process.env.GITHUB_ACTOR = ACTOR;
    try {
      const r = await call(main, argsOf('fixture-stream', join(tmp, 'out'), ['--state', state, '--psl', PSL_FILE], dir), { reg, now: NOW, extra: { env: undefined } });
      assert.equal(r.code, EXIT.ok, r.text);
      assert.equal(globalThis.__sawToken, undefined, 'the module saw REGISTRY_TOKEN');
      assert.equal(process.env.REGISTRY_TOKEN, undefined);
      // The pushes logged in with the token, on stdin.
      assert.ok(reg.calls.some((c) => c.verb === 'login' && c.input === TOKEN));
    } finally {
      delete globalThis.__sawToken;
      if (saved.token === undefined) delete process.env.REGISTRY_TOKEN;
      else process.env.REGISTRY_TOKEN = saved.token;
      if (saved.actor === undefined) delete process.env.GITHUB_ACTOR;
      else process.env.GITHUB_ACTOR = saved.actor;
    }
  }));

test("run: an adapter's fault detail with line breaks is printed on its one line, so no remote text starts a line", () =>
  inRegistry(async (reg, tmp) => {
    const dir = planted(tmp, 'fixture-stream', [
      [
        'errors: [] };\n}\n\nexport async function backfill',
        'errors: [{ source: SOURCE, code: "http", detail: "HTTP 500 body:\\n::error::forged line\\r\\n::add-mask::abc" }] };\n}\n\nexport async function backfill',
      ],
    ]);
    const state = stateFile(tmp, emptyState(NOW));
    const r = await call(main, argsOf('fixture-stream', join(tmp, 'out'), ['--state', state, '--psl', PSL_FILE], dir), { reg, now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.ok(r.out.includes('fault oi-cs http HTTP 500 body:\\n::error::forged line\\r\\n::add-mask::abc'), r.text);
    for (const l of [...r.out, ...r.err.flatMap((e) => e.split('\n'))]) assert.ok(!l.startsWith('::'), l);
  }));

test('run: a cursor returned past 1024 characters is FAIL cursor before anything is pushed, and no proposal is written', () =>
  inRegistry(async (reg, tmp) => {
    // No window has ended at 08:05: the run writes no segment, and returns a long cursor.
    const dir = planted(tmp, 'fixture-stream', [['return { segments, cursor: { next }, stats', 'return { segments, cursor: { next, pad: "x".repeat(2000) }, stats']]);
    const state = stateFile(tmp, emptyState('2026-10-30T08:00:00Z'));
    const out = join(tmp, 'out');
    const r = await call(main, argsOf('fixture-stream', out, ['--state', state, '--psl', PSL_FILE], dir, '2026-10-30T08:05:00Z'), { reg, now: '2026-10-30T08:05:00Z' });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(
      r.text,
      /run: FAIL cursor: fixture-stream: the cursor returned, as canonical JSON, is 2019 characters, over 1024; it is the next run's annotation dev\.pkgforge\.domains\.cursor\.before/,
    );
    assert.equal(existsSync(proposalAt(out, 'fixture-stream')), false);
    assert.deepEqual(reg.calls, []);
  }));

test('run: bad arguments and inputs are exit 2 before the adapter runs: urls past 1024 characters, no module, a source the registry lacks or gives another adapter, a used work directory, a --state that does not read or parse, --recordings that is no directory, a token with no actor', () =>
  inTmp(async (tmp) => {
    const state = stateFile(tmp, emptyState(NOW));
    const common = ['--state', state, '--psl', PSL_FILE, '--no-push'];
    const long = JSON.stringify(
      (() => {
        const j = JSON.parse(readFileSync(join(ADAPTERS, 'fixture-stream', 'source.json'), 'utf8'));
        j.sources[0].urls = [`https://stream.example.test/${'a'.repeat(574)}`, `https://stream.example.test/${'b'.repeat(574)}`];
        return j;
      })(),
    );
    const urls = planted(tmp, 'fixture-stream', [], long);
    const u = await call(main, argsOf('fixture-stream', join(tmp, 'u'), common, urls));
    assert.equal(u.code, EXIT.usage, u.text);
    assert.match(u.text, /urls: range: the urls joined by a space are \d+ characters, over 1024/);
    assert.equal(existsSync(join(tmp, 'u', 'work')), false);
    const file = join(tmp, 'a-file');
    writeFileSync(file, 'x');
    // An adapter with no module; one whose source is no row of the registry; one holding another adapter's source.
    const noModule = planted(tmp, 'fixture-stream', []);
    rmSync(join(noModule, 'fixture-stream', 'src', 'index.ts'));
    const sourceOf = (adapter, edit) => {
      const j = JSON.parse(readFileSync(join(ADAPTERS, adapter, 'source.json'), 'utf8'));
      edit(j.sources[0]);
      return JSON.stringify(j);
    };
    const unknown = planted(
      tmp,
      'fixture-stream',
      [],
      sourceOf('fixture-stream', (s) => {
        s.id = 'ct-le';
        s.bit = 5;
      }),
    );
    const others = planted(
      tmp,
      'fixture-stream',
      [],
      sourceOf('fixture-file', () => undefined),
    );
    // An --out whose work directory of the adapter holds a file; a --state that does not read, and one that does not parse.
    mkdirSync(join(tmp, 's', 'work', 'fixture-stream'), { recursive: true });
    writeFileSync(join(tmp, 's', 'work', 'fixture-stream', 'stale'), 'x');
    const garbled = join(tmp, 'garbled-state.json');
    writeFileSync(garbled, '{"format":"domains.state.v1"');
    const withState = (s) => ['--state', s, '--psl', PSL_FILE, '--no-push'];
    const cases = [
      [argsOf('fixture-stream', join(tmp, 'm'), common, noModule), /^run: no adapter module .*index\.ts$/m],
      [argsOf('fixture-stream', join(tmp, 'k'), common, unknown), /^run: fixture-stream holds the source ct-le, which is not a row of the registry /m],
      [argsOf('fixture-stream', join(tmp, 'o'), common, others), /^run: the registry .* gives isc-new to the adapter fixture-file, not fixture-stream$/m],
      [argsOf('fixture-stream', join(tmp, 's'), common), /work[\\/]fixture-stream holds files: run writes into a new directory/],
      [argsOf('fixture-stream', join(tmp, 'g'), withState(join(tmp, 'no-state.json'))), /^run: --state .*no-state\.json does not read: /m],
      [argsOf('fixture-stream', join(tmp, 'h'), withState(garbled)), /^run: --state .*garbled-state\.json: /m],
      [
        [...argsOf('fixture-stream', join(tmp, 'q'), common).filter((x, i, a) => a[i - 1] !== '--recordings' && x !== '--recordings'), '--recordings', join(tmp, 'no-recordings')],
        /--recordings .*no-recordings is not a directory/,
      ],
      [
        [...argsOf('fixture-stream', join(tmp, 'r'), common).filter((x, i, a) => a[i - 1] !== '--recordings' && x !== '--recordings'), '--recordings', file],
        /--recordings .*a-file is not a directory/,
      ],
      [argsOf('fixture-stream', join(tmp, 't'), [...common, '--psl', PSL_FILE]), /^run: --psl is given twice$/m],
      [argsOf('fixture-stream', join(tmp, 'l'), [...common, '--lanes', join(tmp, 'missing.json')]), /--lanes is read for --lane alone/],
      [argsOf('fixture-stream', join(tmp, 'n'), [...common.slice(0, -1), '--no-push=1']), /--no-push takes no value, and it was given "1"/],
      [argsOf('Bad_Id', join(tmp, 'b'), common), /--adapter "Bad_Id" is not an adapter directory's name/],
      [argsOf(`a${'-b'.repeat(32)}`, join(tmp, 'b2'), common), /is not an adapter directory's name/],
      [['positional', ...argsOf('fixture-stream', join(tmp, 'p'), common)], /"positional" is not a flag/],
      [[...argsOf('fixture-stream', join(tmp, 'v'), common), '--lane'], /--lane needs a value/],
      [argsOf('fixture-stream', join(tmp, 'w'), common).filter((x, i, a) => x !== '--adapter' && a[i - 1] !== '--adapter'), /--adapter is needed/],
      [[...argsOf('fixture-stream', join(tmp, 'x'), common), '--bogus', '1'], /unknown flag --bogus/],
    ];
    for (const [argv, re] of cases) {
      const r = await call(main, argv);
      assert.equal(r.code, EXIT.usage, `${argv.join(' ')}\n${r.text}`);
      assert.match(r.text, re);
    }
    assert.deepEqual(readdirSync(join(tmp, 's', 'work', 'fixture-stream')), ['stale'], 'the adapter did not run');
    const t = await call(main, argsOf('fixture-stream', join(tmp, 'y'), common), { extra: { tmp: join(tmp, 'no-such-dir') } });
    assert.equal(t.code, EXIT.usage, t.text);
    assert.match(t.text, /the temporary directory .*no-such-dir \(RUNNER_TEMP\) cannot be used/);
    // A push needs the token and the actor both: the token alone is exit 2 before the adapter runs.
    const push = ['--state', state, '--psl', PSL_FILE];
    const half = await call(main, argsOf('fixture-stream', join(tmp, 'z'), push), { env: { REGISTRY_TOKEN: TOKEN } });
    assert.equal(half.code, EXIT.usage, half.text);
    assert.match(half.text, /a push needs REGISTRY_TOKEN \(the job's own GITHUB_TOKEN\) and GITHUB_ACTOR/);
    assert.equal(existsSync(join(tmp, 'z', 'work')), false, 'the adapter did not run');
  }));

test('run: a live run with nothing new writes no segment and keeps its cursor: exit 0, nothing pushed and no proposal', () =>
  inRegistry(async (reg, tmp) => {
    const live = { ...emptyState('2026-10-28T00:00:00Z'), cursors: { 'fixture-stream': { next: 0 } }, moved: { 'fixture-stream': { at: '2026-10-28T00:00:00Z', run: '1' } } };
    const state = stateFile(tmp, live);
    const out = join(tmp, 'out');
    // At 07:00 no window has ended: the run reads nothing and returns the cursor it started from.
    const early = '2026-10-30T07:00:00Z';
    const r = await call(main, argsOf('fixture-stream', out, ['--state', state, '--psl', PSL_FILE], ADAPTERS, early), { reg, now: early });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out[0], `cursor fixture-stream {"next":0} (${state})`);
    assert.equal(r.out.at(-1), 'no proposal: no segment was written and the cursor did not move');
    assert.deepEqual(reg.calls, [], 'no oras call: nothing pushed, no login');
    assert.equal(existsSync(proposalAt(out, 'fixture-stream')), false);
  }));

test('run: the proposal carries GITHUB_RUN_ATTEMPT as its attempt', () =>
  inRegistry(async (reg, tmp) => {
    const state = stateFile(tmp, emptyState(NOW));
    const out = join(tmp, 'out');
    const r = await call(main, argsOf('fixture-file', out, ['--state', state, '--psl', PSL_FILE]), { reg, now: NOW, env: { GITHUB_ACTOR: ACTOR, REGISTRY_TOKEN: TOKEN, GITHUB_RUN_ATTEMPT: '2' } });
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(parseProposal(readFileSync(proposalAt(out, 'fixture-file'))).attempt, 2);
  }));

test('run: a day segment of a source whose band measures bytes and that carries no raw bytes is FAIL segment, exit 1, and nothing is pushed', () =>
  inRegistry(async (reg, tmp) => {
    const dir = planted(tmp, 'fixture-file', [['recordsOf(new TextDecoder().decode(bytes), dayNo),\n      bytes,', 'recordsOf(new TextDecoder().decode(bytes), dayNo),\n      undefined,']]);
    const state = stateFile(tmp, emptyState(NOW));
    const out = join(tmp, 'out');
    const r = await call(main, argsOf('fixture-file', out, ['--state', state, '--psl', PSL_FILE], dir), { reg, now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /^run: FAIL segment: obs:\S+: the band of isc-new measures the raw file's bytes, and the segment carries no raw bytes; nothing of this adapter run is pushed/m);
    assert.deepEqual(reg.calls, []);
    assert.equal(existsSync(proposalAt(out, 'fixture-file')), false);
  }));

test("run: the token read's registry config is removed before the adapter module runs", () =>
  inRegistry(async (reg, tmp) => {
    // The module lists the temporary directory the run's own directories are made in.
    const dir = planted(tmp, 'fixture-stream', [
      [
        'export async function run(cursor: Cursor, ctx: AdapterContext): Promise<RunResult> {',
        'export async function run(cursor: Cursor, ctx: AdapterContext): Promise<RunResult> {\n  const g = globalThis as Record<string, unknown>;\n  g.__tmpSeen = (await import("node:fs")).readdirSync(g.__tmpRoot as string);',
      ],
    ]);
    const rt = join(tmp, 'runner-temp');
    mkdirSync(rt);
    globalThis.__tmpRoot = rt;
    try {
      // No --state: state:latest reads as absent with no credential, and the token tells it from a private one.
      const r = await call(main, argsOf('fixture-stream', join(tmp, 'out'), ['--psl', PSL_FILE, '--no-push'], dir), { reg, now: NOW, extra: { tmp: rt } });
      assert.equal(r.code, EXIT.ok, r.text);
      assert.equal(r.out[0], 'cursor fixture-stream none (state:latest none)');
      assert.ok(
        reg.calls.some((c) => c.verb === 'login'),
        'the token read logged in',
      );
      assert.ok(Array.isArray(globalThis.__tmpSeen), 'the module ran');
      assert.deepEqual(
        globalThis.__tmpSeen.filter((n) => n.startsWith('ingest-state-')),
        [],
        'no registry config of the token read is left when the module runs',
      );
      assert.deepEqual(readdirSync(rt), [], 'every temporary directory of the run is removed');
    } finally {
      delete globalThis.__tmpRoot;
      delete globalThis.__tmpSeen;
    }
  }));

test('run: a fault of the run is exit 1, a GHCR error exit 2 and an error run does not know exit 70', () =>
  inRegistry(async (reg, tmp) => {
    // A Fault: the root pins a list that ref:psl does not hold.
    const { root } = seedRoot(reg);
    const pinned = JSON.parse(reg.w.manifests.get(`ref:psl-${PSL.slice(0, 12)}`));
    pinned.annotations['dev.pkgforge.domains.sha256'] = 'f'.repeat(64);
    reg.w.manifests.set(`ref:psl-${PSL.slice(0, 12)}`, JSON.stringify(pinned));
    const state = stateFile(tmp, emptyState(NOW));
    const a = await call(main, argsOf('fixture-stream', join(tmp, 'a'), ['--state', state, '--psl', 'root', '--no-push']), { reg, now: NOW });
    assert.equal(a.code, EXIT.fault, a.text);
    assert.match(a.text, new RegExp(`run: FAIL \\S+/ref:psl-${root.psl.slice(0, 12)} does not hold one layer`));
    const reader = (err) => ({
      getManifest: async () => {
        throw err;
      },
      headManifest: async () => {
        throw err;
      },
    });
    const g = await call(main, argsOf('fixture-stream', join(tmp, 'g'), ['--psl', PSL_FILE, '--no-push']), {
      reg,
      now: NOW,
      extra: { reader: reader(new GhcrError('upstream', 'synthetic 500', 500)) },
    });
    assert.equal(g.code, EXIT.usage, g.text);
    assert.match(g.text, /run: synthetic 500/);
    const i = await call(main, argsOf('fixture-stream', join(tmp, 'i'), ['--psl', PSL_FILE, '--no-push']), { reg, now: NOW, extra: { reader: reader(new TypeError('a planted defect')) } });
    assert.equal(i.code, EXIT.internal, i.text);
    assert.match(i.text, /run: internal error: TypeError: a planted defect/);
  }));

test('run: a push that fails or finds another manifest under its tag stops the run, exit 1: nothing later is pushed, and no proposal is written', () =>
  inRegistry(async (reg, tmp) => {
    const state = stateFile(tmp, emptyState(NOW));
    // The copy of the first raw object fails every attempt.
    const tried = [];
    const failing = async (args, opts) => {
      if (args[0] !== 'copy') return reg.oras(args, opts);
      tried.push(args.at(-1).slice(args.at(-1).lastIndexOf(':') + 1));
      return { code: 1, stdout: '', stderr: 'Error: synthetic failure\n' };
    };
    const a = await call(main, argsOf('fixture-stream', join(tmp, 'a'), ['--state', state, '--psl', PSL_FILE]), { reg, now: NOW, extra: { oras: failing } });
    assert.equal(a.code, EXIT.fault, a.text);
    assert.deepEqual(new Set(tried), new Set([`raw-${SEG0}`]), 'only the first raw object was tried');
    assert.deepEqual(copied(reg), []);
    assert.equal(existsSync(proposalAt(join(tmp, 'a'), 'fixture-stream')), false);
    // The first segment's tag holds another manifest: push.mjs exits 3, the run 1.
    reg.seed('obs', SEG0, artifactType('segment'), { 'dev.pkgforge.domains.sha256': 'e'.repeat(64) }, [{ title: 'part.000', bytes: new TextEncoder().encode('other') }]);
    const before = copied(reg).length;
    const b = await call(main, argsOf('fixture-stream', join(tmp, 'b'), ['--state', state, '--psl', PSL_FILE]), { reg, now: NOW });
    assert.equal(b.code, EXIT.fault, b.text);
    assert.match(b.text, new RegExp(`run: obs:${SEG0.replaceAll('.', '\\.')} holds another manifest; nothing more of this adapter run is pushed, and no proposal is written`));
    assert.deepEqual(copied(reg).slice(before), [`raw-${SEG0}`, 'raw-oi-cs.20261030t081000z.20261030t082000z'], 'the raw objects, then no segment');
    assert.equal(existsSync(proposalAt(join(tmp, 'b'), 'fixture-stream')), false);
  }));

test('run: only ok and quarantine go on to a push; a fail verdict pushes nothing, and every segment names the checks of REQUIRE, volume for a day', () =>
  inRegistry(async (reg, tmp) => {
    // The records carry the bit of ct-le (5), not oi-cs's: the sources check fails.
    const dir = planted(tmp, 'fixture-stream', [['export const BIT = 4;', 'export const BIT = 5;']]);
    const state = stateFile(tmp, emptyState(NOW));
    const r = await call(main, argsOf('fixture-stream', join(tmp, 'a'), ['--state', state, '--psl', PSL_FILE], dir), { reg, now: NOW });
    assert.equal(r.code, EXIT.fault, r.text);
    assert.match(r.text, /verdict fail$/m);
    assert.match(r.text, /nothing of this adapter run is pushed, and no proposal is written \(D18 of DOM-024\)/);
    assert.deepEqual(reg.calls, []);
    // The --require each verify is given.
    assert.deepEqual(REQUIRE, ['dataset', 'length', 'count', 'sha256', 'psl', 'sources', 'precision']);
    assert.equal(QUARANTINE, 'dev.pkgforge.domains.quarantine');
    const seen = [];
    const verify = (argv, io) => {
      seen.push(argv[argv.indexOf('--require') + 1]);
      return verifyMain(argv, io);
    };
    const f = await call(main, argsOf('fixture-file', join(tmp, 'f'), ['--state', state, '--psl', PSL_FILE, '--no-push']), { reg, now: NOW, extra: { verify } });
    assert.equal(f.code, EXIT.ok, f.text);
    assert.deepEqual(seen, ['dataset,length,count,sha256,psl,sources,precision,volume', 'dataset,length,count,sha256,psl,sources,precision,volume']);
    seen.length = 0;
    const s = await call(main, argsOf('fixture-stream', join(tmp, 's'), ['--state', state, '--psl', PSL_FILE, '--no-push']), { reg, now: NOW, extra: { verify } });
    assert.equal(s.code, EXIT.ok, s.text);
    assert.deepEqual(seen, Array(4).fill('dataset,length,count,sha256,psl,sources,precision'));
    // A verify that could not run (exit 2) stops the run as could not run; an unverified verdict pushes nothing.
    const broken = await call(main, argsOf('fixture-stream', join(tmp, 'x'), ['--state', state, '--psl', PSL_FILE]), { reg, now: NOW, extra: { verify: async () => 2 } });
    assert.equal(broken.code, EXIT.usage, broken.text);
    assert.match(broken.text, /scripts\/verify-pack\.mjs exited 2 for obs:/);
    const unverified = async (_argv, io) => {
      io.write(`${JSON.stringify({ verdict: 'unverified', errors: [], unverified: ['psl'] })}\n`);
      return 1;
    };
    const u = await call(main, argsOf('fixture-stream', join(tmp, 'y'), ['--state', state, '--psl', PSL_FILE]), { reg, now: NOW, extra: { verify: unverified } });
    assert.equal(u.code, EXIT.fault, u.text);
    assert.match(u.text, /required and skipped: psl/);
    assert.deepEqual(reg.calls, []);
  }));

test("run: a module's result is held to the contract: a bad result, segments it did not write, its own cursor back, a backfill outside its window at either end, a throw printed on one line, no run, no load", () =>
  inRegistry(async (reg, tmp) => {
    const state = stateFile(tmp, emptyState(NOW));
    const common = ['--state', state, '--psl', PSL_FILE];
    const cases = [
      [
        [['stats: { windows: segments.length / 2 }, errors: [] };\n}\n\nexport async function backfill', 'stats: { windows: "x" }, errors: [] };\n}\n\nexport async function backfill']],
        [],
        EXIT.fault,
        /run: FAIL result: fixture-stream: stats is not an object of finite numbers/,
      ],
      [
        [['return { segments, cursor: { next }, stats', 'return { segments: segments.slice(1), cursor: { next }, stats']],
        [],
        EXIT.fault,
        /run: FAIL reported: fixture-stream: the module returned 3 segments and wrote 4/,
      ],
      [
        [['return { segments, cursor: { next }, stats', 'return { segments, cursor, stats']],
        [],
        EXIT.fault,
        /run: FAIL continuation: fixture-stream wrote segments and returned the cursor it started from/,
      ],
      [
        [['for (let n = Math.max(0, from);', 'for (let n = 0;']],
        ['--from', '2026-10-30T08:10:00Z', '--to', '2026-10-30T08:20:00Z'],
        EXIT.fault,
        /run: FAIL segment: fixture-stream: the backfill wrote oi-cs 2026-10-30T08:00:00Z to 2026-10-30T08:10:00Z, outside the window/,
      ],
      // A window past the end of the backfill's: its end bound.
      [
        [['<= Date.parse(window.end); n++)', '<= Date.parse(window.end) + WINDOW_MS; n++)']],
        ['--from', '2026-10-30T08:00:00Z', '--to', '2026-10-30T08:10:00Z'],
        EXIT.fault,
        /run: FAIL segment: fixture-stream: the backfill wrote oi-cs 2026-10-30T08:10:00Z to 2026-10-30T08:20:00Z, outside the window 2026-10-30T08:00:00Z to 2026-10-30T08:10:00Z/,
      ],
      // A module that throws text with line breaks: the FAIL line is one line.
      [
        [
          [
            'export async function run(cursor: Cursor, ctx: AdapterContext): Promise<RunResult> {',
            'export async function run(cursor: Cursor, ctx: AdapterContext): Promise<RunResult> {\n  if (cursor !== undefined) throw new Error("boom\\n::error::forged line");',
          ],
        ],
        [],
        EXIT.fault,
        /^run: FAIL threw: fixture-stream: run\(\) threw: boom\\n::error::forged line; nothing of this adapter run is pushed/m,
      ],
      [[['export async function run(', 'export async function walk(']], [], EXIT.usage, /exports no run function/],
      [[['export const SOURCE = "oi-cs";', 'export const SOURCE = "oi-cs";\nthrow new Error("a planted load failure");']], [], EXIT.usage, /does not load: a planted load failure/],
    ];
    for (const [edits, more, code, re] of cases) {
      const dir = planted(tmp, 'fixture-stream', edits);
      const r = await call(main, argsOf('fixture-stream', join(tmp, `c${copies}`), [...common, ...more], dir), { reg, now: NOW });
      assert.equal(r.code, code, r.text);
      assert.match(r.text, re);
      // No line starts with text the module returned or threw.
      for (const l of [...r.out, ...r.err.flatMap((e) => e.split('\n'))]) assert.ok(!l.startsWith('::'), l);
    }
    // The module that fails to load was never asked to fetch; nothing of any case was pushed.
    assert.deepEqual(reg.calls, []);
  }));

test('run: the writer holds a draft to its source, one segment a source, window and dataset, a day file to one layer, and a cursor to the push tool; a refused draft writes nothing, and writeRaw takes bytes alone, each file once', () =>
  inTmp(async (tmp) => {
    const row = { id: 'isc-new', precision: 'day', datasets: ['domains'], parser: 'x/1', urls: ['https://files.example.test/'] };
    const stream = { id: 'oi-cs', precision: 'second', datasets: ['names', 'domains'], parser: 'x/1', urls: ['https://stream.example.test/'] };
    const fresh = (name, partBytes) => {
      mkdirSync(join(tmp, name));
      return diskWriter({ dir: join(tmp, name), adapter: 'fixture-file', sources: [row, stream], psl: PSL, run: RUN, fetched: NOW, ...(partBytes === undefined ? {} : { partBytes }) });
    };
    const day = {
      source: 'isc-new',
      dataset: 'domains',
      window: { start: '2026-10-28T00:00:00Z', end: '2026-10-29T00:00:00Z' },
      cursorBefore: null,
      cursorAfter: { last_day: '2026-10-28' },
      precision: 'day',
    };
    const rec = [{ key: 'com.alpha-synthetic', flags: 0, sources: [{ bit: 8, first: 300, last: 300 }], evidence: [] }];
    // Two files of one day: their tags differ (each names its hash), and the second is refused.
    const w = fresh('a');
    await w.write(day, rec, new TextEncoder().encode('first file\n'));
    await assert.rejects(
      w.write(day, rec, new TextEncoder().encode('second file\n')),
      (e) => e instanceof WriteFault && e.code === 'tag' && /a segment of this source, window and dataset was written already in this run/.test(e.message),
    );
    assert.equal(w.segments.length, 1);
    // Two writes of one source, window and dataset that overlap: the second is refused before it writes, and one segment is written.
    const both = fresh('both');
    const settled = await Promise.allSettled([both.write(day, rec, new TextEncoder().encode('a.example\n')), both.write(day, rec, new TextEncoder().encode('b.example\n'))]);
    assert.deepEqual(
      settled.map((s) => s.status),
      ['fulfilled', 'rejected'],
    );
    assert.ok(settled[1].reason instanceof WriteFault && settled[1].reason.code === 'tag' && /or is being written/.test(settled[1].reason.message), String(settled[1].reason));
    assert.equal(both.segments.length, 1);
    assert.deepEqual(readdirSync(join(tmp, 'both')), [both.segments[0].tag]);
    // A write that fails once its tag is taken (records out of key order) keeps its source, window and dataset: another file of that day is refused.
    const late = fresh('late');
    const unsorted = [rec[0], { ...rec[0], key: 'com.aaa-synthetic' }];
    await assert.rejects(late.write(day, unsorted, new TextEncoder().encode('first\n')), (e) => e?.name === 'PackError');
    await assert.rejects(late.write(day, rec, new TextEncoder().encode('second\n')), (e) => e instanceof WriteFault && e.code === 'tag' && /or is being written/.test(e.message));
    assert.deepEqual(late.segments, []);
    // Two day windows that start on one day and hold the same bytes take one file tag: the second is refused as that tag, before any directory.
    const twice = fresh('twice');
    const bytes = new TextEncoder().encode('one file\n');
    const first = await twice.write(day, rec, bytes);
    await assert.rejects(
      twice.write({ ...day, window: { start: '2026-10-28T00:00:00Z', end: '2026-10-30T00:00:00Z' } }, rec, bytes),
      (e) => e instanceof WriteFault && e.code === 'tag' && /obs:isc-new\.20261028\.[0-9a-f]{12}-d was written already in this run/.test(e.message),
    );
    assert.deepEqual(
      twice.segments.map((s) => s.segment),
      [first],
    );
    // Two sources of one window, each with raw bytes, written at once: both are written, each under its own tag and raw object.
    const nrd = { ...row, id: 'whois-nrd', urls: ['https://nrd.example.test/'] };
    const zone = { ...stream, id: 'oi-nrd', urls: ['https://zone.example.test/'] };
    mkdirSync(join(tmp, 'pair'));
    const pair = diskWriter({ dir: join(tmp, 'pair'), adapter: 'fixture-file', sources: [row, nrd, stream, zone], psl: PSL, run: RUN, fetched: NOW });
    const hour = { start: '2026-10-30T08:00:00Z', end: '2026-10-30T08:10:00Z' };
    const paired = await Promise.allSettled([
      pair.write(day, rec, new TextEncoder().encode('isc file\n')),
      pair.write({ ...day, source: 'whois-nrd' }, rec, new TextEncoder().encode('nrd file\n')),
      pair.write({ ...day, source: 'oi-cs', dataset: 'names', window: hour, precision: 'second' }, [], new TextEncoder().encode('cs bytes\n')),
      pair.write({ ...day, source: 'oi-nrd', dataset: 'names', window: hour, precision: 'second' }, [], new TextEncoder().encode('nrd bytes\n')),
    ]);
    assert.deepEqual(
      paired.map((s) => s.status),
      ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'],
      paired.map((s) => String(s.reason ?? '')).join(' | '),
    );
    assert.deepEqual(pair.segments.map((s) => s.segment.source).sort(), ['isc-new', 'oi-cs', 'oi-nrd', 'whois-nrd']);
    assert.deepEqual(pair.raws.map((r) => r.source).sort(), ['oi-cs', 'oi-nrd']);
    assert.equal(readdirSync(join(tmp, 'pair')).filter((n) => !n.startsWith('.')).length, 6);
    // A day file is one layer: past partBytes it is raw-size, through write itself.
    const small = fresh('b', 4);
    await assert.rejects(small.write(day, rec, new TextEncoder().encode('more than four bytes')), (e) => e instanceof WriteFault && e.code === 'raw-size');
    // A write refused before its tag gives its source, window and dataset back: a smaller file of that day is written.
    assert.equal((await small.write(day, rec, new TextEncoder().encode('one'))).raw.bytes, 3);
    // A stream's raw bytes take as many layers as they need.
    const s = await small.write(
      { ...day, source: 'oi-cs', dataset: 'names', window: { start: '2026-10-30T08:00:00Z', end: '2026-10-30T08:10:00Z' }, precision: 'second' },
      [],
      new TextEncoder().encode('more than four bytes'),
    );
    assert.equal(small.raws[0].files.length, 6, JSON.stringify(s));
    // The draft's own facts: the source's precision and datasets, its window and its cursors.
    const c = fresh('c');
    const contract = (draft, check) => assert.rejects(c.write(draft, rec, undefined), (e) => e?.name === 'ContractError' && e.check === check, JSON.stringify(draft));
    await contract({ ...day, precision: 'second' }, 'source');
    await contract({ ...day, dataset: 'names' }, 'source');
    await contract({ ...day, window: { start: '2026-10-28T00:00:00Z', end: '2026-10-28T12:00:00Z' } }, 'segment');
    await contract({ ...day, cursorAfter: { at: new Date(0) } }, 'cursor');
    await contract({ ...day, cursorBefore: { at: new Date(0) } }, 'cursor');
    await assert.rejects(c.write(null, rec, undefined), (e) => e?.name === 'ContractError' && e.check === 'draft');
    // A cursor with a DEL inside is refused before anything is written, as the push tool would refuse it.
    await assert.rejects(
      c.write({ ...day, cursorAfter: { p: 'a\u007fb' } }, rec, undefined),
      (e) => e instanceof WriteFault && e.code === 'cursor' && /cursorAfter as canonical JSON holds a control character/.test(e.message),
    );
    // A window in milliseconds is an ISO time, and no tag names it.
    await assert.rejects(
      c.write({ ...day, window: { start: '2026-10-28T00:00:00.000Z', end: '2026-10-29T00:00:00.000Z' } }, rec, undefined),
      (e) => e instanceof WriteFault && e.code === 'tag' && /is not YYYY-MM-DDTHH:MM:SSZ to the second, as a tag names it/.test(e.message),
    );
    assert.deepEqual(c.segments, []);
    assert.deepEqual(readdirSync(join(tmp, 'c')), [], 'a refused draft writes nothing');
    // A second-precision window that ends on an hour edge lies in one hour.
    const edge = await fresh('d').write({ ...day, source: 'oi-cs', dataset: 'names', window: { start: '2026-10-30T08:50:00Z', end: '2026-10-30T09:00:00Z' }, precision: 'second' }, [], undefined);
    assert.equal(edge.window.end, '2026-10-30T09:00:00Z');
    // An annotation packManifest refuses (urls joined past 1024 characters) is WriteFault manifest.
    mkdirSync(join(tmp, 'e'));
    const longUrl = diskWriter({ dir: join(tmp, 'e'), adapter: 'fixture-file', sources: [{ ...row, urls: [`https://files.example.test/${'a'.repeat(1100)}`] }], psl: PSL, run: RUN, fetched: NOW });
    await assert.rejects(longUrl.write(day, rec, undefined), (e) => e instanceof WriteFault && e.code === 'manifest' && /dev\.pkgforge\.domains\.url/.test(e.message));
    // writeRaw: a file is written once, and the raw input is bytes or an async iterable of bytes.
    mkdirSync(join(tmp, 'once'));
    writeFileSync(join(tmp, 'once', 'raw.000'), 'kept');
    await assert.rejects(writeRaw(new Uint8Array(3), join(tmp, 'once'), { maxParts: 1, what: 'raw' }), (e) => e?.code === 'EEXIST');
    assert.equal(readFileSync(join(tmp, 'once', 'raw.000'), 'utf8'), 'kept');
    await assert.rejects(
      writeRaw(5, join(tmp, 'n'), { maxParts: 1, what: 'raw' }),
      (e) => e?.name === 'ContractError' && e.check === 'draft' && /raw is neither a Uint8Array nor an async iterable of them/.test(e.message),
    );
    async function* text() {
      yield 'not bytes';
    }
    await assert.rejects(
      writeRaw(text(), join(tmp, 't'), { maxParts: 1, what: 'raw' }),
      (e) => e?.name === 'ContractError' && e.check === 'draft' && /a raw chunk is not a Uint8Array/.test(e.message),
    );
  }));
