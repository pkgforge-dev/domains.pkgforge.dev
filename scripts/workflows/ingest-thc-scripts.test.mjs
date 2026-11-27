// The steps of .github/workflows/ingest-thc.yml over the real scripts
// (DOM-029, design sections 12.1 and 13.5): the plan step (thc-plan.mjs), the
// legs (run.mjs and adapters/thc-ct), the job push (advance.mjs, move.mjs)
// and the promotion of root-promote.yml (promote.mjs), as
// scripts/workflows/ingest-live-scripts.test.mjs runs ingest-live.yml's.
// scripts/workflows/ingest-thc.test.mjs runs each step with a double of each
// script; this file runs the scripts themselves, so a script that changes a
// flag, a line, a file or an exit code a step reads fails here.
//
// Each step is cut from its workflow (stepScript) and run under bash (runStep,
// -e and pipefail) with a bash function `node` that runs
// scripts/workflows/script-world.mjs with JOIN_THC_RECORDINGS: the step's
// script runs by its own main against the GHCR double of
// scripts/root/fixture.mjs, kept in a file between the steps, with the tree's
// adapters and registry, and THC's hosts answered by the synthetic recordings
// written here. Each job has a RUNNER_TEMP of its own; an artifact's upload
// and download is a copy, as merge-multiple puts every leg's files in one
// directory. Everything is synthetic: the bodies are the slice of 2026-10-31
// (adapters/thc-ct/fixtures/) and a gzip of two names, served as other days.
// Where bash or jq is missing the test is skipped and says so, and a skip is
// not a pass.
//
//   node scripts/test.mjs scripts/workflows --name "ingest-thc scripts"
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import { base64Of, RECORDING_FORMAT } from '@domains/adapter';
import { artifactType } from '@domains/ghcr';
import { buildRoot, sourcesLayer } from '@domains/root';
import { emptyState, encodeState, parseState } from '@domains/state';
import { parse } from 'yaml';
import { HOSTS } from '../../adapters/thc-ct/src/index.ts';
import { ROOT } from '../files.mjs';
import { PSL, PSL_FILE, seedList } from '../ingest/fixture.mjs';
import { BASH, JQ, runStep, stepScript } from '../lib/workflow-step.mjs';
import { ACTOR, registry, TOKEN } from '../root/fixture.mjs';
import { DEFAULT_SOURCES, loadRegistry } from '../verify-pack.mjs';
import { readWorld, saveWorld } from './script-world.mjs';

const WORKFLOWS = join(ROOT, '.github', 'workflows');
const THC = join(WORKFLOWS, 'ingest-thc.yml');
const PROMOTE = join(WORKFLOWS, 'root-promote.yml');
const DRIVER = fileURLToPath(new URL('./script-world.mjs', import.meta.url));
const SKIP = !BASH ? 'no bash on this machine, so the steps were not run' : !JQ ? 'no jq on this machine, so the steps were not run' : false;
const posix = (p) => p.replaceAll('\\', '/');
const TITLE = 'org.opencontainers.image.title';
const FIXTURES = join(ROOT, 'adapters', 'thc-ct', 'fixtures');
const SLICE = new Uint8Array(Buffer.from(JSON.parse(readFileSync(join(FIXTURES, 'cs2-get-20261031.http.json'), 'utf8')).response.body_base64, 'base64'));
const TINY = new Uint8Array(gzipSync(Buffer.from('example.com\nwww.example.org\n', 'utf8')));
const PSL12 = PSL.slice(0, 12);
const CURSOR = { next: '2026-11-01', open: [] };
const NOW = '2026-10-28T13:00:00Z';
const next = (day) => new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const kv = (path) =>
  existsSync(path)
    ? Object.fromEntries(
        readFileSync(path, 'utf8')
          .split('\n')
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/\r$/, '')]),
      )
    : {};

function stepEnv(file, id, given) {
  const wf = parse(readFileSync(file, 'utf8'));
  const found = Object.values(wf.jobs).flatMap((j) => (j.steps ?? []).filter((s) => s.id === id).map((s) => ({ ...wf.env, ...j.env, ...s.env })));
  assert.equal(found.length, 1, `${file} holds one step with id ${id}`);
  const env = { REGISTRY_TOKEN: '' };
  for (const [k, v] of Object.entries(found[0])) {
    if (!/\$\{\{/.test(String(v))) env[k] = String(v);
    else if (Object.hasOwn(given, k)) env[k] = String(given[k]);
    else throw new Error(`step ${id}: ${k} is the expression ${v}, and the test gives it no value`);
  }
  for (const k of Object.keys(given)) if (!Object.hasOwn(found[0], k)) throw new Error(`step ${id} of ${file} declares no ${k}`);
  return env;
}

// THC's answers for the days of `files` ({ day: bytes }): the bucket's listing
// of those days, cs2's index of none, and each day's resolve 302 and CDN 200.
function hosts(dir, files) {
  mkdirSync(dir, { recursive: true });
  const write = (name, method, url, status, headers, body = new Uint8Array(0)) =>
    writeFileSync(
      join(dir, `${name}.http.json`),
      JSON.stringify({ format: RECORDING_FORMAT, origin: 'synthetic', request: { method, url }, response: { status, headers, body_base64: base64Of(body) } }),
    );
  const path = (day) => `2026/${Number(day.slice(5, 7))}/${day}.txt.gz`;
  const listing = Object.entries(files).map(([day, bytes]) => ({ type: 'file', path: path(day), size: bytes.length, mtime: `${next(day)}T00:05:02.000Z` }));
  write('hf-listing', 'GET', HOSTS.listing, 200, { 'content-type': 'application/json' }, new TextEncoder().encode(JSON.stringify(listing)));
  write('cs2-index', 'GET', HOSTS.cs2, 200, { 'content-type': 'text/html' }, new TextEncoder().encode('<html>\n<body>\n<pre><a href="../">../</a>\n</pre>\n</body>\n</html>\n'));
  for (const [day, bytes] of Object.entries(files)) {
    const cdn = `https://us.aws.cdn.hf.co/synthetic/${day}.txt.gz`;
    write(`hf-resolve-${day}`, 'GET', `${HOSTS.resolve}${path(day)}?download=true`, 302, { location: cdn });
    write(`hf-cdn-${day}`, 'GET', cdn, 200, { 'content-type': 'application/gzip', 'content-length': String(bytes.length) }, bytes);
  }
  return dir;
}

function world(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-thc-scripts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'world.json');
  let n = 0;
  return {
    dir,
    file,
    job: (name) => {
      const temp = join(dir, name);
      mkdirSync(temp, { recursive: true });
      return temp;
    },
    step(wf, id, given, { temp, now, recordings }) {
      const output = join(dir, `output-${++n}.txt`);
      const script = `node() { "$JOIN_NODE" "$JOIN_DRIVER" "$@"; }\nset -eo pipefail\n${stepScript(wf, id)}`;
      const r = runStep(t, script, {
        env: {
          ...stepEnv(wf, id, given),
          JOIN_NODE: posix(process.execPath),
          JOIN_DRIVER: posix(DRIVER),
          JOIN_WORLD: posix(file),
          JOIN_NOW: now,
          JOIN_THC_RECORDINGS: posix(recordings),
          RUNNER_TEMP: posix(temp),
          GITHUB_OUTPUT: posix(output),
          GITHUB_ACTOR: ACTOR,
        },
      });
      return { ...r, outputs: kv(output), lines: r.stdout.split('\n').filter(Boolean), text: `${r.stdout}\n${r.stderr}` };
    },
  };
}

function seed(file, fn) {
  const reg = registry();
  try {
    fn(reg);
    saveWorld(reg, file);
  } finally {
    reg.close();
  }
}

function layerJson(file, key, title) {
  const w = readWorld(file);
  const text = w.manifests.get(key);
  assert.ok(text !== undefined, `the double holds ${key}`);
  const layer = JSON.parse(text).layers.find((l) => l.annotations[TITLE] === title);
  return JSON.parse(new TextDecoder().decode(w.bytes.get(layer.digest)));
}

// The plan's inputs of the legs, as the artifact thc-plan carries them.
function download(from, temp) {
  mkdirSync(join(temp, 'thc'), { recursive: true });
  for (const f of readdirSync(from)) if (f === 'plan.json' || f === 'matrix.json' || f === 'state.json' || /^psl-[0-9a-f]{12}\.dat$/.test(f)) copyFileSync(join(from, f), join(temp, 'thc', f));
}

// The live state holds thc-ct's cursor and no history: the baseline of 2026-10-26 is the window's own earlier days,
// which only the plan's state (the leg's --state) carries, so a leg that read state:latest instead would find no
// baseline and call the day ok.
const LIVE = { ...emptyState('2026-10-28T00:00:00Z'), cursors: { 'thc-ct': CURSOR }, moved: { 'thc-ct': { at: '2026-10-28T00:00:00Z', run: '41000000001' } } };

test('ingest-thc scripts: a backfill of four days plans a leg for each listed day, adopts the day a cancelled run pushed, declares the day no host lists, and promotes the six segments in one root with the gap named and the quarantined day marked; a second plan finds every day present', {
  skip: SKIP,
}, (t) => {
  const w = world(t);
  const recordings = hosts(join(w.dir, 'hosts'), { '2026-10-23': SLICE, '2026-10-24': SLICE, '2026-10-26': TINY });
  seed(w.file, (reg) => {
    seedList(reg);
    const root = buildRoot({ live: null, psl: PSL, now: '2026-10-28T00:00:00Z' });
    reg.seedRoot(root, { sources: sourcesLayer({ registry: loadRegistry(DEFAULT_SOURCES), root }) });
    reg.seed('state', 'latest', artifactType('state'), {}, [{ title: 'state.json', bytes: encodeState(LIVE) }]);
  });

  // A backfill cancelled after its leg of 2026-10-24 pushed: its tags are in obs, and no state took them.
  const early = w.job('early-ingest');
  mkdirSync(join(early, 'thc'));
  copyFileSync(PSL_FILE, join(early, 'thc', `psl-${PSL12}.dat`));
  writeFileSync(join(early, 'thc', 'state.json'), encodeState(LIVE));
  const cancelled = w.step(THC, 'run', { REGISTRY_TOKEN: TOKEN, MODE: 'backfill', DAY: '2026-10-24', PSL: PSL12 }, { temp: early, now: '2026-10-27T05:00:00Z', recordings });
  assert.equal(cancelled.status, 0, cancelled.text);
  const t24 = cancelled.lines.filter((l) => l.startsWith('segment ')).map((l) => l.split(' ')[1].slice(4));
  assert.equal(t24.length, 2, cancelled.text);

  // The dispatch -f from=2026-10-23 -f to=2026-10-26.
  const planTemp = w.job('plan');
  const plan = w.step(THC, 'plan', { FROM: '2026-10-23', TO: '2026-10-26' }, { temp: planTemp, now: NOW, recordings });
  assert.equal(plan.status, 0, plan.text);
  assert.deepEqual(
    plan.lines.filter((l) => l.startsWith('day ')),
    [`day 2026-10-23 run ${SLICE.length} hf ok psl ${PSL12}`, `day 2026-10-24 adopt ${t24[0]} ${t24[1]}`, 'day 2026-10-25 gap', `day 2026-10-26 run ${TINY.length} hf quarantine psl ${PSL12}`],
  );
  assert.ok(plan.lines.includes('legs 2 adopted 1 gaps 1'), plan.text);
  assert.deepEqual([plan.outputs.mode, plan.outputs.any, plan.outputs.proposals], ['backfill', 'true', 'true']);
  const legs = JSON.parse(plan.outputs.matrix).include;
  assert.deepEqual(legs, [
    { day: '2026-10-23', psl: PSL12 },
    { day: '2026-10-26', psl: PSL12 },
  ]);

  // The legs, each with the plan's inputs; their proposals and the plan's go to the push job.
  const push = w.job('push');
  mkdirSync(join(push, 'proposals'));
  cpSync(join(planTemp, 'thc', 'proposals'), join(push, 'proposals'), { recursive: true });
  const verdicts = {};
  for (const leg of legs) {
    const temp = w.job(`ingest-${leg.day}`);
    download(join(planTemp, 'thc'), temp);
    const r = w.step(THC, 'run', { REGISTRY_TOKEN: TOKEN, MODE: plan.outputs.mode, DAY: leg.day, PSL: leg.psl }, { temp, now: NOW, recordings });
    assert.equal(r.status, 0, r.text);
    verdicts[leg.day] = r.lines.filter((l) => l.startsWith('segment ')).map((l) => l.split(' ').at(-1));
    assert.ok(
      r.lines.some((l) => new RegExp(`^proposal \\S+proposal\\.thc-ct\\.${leg.day.replaceAll('-', '')}\\.json segments 2 raw 0 history 1 cursor kept$`).test(l)),
      r.text,
    );
    cpSync(join(temp, 'out', 'proposals'), join(push, 'proposals'), { recursive: true });
    if (leg.day === '2026-10-26')
      assert.ok(
        r.lines.some((l) => /^::warning::segment obs:thc-ct\.20261026\.\S+ .* verdict quarantine: served and never new/.test(l)),
        r.text,
      );
  }
  assert.deepEqual(verdicts, { '2026-10-23': ['ok', 'ok'], '2026-10-26': ['quarantine', 'quarantine'] });
  assert.deepEqual(readdirSync(join(push, 'proposals')).sort(), ['proposal.thc-ct.20261023.json', 'proposal.thc-ct.20261024.json', 'proposal.thc-ct.20261025.json', 'proposal.thc-ct.20261026.json']);

  // The job push: four keeping proposals of one adapter, all accepted (D13).
  const advance = w.step(THC, 'advance', { REGISTRY_TOKEN: TOKEN }, { temp: push, now: NOW, recordings });
  assert.equal(advance.status, 0, advance.text);
  assert.equal(advance.lines.filter((l) => l.startsWith('accepted thc-ct ')).length, 4, advance.text);
  assert.ok(advance.lines.includes('gap thc-ct 2026-10-25 pending'), advance.text);
  assert.ok(!advance.text.includes('::warning::'), advance.text);
  const move = w.step(THC, 'move', { REGISTRY_TOKEN: TOKEN }, { temp: push, now: NOW, recordings });
  assert.equal(move.status, 0, move.text);
  const state = parseState(readFileSync(join(push, 'state', 'next.json')));
  assert.deepEqual(state.cursors, { 'thc-ct': CURSOR }, 'a backfill moves no cursor');
  assert.deepEqual(state.gaps, { 'thc-ct': ['2026-10-25'] });
  assert.deepEqual(state.history['thc-ct'], [
    { day: '2026-10-23', count: SLICE.length, quarantined: false },
    { day: '2026-10-24', count: SLICE.length, quarantined: false },
    { day: '2026-10-26', count: TINY.length, quarantined: true },
  ]);
  const add = move.outputs.add.split(' ');
  assert.equal(add.length, 6);
  assert.deepEqual(
    add,
    state.owed.map((o) => o.ref),
  );
  assert.equal(move.outputs.gap, 'thc-ct=2026-10-25');

  // The promotion: one root, the hole of 2026-10-25 named, 2026-10-26 marked quarantined.
  const promote = w.step(
    PROMOTE,
    'move',
    { REGISTRY_TOKEN: TOKEN, ADD: move.outputs.add, REPLACE: '', PSL: '', ROLLBACK_TO: '', GAP: move.outputs.gap, PARTIAL: 'true' },
    { temp: w.job('promote'), now: NOW, recordings },
  );
  assert.equal(promote.status, 0, promote.text);
  assert.doesNotMatch(promote.text, /waiting /);
  const root = layerJson(w.file, 'root:latest', 'root.json');
  assert.equal(root.root_seq, 2);
  assert.deepEqual(root.gaps, { 'thc-ct': ['2026-10-25'] });
  for (const dataset of ['names', 'domains']) {
    const packs = root.datasets[dataset];
    assert.deepEqual(
      packs.map((p) => [p.tag.split('.')[1], p.quarantine ?? false]),
      [
        ['20261023', false],
        ['20261024', false],
        ['20261026', true],
      ],
      dataset,
    );
  }
  assert.deepEqual(root.corpus_since, { domains: '2026-10-23T00:00:00Z', names: '2026-10-23T00:00:00Z' });
  assert.deepEqual(root.through, { 'thc-ct': '2026-10-27T00:00:00Z' });

  // A second dispatch of the window: every day is held, so the plan writes no leg and no proposal.
  const again = w.step(THC, 'plan', { FROM: '2026-10-23', TO: '2026-10-26' }, { temp: w.job('plan-again'), now: '2026-10-28T14:00:00Z', recordings });
  assert.equal(again.status, 0, again.text);
  assert.deepEqual(
    again.lines.filter((l) => l.startsWith('day ')).map((l) => l.split(' ').slice(0, 3).join(' ')),
    ['day 2026-10-23 present', 'day 2026-10-24 present', 'day 2026-10-25 present', 'day 2026-10-26 present'],
  );
  assert.ok(again.lines.includes('legs 0 adopted 0 gaps 0'), again.text);
  assert.deepEqual([again.outputs.any, again.outputs.proposals, again.outputs.matrix], ['false', 'false', '{"include":[]}']);
});
