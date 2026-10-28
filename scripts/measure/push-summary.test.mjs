// scripts/measure/push-summary.mjs: the five criteria of DOM-006 on synthetic
// runs of measure-push.yml (scripts/measure/fixtures/push/), their boundaries,
// the refusals of a file of the wrong shape, the result file, the --run path
// through a stand-in for gh, and the agreement between the workflow that
// writes the records and the script that reads them. Exit codes are read from
// the process itself.
//
// The fixtures are hand-built in the shape of the records the workflow's steps
// write; no run of measure-push.yml made them. Their run ids, git sha, tool
// versions, timings and digests are invented, and none of their numbers is a
// measurement. The real push-result artifacts replace first-run.json and
// second-run.json once the first two dispatches exist.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, test } from 'node:test';
import { ROOT } from '../files.mjs';
import { ARTIFACT, CRITERIA, criteria, DEFAULT_OUT, derive, FILE, KINDS, main, parseResult, REPO, SCHEMA, ShapeError, WHATS, WORKFLOW } from './push-summary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, 'push-summary.mjs');
const FIX = join(HERE, 'fixtures', 'push');

const dirs = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const scratch = () => {
  const d = mkdtempSync(join(tmpdir(), 'domains-push-summary-'));
  dirs.push(d);
  return d;
};

const load = (name) => JSON.parse(readFileSync(join(FIX, name), 'utf8'));
const verdicts = (doc) => Object.fromEntries(criteria(derive(parseResult(JSON.stringify(doc)))).map((c) => [c.name, c]));
const cli = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' });
const writeDoc = (doc) => {
  const f = join(scratch(), FILE);
  writeFileSync(f, JSON.stringify(doc));
  return f;
};
const rec = (doc, kind, pred = () => true) => doc.records.find((r) => r.kind === kind && pred(r));
const withLayers = (doc, layers) => {
  doc.records = doc.records.filter((r) => r.kind !== 'layers');
  for (const [n, outcome] of layers) doc.records.push({ kind: 'layers', n, outcome, seconds: 1.5, rc: outcome === 'accepted' ? 0 : 1, digest: null, rate_limit_pauses: 0, error: null });
  return doc;
};

test('push summary: a second run passes all five criteria and exits 0', () => {
  const r = cli('--file', join(FIX, 'second-run.json'));
  assert.equal(r.status, 0, r.stderr);
  for (const name of CRITERIA) assert.match(r.stdout, new RegExp(`^PASS ${name} `, 'm'));
  assert.match(r.stdout, /^push size-1536m: 1610612736 bytes in 47\.312 s, 34\.0 MB\/s/m);
  assert.match(r.stdout, /^retag of run 18842990007: .*untagged since 2026-10-28T10:51:42Z, by digest 200 \(A\), its blob 200$/m);
});

test('push summary: a first run fails only second-push-with-token, which --require anonymous-read leaves out', () => {
  const r = cli('--file', join(FIX, 'first-run.json'));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^FAIL second-push-with-token +the probe did not exist before this run \(tags\/list 404\), so this run created it; dispatch/m);
  for (const name of CRITERIA.filter((n) => n !== 'second-push-with-token')) assert.match(r.stdout, new RegExp(`^PASS ${name} `, 'm'));
  assert.equal(cli('--file', join(FIX, 'first-run.json'), '--require', 'anonymous-read').status, 0);
});

test('push summary: a private package, a push past the limit and a refusal at 75 layers fail, and the workflow verdict exits 1', () => {
  const r = cli('--file', join(FIX, 'private.json'));
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^PASS push-1536m-under-600s /m);
  assert.match(r.stdout, /^FAIL push-4096m-under-600s +ended by the job's limit after 660\.004 s$/m);
  assert.match(r.stdout, /^FAIL layers-at-least-128 +largest accepted 62, smallest refused 75$/m);
  assert.match(r.stdout, /^FAIL anonymous-read +size-1536m: HTTP 404 \(Bearer QQ== 404, anonymous token endpoint 403\)$/m);
  assert.match(r.stdout, /^package record: HTTP 403, visibility -, repository -, "Resource not accessible by integration"$/m);
  assert.equal(cli('--file', join(FIX, 'private.json'), '--require', 'anonymous-read').status, 1);
});

test('push summary: a push passes under 600 s and fails at 600 s, a short payload, no digest or no push at all', () => {
  const at = (mutate) => {
    const doc = load('second-run.json');
    mutate(doc);
    return verdicts(doc)['push-4096m-under-600s'];
  };
  assert.equal(at((d) => (rec(d, 'push', (p) => p.mib === 4096).seconds = 599.999)).pass, true);
  const limit = at((d) => (rec(d, 'push', (p) => p.mib === 4096).seconds = 600));
  assert.equal(limit.pass, false);
  assert.match(limit.detail, /not under GHCR's 600 s upload limit/);
  assert.match(at((d) => (rec(d, 'push', (p) => p.mib === 4096).bytes -= 1)).detail, /the payload held 4294967295 bytes, not 4096 MiB/);
  assert.match(at((d) => (rec(d, 'push', (p) => p.mib === 4096).digest = null)).detail, /printed no manifest digest/);
  const none = at((d) => {
    d.records = d.records.filter((r) => !(r.kind === 'push' && r.mib === 4096));
  });
  assert.equal(none.pass, false);
  assert.match(none.detail, /no push of 4096 MiB in this run/);
});

test('push summary: layers pass at 128 accepted and fail at 127, and with no attempt at all', () => {
  const layers = (list) => verdicts(withLayers(load('second-run.json'), list))['layers-at-least-128'];
  assert.equal(layers([[128, 'accepted']]).pass, true);
  const short = layers([
    [127, 'accepted'],
    [256, 'refused'],
  ]);
  assert.equal(short.pass, false);
  assert.equal(short.detail, 'largest accepted 127, smallest refused 256');
  assert.match(layers([]).detail, /^not measured/);
  assert.equal(layers([[100, 'rate-limited']]).pass, false);
});

test('push summary: a refusal below an accepted count is printed as a note, and a 429 pause beside its attempt', () => {
  const doc = withLayers(load('second-run.json'), [
    [100, 'refused'],
    [300, 'accepted'],
  ]);
  rec(doc, 'layers', (l) => l.n === 300).rate_limit_pauses = 2;
  const r = cli('--file', writeDoc(doc));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^layers: NOTE the registry accepted 300 and refused 100, so the limit is not a count alone$/m);
  assert.match(r.stdout, /^layers 300: accepted in 1\.5 s, after 2 pause\(s\) for a 429$/m);
});

test('push summary: anonymous-read needs a 200 whose bytes hash to the pushed digest, by QQ== or by the token flow after 401 or 403', () => {
  const anon = (mutate) => {
    const doc = load('second-run.json');
    mutate(rec(doc, 'anon', (a) => a.what === 'size-manifest'));
    return verdicts(doc)['anonymous-read'];
  };
  const other = anon((a) => (a.digest = `sha256:${'0'.repeat(64)}`));
  assert.equal(other.pass, false);
  assert.match(other.detail, /the bytes read hash to sha256:0{64}, not the pushed/);
  const token = anon((a) => Object.assign(a, { via: 'token', qq_status: 401, token_status: 200 }));
  assert.equal(token.pass, true);
  assert.match(token.detail, /the anonymous token flow \(Bearer QQ== answered 401\)/);
  const after404 = anon((a) => Object.assign(a, { via: 'token', qq_status: 404, token_status: 200 }));
  assert.equal(after404.pass, false);
  assert.match(after404.detail, /falls back after 401 or 403 alone/);
  const doc = load('second-run.json');
  doc.records = doc.records.filter((r) => !(r.kind === 'anon' && r.what === 'size-manifest'));
  assert.match(verdicts(doc)['anonymous-read'].detail, /^not measured/);
});

test('push summary: second-push-with-token fails when the existed read is unknown or the push fails', () => {
  const doc = load('second-run.json');
  Object.assign(rec(doc, 'existed'), { present: null, status: 403 });
  assert.match(verdicts(doc)['second-push-with-token'].detail, /could not tell whether the probe existed before this run \(token endpoint 200, tags\/list 403\)/);
  const failed = load('second-run.json');
  Object.assign(
    rec(failed, 'push', (p) => p.mib === 1536),
    { rc: 1, digest: null, error: 'Error: denied' },
  );
  const v = verdicts(failed)['second-push-with-token'];
  assert.equal(v.pass, false);
  assert.match(v.detail, /this run's push of size-1536m failed: Error: denied/);
});

test('push summary: a file of another shape is refused whole', () => {
  const refused = (mutate, re) => {
    const doc = load('second-run.json');
    mutate(doc);
    assert.throws(
      () => parseResult(JSON.stringify(doc)),
      (e) => e instanceof ShapeError && re.test(e.message),
    );
  };
  refused((d) => (d.schema = 'domains.measure.push.v2'), /schema is "domains\.measure\.push\.v2"/);
  refused((d) => (d.entry = 'DOM-007'), /entry is "DOM-007"/);
  refused((d) => d.records.push({ kind: 'surprise' }), /unknown kind "surprise"/);
  refused((d) => d.records.push({ kind: 'toString' }), /unknown kind "toString"/);
  refused((d) => (rec(d, 'push').digest = 'sha256:XYZ'), /field digest is not a sha256 digest/);
  refused((d) => delete rec(d, 'push').seconds, /\(push\) has no field seconds/);
  refused((d) => (rec(d, 'push').seconds = '47.3'), /field seconds is not a num/);
  refused((d) => d.records.push({ ...rec(d, 'run') }), /more than one run record/);
  refused((d) => d.records.push({ ...rec(d, 'push') }), /more than one push record for 1536/);
  refused((d) => d.records.reverse(), /the first record is not the run record/);
  refused((d) => (rec(d, 'run').workflow_ref = 'pkgforge-dev/domains.pkgforge.dev/.github/workflows/ci.yml@refs/heads/main'), /the run is not of/);
  refused((d) => (rec(d, 'anon').what = 'elsewhere'), /reads the unknown "elsewhere"/);
  refused((d) => (rec(d, 'layers').outcome = 'maybe'), /unknown outcome "maybe"/);
  refused((d) => (d.records = d.records.filter((r) => r.kind !== 'run')), /no run record/);
  // A null passes only where the field allows one.
  refused((d) => (rec(d, 'push').seconds = null), /\(push\) field seconds is not a num/);
  refused((d) => (rec(d, 'run').sha = null), /\(run\) field sha is not a str/);
  refused((d) => (d.records = { 0: rec(d, 'run') }), /records is not an array/);
  refused((d) => (rec(d, 'run').inputs = { size_mb: '1536', layers: 0 }), /inputs need the numbers size_mb and layers/);
  refused((d) => (rec(d, 'run').inputs = null), /\(run\) field inputs is not a obj/);
  refused((d) => (rec(d, 'retag-push').which = 'c'), /which is "c", not a or b/);
  refused((d) => (rec(d, 'retag-earlier').status = 'gone'), /\(retag-earlier\) has the unknown status "gone"/);
  refused((d) => (rec(d, 'anon').via = 'cookie'), /\(anon\) has the unknown via "cookie"/);
  assert.throws(() => parseResult('{'), ShapeError);
});

test('push summary: a criterion with no record fails with a line, never a throw', () => {
  for (const [kind, name, re] of [
    ['existed', 'second-push-with-token', /^not measured: no record of whether the probe existed/],
    ['push', 'push-1536m-under-600s', /^no push of 1536 MiB in this run/],
    ['push', 'second-push-with-token', /this run recorded no push/],
    ['layers', 'layers-at-least-128', /^not measured/],
  ]) {
    const doc = load('second-run.json');
    doc.records = doc.records.filter((r) => r.kind !== kind);
    const r = cli('--file', writeDoc(doc));
    assert.equal(r.status, 1, `${kind}: ${r.stderr}`);
    assert.equal(r.stderr, '');
    const v = verdicts(doc)[name];
    assert.equal(v.pass, false, `${kind} ${name}`);
    assert.match(v.detail, re, `${kind} ${name}`);
  }
});

test('push summary: --file without --out writes no file, not even the default result', () => {
  const before = existsSync(DEFAULT_OUT) ? readFileSync(DEFAULT_OUT, 'utf8') : null;
  const r = cli('--file', join(FIX, 'second-run.json'));
  assert.equal(r.status, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /^wrote /m);
  assert.equal(existsSync(DEFAULT_OUT) ? readFileSync(DEFAULT_OUT, 'utf8') : null, before);
});

test('push summary: the command line exits 2 when it cannot run', () => {
  const d = scratch();
  writeFileSync(join(d, 'bad.json'), 'not json');
  for (const args of [
    ['--file', join(d, 'bad.json')],
    ['--file', join(d, 'absent.json')],
    ['--file', join(FIX, 'second-run.json'), '--bogus'],
    ['--file', join(FIX, 'second-run.json'), '--run', '1'],
    ['--file', join(FIX, 'second-run.json'), '--require', 'nothing-such'],
    ['--file', join(FIX, 'second-run.json'), '--repo', 'not a repository'],
    ['--file', join(FIX, 'second-run.json'), '--out'],
    ['--run', 'latest'],
    ['--run', '12a'],
    [],
  ]) {
    const r = cli(...args);
    assert.equal(r.status, 2, `${args.join(' ')}: ${r.stdout}${r.stderr}`);
    assert.match(r.stderr, /^push-summary: /);
  }
});

test('push summary: --out writes the result file with the visibility, the layer count, the MB/s and the digest read after the retag', () => {
  const d = scratch();
  const out = join(d, 'nested', 'result.json');
  const r = cli('--file', join(FIX, 'second-run.json'), '--out', out);
  assert.equal(r.status, 0, r.stderr);
  const res = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(res.schema, 'domains.measure.push-summary.v1');
  assert.equal(res.visibility, 'public');
  assert.equal(res.linked_repository, REPO);
  assert.equal(res.layers.largest_accepted, 1000);
  assert.deepEqual(
    res.pushes.map((p) => [p.tag, p.mb_per_s]),
    [
      ['size-1536m', 34],
      ['size-4096m', 32.6],
    ],
  );
  assert.equal(res.retag.a_after_retag.digest, res.retag.a);
  assert.equal(res.retag.tag_after_retag.digest, res.retag.b);
  assert.deepEqual(
    res.criteria.map((c) => c.verdict),
    CRITERIA.map(() => 'PASS'),
  );
  assert.deepEqual(readdirSync(dirname(out)), ['result.json']);
});

test('push summary: --run downloads the artifact through gh, checks its run id, and keeps it beside the result', () => {
  const fixture = readFileSync(join(FIX, 'second-run.json'), 'utf8');
  const calls = [];
  const gh =
    (status = 0) =>
    (cmd, args) => {
      calls.push([cmd, ...args]);
      if (status === 0) writeFileSync(join(args[args.indexOf('--dir') + 1], FILE), fixture);
      return { status, stderr: status ? 'no artifact named push-result' : '' };
    };
  const lines = [];
  const errs = [];
  const io = (spawn) => ({ spawn, log: (l) => lines.push(l), err: (l) => errs.push(l) });
  const d = scratch();
  const out = join(d, 'result.json');
  assert.equal(main(['--run', '18843012345', '--out', out], io(gh())), 0, errs.join('\n'));
  assert.equal(calls[0][0], 'gh');
  assert.deepEqual(calls[0].slice(1, 8), ['run', 'download', '18843012345', '--repo', REPO, '--name', ARTIFACT]);
  assert.ok(existsSync(out));
  assert.equal(readFileSync(join(d, 'push-result-18843012345.json'), 'utf8'), fixture);

  const other = join(scratch(), 'result.json');
  assert.equal(main(['--run', '999', '--out', other], io(gh())), 2);
  assert.match(errs.at(-1), /the artifact names run 18843012345, not 999/);
  assert.equal(existsSync(other), false);
  assert.equal(main(['--run', '18843012345', '--out', other], io(gh(1))), 2);
  assert.match(errs.at(-1), /exited 1: no artifact named push-result/);
  assert.equal(main(['--run', '18843012345', '--repo', 'someone/else', '--out', other], io(gh())), 2);
  assert.match(errs.at(-1), /names the repository pkgforge-dev\/domains\.pkgforge\.dev, not someone\/else/);

  // A run dispatched on another branch is no proof of main's workflow.
  for (const [ref, workflowRef] of [
    ['refs/heads/topic', `${REPO}/${WORKFLOW}@refs/heads/topic`],
    ['refs/heads/main', `${REPO}/${WORKFLOW}@refs/heads/topic`],
  ]) {
    const doc = JSON.parse(fixture);
    Object.assign(rec(doc, 'run'), { ref, workflow_ref: workflowRef });
    const branch = (_cmd, args) => {
      writeFileSync(join(args[args.indexOf('--dir') + 1], FILE), JSON.stringify(doc));
      return { status: 0, stderr: '' };
    };
    assert.equal(main(['--run', '18843012345', '--out', other], io(branch)), 2, workflowRef);
    assert.match(errs.at(-1), /the artifact is of a run on refs\/heads\/\w+, not refs\/heads\/main/);
    assert.equal(existsSync(other), false);
  }
});

test('push summary: --run with no gh on the PATH exits 2 and says gh could not start', () => {
  const empty = scratch();
  const r = spawnSync(process.execPath, [SCRIPT, '--run', '1', '--out', join(empty, 'result.json')], { encoding: 'utf8', env: { ...process.env, PATH: empty, Path: empty } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /push-summary: gh could not start/);
});

test('push summary: the workflow writes the record kinds, the reads, the artifact and the schema this script reads', () => {
  const yml = readFileSync(join(ROOT, WORKFLOW), 'utf8');
  const kinds = new Set([...yml.matchAll(/kind: "([a-z-]+)"/g)].map((m) => m[1]));
  assert.deepEqual([...kinds].sort(), Object.keys(KINDS).sort());
  const whats = new Set([...yml.matchAll(/anon_read ([a-z-]+) /g)].map((m) => m[1]));
  assert.deepEqual([...whats].sort(), [...WHATS].sort());
  assert.match(yml, new RegExp(`name: ${ARTIFACT}\\r?\\n`));
  assert.match(yml, new RegExp(`/${FILE.replace('.', '\\.')}\\r?\\n`));
  assert.ok(yml.includes(`schema: "${SCHEMA}"`));
  assert.match(yml, /node scripts\/measure\/push-summary\.mjs --file "\$WORK\/out\/push-result\.json" --require anonymous-read/);
});

test('push summary: no run block of the workflow holds an expression; values reach it through env', () => {
  const lines = readFileSync(join(ROOT, WORKFLOW), 'utf8').split('\n');
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(\s*)(?:- )?run: (.*)$/);
    if (!m) continue;
    if (m[2] !== '|' && m[2].includes('${{')) found.push(i + 1);
    if (m[2] !== '|') continue;
    for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || lines[j].match(/^\s*/)[0].length > m[1].length); j++) {
      if (lines[j].includes('${{')) found.push(j + 1);
    }
  }
  assert.deepEqual(found, []);
});
