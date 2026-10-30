// The steps of .github/workflows/ingest-live.yml over the real scripts
// (DOM-024), with the two other workflows that share its packages: the
// promotion of root-promote.yml and the ledger steps of the job `push` of
// compact-daily.yml. scripts/workflows/ingest-live.test.mjs runs each step
// with a double for each script, built from the scripts' flags, lines, files
// and exit codes; this file runs the steps of the jobs plan, ingest and push
// over the scripts themselves, so a script that changes a flag, a line, a
// file or an exit code that one of those steps reads fails here. The steps of
// the job chain are not run here: scripts/ingest/chain.test.mjs runs the
// script with a double of gh.
//
// Each step is cut from its workflow (stepScript) and run under bash (runStep,
// with -e and pipefail, as GitHub runs it), with a bash function `node` that
// runs scripts/workflows/script-world.mjs: the step's script runs by its own
// main against the GHCR double of scripts/root/fixture.mjs, which is kept in a
// file between the steps, and gets the step's arguments and environment
// unchanged, with the fixture paths a runner's tree gives by default and the
// run's clock after them. Each job has a RUNNER_TEMP of its own; the upload
// and download of the proposals is a copy, as merge-multiple puts every leg's
// files in one directory. Everything is synthetic: the two fixture adapters
// of scripts/ingest/fixtures/, their recordings, a first root pinning the
// fixture list, and a ledger filter written here. Where bash or jq is missing
// the test is skipped and says so, and a skip is not a pass.
//
//   node scripts/test.mjs scripts/workflows --name "ingest-live scripts"
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { BloomFilter, EPOCH_MS, hashKey } from '@domains/ledger';
import { parseState } from '@domains/state';
import { parse } from 'yaml';
import { ROOT } from '../files.mjs';
import { seedRoot } from '../ingest/fixture.mjs';
import { BASH, JQ, runStep, stepScript } from '../lib/workflow-step.mjs';
import { ACTOR, registry, TOKEN } from '../root/fixture.mjs';
import { readWorld, saveWorld } from './script-world.mjs';

const WORKFLOWS = join(ROOT, '.github', 'workflows');
const LIVE = join(WORKFLOWS, 'ingest-live.yml');
const DAILY = join(WORKFLOWS, 'compact-daily.yml');
const PROMOTE = join(WORKFLOWS, 'root-promote.yml');
const DRIVER = fileURLToPath(new URL('./script-world.mjs', import.meta.url));
const SKIP = !BASH ? 'no bash on this machine, so the steps were not run' : !JQ ? 'no jq on this machine, so the steps were not run' : false;
const posix = (p) => p.replaceAll('\\', '/');
const TITLE = 'org.opencontainers.image.title';
const NOW1 = '2026-10-30T08:35:00Z';
const NOW2 = '2026-10-30T09:05:00Z';
// The six segments of the first run: two windows of the stream fixture, a
// names and a domains segment each, and the two days of the file fixture.
const STREAM = ['oi-cs.20261030t080000z.20261030t081000z', 'oi-cs.20261030t080000z.20261030t081000z-d', 'oi-cs.20261030t081000z.20261030t082000z', 'oi-cs.20261030t081000z.20261030t082000z-d'];

const kv = (path) =>
  existsSync(path)
    ? Object.fromEntries(
        readFileSync(path, 'utf8')
          .split('\n')
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).replace(/\r$/, '')]),
      )
    : {};

// The environment of the step `id` of `file` as GitHub builds it: every
// variable the workflow, its job and the step declare, an expression taking
// the value the test gives. A value the step does not declare is refused, so
// no step passes on a variable the workflow never sets; REGISTRY_TOKEN is
// empty in a step that holds none.
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

// One world: the double's file, a directory a job, and the steps run in it.
function world(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-live-scripts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'world.json');
  let n = 0;
  return {
    file,
    job: (name) => {
      const temp = join(dir, name);
      mkdirSync(temp, { recursive: true });
      return temp;
    },
    // The step `id` of `file` in the job whose RUNNER_TEMP is `temp`, at `now`:
    // its status, its lines and its outputs.
    step(wf, id, given, { temp, now }) {
      const output = join(dir, `output-${++n}.txt`);
      const script = `node() { "$JOIN_NODE" "$JOIN_DRIVER" "$@"; }\nset -eo pipefail\n${stepScript(wf, id)}`;
      const r = runStep(t, script, {
        env: {
          ...stepEnv(wf, id, given),
          JOIN_NODE: posix(process.execPath),
          JOIN_DRIVER: posix(DRIVER),
          JOIN_WORLD: posix(file),
          JOIN_NOW: now,
          RUNNER_TEMP: posix(temp),
          GITHUB_OUTPUT: posix(output),
          GITHUB_ACTOR: ACTOR,
        },
      });
      return { ...r, outputs: kv(output), lines: r.stdout.split('\n').filter(Boolean), text: `${r.stdout}\n${r.stderr}` };
    },
  };
}

// The double, seeded in-process and saved to the world's file.
function seed(file, fn) {
  const reg = registry();
  try {
    fn(reg);
    saveWorld(reg, file);
  } finally {
    reg.close();
  }
}

// The one layer `title` of the manifest PKG:REF in the world's file, parsed as JSON.
function layerJson(file, key, title) {
  const w = readWorld(file);
  const text = w.manifests.get(key);
  assert.ok(text !== undefined, `the double holds ${key}`);
  const layer = JSON.parse(text).layers.find((l) => l.annotations[TITLE] === title);
  return JSON.parse(new TextDecoder().decode(w.bytes.get(layer.digest)));
}

// One run of ingest-live.yml at `now`, dispatched with `sources` (empty: every
// lane): plan, a leg a lane, push, and the promotion when push gives add.
// Returns each step's result.
function liveRun(w, now, label, sources = '') {
  const plan = w.step(LIVE, 'plan', { SOURCES: sources, FROM: '', TO: '' }, { temp: w.job(`${label}-plan`), now });
  assert.equal(plan.status, 0, plan.text);
  const legs = JSON.parse(plan.outputs.matrix).include;
  const push = w.job(`${label}-push`);
  const ran = {};
  for (const leg of legs) {
    const temp = w.job(`${label}-ingest-${leg.lane}`);
    // toJSON of an expression prints the list over several lines.
    ran[leg.lane] = w.step(LIVE, 'run', { REGISTRY_TOKEN: TOKEN, LANE: leg.lane, ADAPTERS: JSON.stringify(leg.adapters, null, 2), FROM: plan.outputs.from, TO: plan.outputs.to }, { temp, now });
    if (existsSync(join(temp, 'out', 'proposals'))) cpSync(join(temp, 'out', 'proposals'), join(push, 'proposals'), { recursive: true });
  }
  const advance = w.step(LIVE, 'advance', { REGISTRY_TOKEN: TOKEN }, { temp: push, now });
  const hours = w.step(LIVE, 'hours', { REGISTRY_TOKEN: TOKEN }, { temp: push, now });
  const move = w.step(LIVE, 'move', { REGISTRY_TOKEN: TOKEN }, { temp: push, now });
  let promote = null;
  if (move.status === 0 && move.outputs.add !== '')
    // The inputs the job promote of ingest-live.yml gives root-promote.yml: add, and partial true.
    promote = w.step(PROMOTE, 'move', { REGISTRY_TOKEN: TOKEN, ADD: move.outputs.add, REPLACE: '', PSL: '', ROLLBACK_TO: '', PARTIAL: 'true' }, { temp: w.job(`${label}-promote`), now });
  return { plan, legs, ran, advance, hours, move, promote, next: join(push, 'state', 'next.json') };
}

// The live root and the refs PKG:TAG of the packs it names, sorted.
function rootRefs(file) {
  const root = layerJson(file, 'root:latest', 'root.json');
  return {
    root,
    refs: Object.values(root.datasets)
      .flatMap((packs) => packs.map((p) => `${p.repo.split('/').at(-1)}:${p.tag}`))
      .sort(),
  };
}

test('ingest-live scripts: a dispatch of oi-cs runs the kafka lane alone, moves state:latest with what it owes, and the promotion adds every owed segment to the root', { skip: SKIP }, (t) => {
  const w = world(t);
  seed(w.file, (reg) => seedRoot(reg));
  const r = liveRun(w, NOW1, 'run1', 'oi-cs');

  assert.deepEqual(
    r.legs.map((l) => [l.lane, l.adapters]),
    [['kafka', ['fixture-stream']]],
  );
  assert.deepEqual([r.plan.outputs.any, r.plan.outputs.from, r.plan.outputs.to], ['true', '', '']);
  const run = r.ran.kafka;
  assert.equal(run.status, 0, run.text);
  assert.ok(run.lines.includes('cursor fixture-stream none (state:latest none)'), run.text);
  assert.ok(
    run.lines.some((l) => /^proposal \S+proposal\.fixture-stream\.json segments 4 raw 2 history 0 cursor moved$/.test(l)),
    run.text,
  );
  // Each raw lane object is pushed before the segments that name it.
  const pushed = run.lines.filter((l) => l.startsWith('pushed ')).map((l) => l.split(' ')[1].split(':').at(-1));
  assert.deepEqual(pushed.slice(0, 2), ['raw-oi-cs.20261030t080000z.20261030t081000z', 'raw-oi-cs.20261030t081000z.20261030t082000z']);
  assert.deepEqual(pushed.slice(2).sort(), STREAM);

  assert.equal(r.advance.status, 0, r.advance.text);
  assert.equal(r.advance.lines[0], 'live state:latest none');
  assert.deepEqual(
    r.advance.lines.filter((l) => l.startsWith('accepted ')),
    ['accepted fixture-stream segments 4 raw 2 history 0 cursor moved'],
  );
  assert.ok(!r.advance.text.includes('::warning::'), r.advance.text);
  // No closed hour of the lookback holds a segment (the windows end at
  // 08:20, in the open hour): no hour pack, and the step is green.
  assert.equal(r.hours.status, 0, r.hours.text);
  assert.equal(r.hours.lines.at(-1), 'hours none to build', r.hours.text);

  // The move: latest is the run object of the next state, and add is what it owes.
  assert.equal(r.move.status, 0, r.move.text);
  const next = parseState(readFileSync(r.next));
  assert.deepEqual(next.cursors, { 'fixture-stream': { next: 2 } });
  const add = r.move.outputs.add.split(' ');
  assert.deepEqual(
    add,
    next.owed.map((o) => o.ref),
  );
  assert.deepEqual(
    [...add].sort(),
    STREAM.map((s) => `obs:${s}`),
  );
  assert.ok(
    r.move.lines.some((l) => /^moved state:latest none -> sha256:[0-9a-f]{64}, read back with no credential$/.test(l)),
    r.move.text,
  );
  assert.ok(
    r.move.lines.some((l) => /^snapshot state:state-20261030 sha256:/.test(l)),
    r.move.text,
  );
  assert.deepEqual(layerJson(w.file, 'state:latest', 'state.json'), JSON.parse(readFileSync(r.next, 'utf8')));

  // The promotion of root-promote.yml adds every owed pack.
  assert.equal(r.promote.status, 0, r.promote.text);
  const { root, refs } = rootRefs(w.file);
  assert.equal(root.root_seq, 2);
  assert.deepEqual(refs, [...add].sort());
});

test('ingest-live scripts: after a compaction moves ledger-delta onto its filter, the next run reads its cursors from state:latest, settles what the root holds, waits green on an hour with a hole, and the promotion leaves the segments across a hole waiting and owed', {
  skip: SKIP,
}, (t) => {
  const w = world(t);
  seed(w.file, (reg) => seedRoot(reg));
  const first = liveRun(w, NOW1, 'run1', 'oi-cs');
  assert.equal(first.promote?.status, 0, first.promote?.text ?? first.move.text);

  // The job push of compact-daily.yml, for the day 2026-10-29: its filter
  // pushed once (push.mjs), then ledger-delta moved onto it (move.mjs --onto).
  const daily = w.job('daily-push');
  const dayDir = join(daily, 'days', 'day.2026-10-29');
  mkdirSync(join(dayDir, 'ledger'), { recursive: true });
  writeFileSync(join(dayDir, 'day.json'), JSON.stringify({ day: '2026-10-29', ledger: { tag: 'ledger-filter-20261029' } }));
  const filter = BloomFilter.forKeys(10, { asOf: (Date.parse('2026-10-30T00:00:00Z') - EPOCH_MS) / 1000 });
  filter.add(hashKey('com.synthetic-old'));
  writeFileSync(join(dayDir, 'ledger', 'filter.dlbf'), filter.encode());
  const filters = w.step(DAILY, 'filters', { REGISTRY_TOKEN: TOKEN }, { temp: daily, now: NOW2 });
  assert.equal(filters.status, 0, filters.text);
  assert.equal(filters.outputs.newest, '2026-10-29');
  const delta = w.step(DAILY, 'delta', { REGISTRY_TOKEN: TOKEN, NEWEST: filters.outputs.newest }, { temp: daily, now: NOW2 });
  assert.equal(delta.status, 0, delta.text);
  assert.ok(delta.lines.includes('started state:ledger-delta empty, paired with state:ledger-filter-20261029'), delta.text);
  assert.ok(
    delta.lines.some((l) => /^moved state:ledger-delta none -> sha256:/.test(l)),
    delta.text,
  );
  // Moved again onto the same filter, the delta is present: nothing moves.
  const again = w.step(DAILY, 'delta', { REGISTRY_TOKEN: TOKEN, NEWEST: filters.outputs.newest }, { temp: daily, now: NOW2 });
  assert.equal(again.status, 0, again.text);
  assert.ok(
    again.lines.some((l) => /^present state:ledger-delta sha256:[0-9a-f]{64}: it pairs with state:ledger-filter-20261029 already$/.test(l)),
    again.text,
  );

  // The second run, every lane.
  const r = liveRun(w, NOW2, 'run2');
  assert.deepEqual(
    r.legs.map((l) => l.lane),
    ['kafka', 'feeds'],
  );
  // The stream lane reads the cursor the first run moved, and has nothing new.
  assert.equal(r.ran.kafka.status, 0, r.ran.kafka.text);
  assert.ok(
    r.ran.kafka.lines.some((l) => /^cursor fixture-stream \{"next":2\} \(state:latest sha256:[0-9a-f]{64}\)$/.test(l)),
    r.ran.kafka.text,
  );
  assert.ok(r.ran.kafka.lines.includes('no proposal: no segment was written and the cursor did not move'), r.ran.kafka.text);
  // The file lane has no cursor in state yet, and pushes its two days.
  assert.equal(r.ran.feeds.status, 0, r.ran.feeds.text);
  assert.ok(
    r.ran.feeds.lines.some((l) => /^cursor fixture-file none \(state:latest sha256:[0-9a-f]{64}\)$/.test(l)),
    r.ran.feeds.text,
  );
  // The four segments the first promotion added are held by the root, and leave owed.
  assert.equal(r.advance.status, 0, r.advance.text);
  assert.equal(r.advance.lines.filter((l) => /^settled obs:oi-cs\.\S+ held root_seq 2 names /.test(l)).length, 4, r.advance.text);
  assert.ok(r.advance.lines.includes('accepted fixture-file segments 2 raw 0 history 2 cursor moved'), r.advance.text);
  assert.ok(r.advance.lines.includes('next changed owed 2'), r.advance.text);
  // The hour 08 holds the root's stream segments of 08:00 to 08:20 only: a
  // hole, so hour.mjs exits 3 and the step stays green, building nothing.
  assert.equal(r.hours.status, 0, r.hours.text);
  assert.ok(
    r.hours.lines.some((l) => /^ledger filter state:ledger-filter-20261029 sha256:[0-9a-f]{64} delta sha256:/.test(l)),
    r.hours.text,
  );
  assert.ok(r.hours.lines.includes('hour 2026103008 wait'), r.hours.text);
  assert.ok(
    r.hours.lines.some((l) => l.startsWith('an hour waits (scripts/state/hours.mjs exited 3)')),
    r.hours.text,
  );
  assert.ok(![...readWorld(w.file).manifests.keys()].some((k) => k.startsWith('feed:')), 'no hour pack is pushed');
  // The move owes the file lane's two days, and the promotion, with
  // --partial, tries them. The live-set rule of the root takes neither: with
  // either one, domains would hold isc-new up to 2026-10-29T00:00Z or
  // 2026-10-30T00:00Z and oi-cs from 08:00Z, a hole between (checkLiveSet of
  // packages/root). Each prints waiting, nothing else changes, and the step
  // is green with latest unmoved. The state, moved first, keeps them owed
  // (D4 of DOM-024).
  assert.equal(r.move.status, 0, r.move.text);
  const owed = parseState(readFileSync(r.next)).owed.map((o) => o.ref);
  assert.deepEqual(r.move.outputs.add.split(' '), owed);
  assert.ok(owed.length === 2 && owed.every((ref) => /^obs:isc-new\.2026102[89]\.[0-9a-f]{12}-d$/.test(ref)), owed.join(' '));
  const waiting = (p) => {
    assert.equal(p.status, 0, p.text);
    assert.deepEqual(
      p.lines.filter((l) => l.startsWith('waiting ')),
      owed.map((ref) => `waiting ${ref}: datasets.domains: a hole from ${ref.includes('.20261028.') ? '2026-10-29' : '2026-10-30'}T00:00:00Z to 2026-10-30T08:00:00Z: no pack covers it`),
    );
    assert.match(p.lines.at(-1), /^unchanged root:latest sha256:[0-9a-f]{64} root_seq 2: nothing to promote, nothing written$/);
    assert.doesNotMatch(p.text, /::error::/);
  };
  waiting(r.promote);
  assert.equal(rootRefs(w.file).root.root_seq, 2);
  const state = layerJson(w.file, 'state:latest', 'state.json');
  assert.deepEqual(state.cursors, { 'fixture-file': { last_day: '2026-10-29' }, 'fixture-stream': { next: 2 } });
  assert.deepEqual(
    state.owed.map((o) => o.ref),
    owed,
  );

  // The next run adds them again: nothing settles them while the root lacks
  // them, and they wait again until a pack covers the hole or they expire.
  const third = liveRun(w, '2026-10-30T09:20:00Z', 'run3');
  assert.equal(third.advance.status, 0, third.advance.text);
  assert.ok(third.advance.lines.includes('next unchanged owed 2'), third.advance.text);
  assert.equal(third.move.status, 0, third.move.text);
  assert.ok(
    third.move.lines.some((l) => /^unchanged state:latest sha256:/.test(l)),
    third.move.text,
  );
  assert.deepEqual(third.move.outputs.add.split(' '), owed);
  waiting(third.promote);
  assert.equal(rootRefs(w.file).root.root_seq, 2);
  assert.deepEqual(
    layerJson(w.file, 'state:latest', 'state.json').owed.map((o) => o.ref),
    owed,
  );
});
