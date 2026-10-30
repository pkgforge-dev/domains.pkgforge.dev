// scripts/ingest/plan.mjs: the lanes of one run of ingest-live.yml and its
// backfill window (D13 and D17 of DOM-024), over the synthetic fixtures of
// scripts/ingest/fixtures/ (two adapters, a registry built from them, a lanes
// file) and the tree's own config/lanes.json, which holds no adapter yet.
//
//   node scripts/test.mjs scripts/ingest --name plan
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ROOT } from '../files.mjs';
import { EXIT, main, PLAN_FORMAT, readLanes } from './plan.mjs';

const F = fileURLToPath(new URL('./fixtures', import.meta.url));
const FIXTURE = ['--lanes', join(F, 'lanes.json'), '--sources', join(F, 'sources.json'), '--adapters', join(F, 'adapters'), '--now', '2026-10-30T08:35:00Z'];
// FIXTURE with the value of each flag of `over` replaced: a flag is given once.
const fx = (over) => FIXTURE.map((x, i) => (i > 0 && Object.hasOwn(over, FIXTURE[i - 1]) ? over[FIXTURE[i - 1]] : x));

async function inTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'ingest-plan-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function plan(dir, argv) {
  const out = [];
  const err = [];
  const file = join(dir, 'plan.json');
  const code = await main(['--out', file, ...argv], { out: (l) => out.push(l), err: (l) => err.push(l) });
  let json = null;
  try {
    json = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    // No plan file: the run refused before it wrote one.
  }
  return { code, out, err, json, text: `${out.join('\n')}\n${err.join('\n')}` };
}

test('plan: every lane runs its adapters, and the plan file says so', () =>
  inTmp(async (dir) => {
    const r = await plan(dir, FIXTURE);
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out, ['lane kafka fixture-stream', 'lane tiles none', 'lane feeds fixture-file', 'window none']);
    assert.deepEqual(r.json, { format: PLAN_FORMAT, lanes: { kafka: ['fixture-stream'], tiles: [], feeds: ['fixture-file'] }, any: true, from: null, to: null });
  }));

test('plan: --only keeps the adapters of the named sources, separated by spaces or commas', () =>
  inTmp(async (dir) => {
    const one = await plan(dir, [...FIXTURE, '--only', 'isc-new']);
    assert.equal(one.code, EXIT.ok, one.text);
    assert.deepEqual(one.json.lanes, { kafka: [], tiles: [], feeds: ['fixture-file'] });
    const both = await plan(dir, [...FIXTURE, '--only', ' oi-cs,  isc-new ']);
    assert.deepEqual(both.json.lanes, { kafka: ['fixture-stream'], tiles: [], feeds: ['fixture-file'] });
    const unknown = await plan(dir, [...FIXTURE, '--only', 'oi-cs thc-ct']);
    assert.equal(unknown.code, EXIT.usage);
    assert.match(unknown.text, /--only names thc-ct, which is not a source of the registry/);
    const empty = await plan(dir, [...FIXTURE, '--only', ', ']);
    assert.equal(empty.code, EXIT.usage);
    assert.match(empty.text, /--only names no source/);
  }));

test('plan: a source whose adapter is in no lane is refused', () =>
  inTmp(async (dir) => {
    const lanes = join(dir, 'lanes.json');
    writeFileSync(lanes, JSON.stringify({ format: 'domains.lanes.v1', comment: 'x', lanes: { kafka: ['fixture-stream'], tiles: [], feeds: [] } }));
    const r = await plan(dir, [...fx({ '--lanes': lanes }), '--only', 'isc-new']);
    assert.equal(r.code, EXIT.usage);
    assert.match(r.text, /--only names isc-new, whose adapter fixture-file runs in no lane of ingest-live\.yml/);
  }));

test('plan: a backfill window is both ends to the second, from before to, to not after now, and only with --only (D17 of DOM-024)', () =>
  inTmp(async (dir) => {
    const ok = await plan(dir, [...FIXTURE, '--only', 'oi-cs', '--from', '2026-10-30T08:00:00Z', '--to', '2026-10-30T08:20:00Z']);
    assert.equal(ok.code, EXIT.ok, ok.text);
    assert.equal(ok.out.at(-1), 'window 2026-10-30T08:00:00Z 2026-10-30T08:20:00Z');
    assert.deepEqual([ok.json.from, ok.json.to, ok.json.lanes.kafka], ['2026-10-30T08:00:00Z', '2026-10-30T08:20:00Z', ['fixture-stream']]);
    const refused = [
      [['--only', 'oi-cs', '--from', '2026-10-30T08:00:00Z'], /--from and --to come together/],
      [['--only', 'oi-cs', '--to', '2026-10-30T08:00:00Z'], /--from and --to come together/],
      [['--from', '2026-10-30T08:00:00Z', '--to', '2026-10-30T08:20:00Z'], /names its sources with --only/],
      [['--only', 'oi-cs', '--from', '2026-10-30T08:00Z', '--to', '2026-10-30T08:20:00Z'], /--from "2026-10-30T08:00Z" is not YYYY-MM-DDTHH:MM:SSZ/],
      [['--only', 'oi-cs', '--from', '2026-10-30T08:00:00.000Z', '--to', '2026-10-30T08:20:00Z'], /is not YYYY-MM-DDTHH:MM:SSZ/],
      [['--only', 'oi-cs', '--from', '2026-10-30T08:00:00Z', '--to', '2026-10-30T08:20Z'], /--to "2026-10-30T08:20Z" is not YYYY-MM-DDTHH:MM:SSZ/],
      [['--only', 'oi-cs', '--from', '2026-02-30T08:00:00Z', '--to', '2026-10-30T08:20:00Z'], /is not YYYY-MM-DDTHH:MM:SSZ/],
      [['--only', 'oi-cs', '--from', '2026-10-30T08:20:00Z', '--to', '2026-10-30T08:20:00Z'], /is not before --to/],
      [['--only', 'oi-cs', '--from', '2026-10-30T08:00:00Z', '--to', '2026-10-30T08:35:01Z'], /is after the run's now, 2026-10-30T08:35:00Z/],
      // A time is of the years 1000 to 9999, which a tag names.
      [['--only', 'oi-cs', '--from', '0001-01-01T00:00:00Z', '--to', '0001-01-02T00:00:00Z'], /--from "0001-01-01T00:00:00Z" is not YYYY-MM-DDTHH:MM:SSZ/],
    ];
    for (const [argv, why] of refused) {
      const r = await plan(dir, [...FIXTURE, ...argv]);
      assert.equal(r.code, EXIT.usage, argv.join(' '));
      assert.match(r.text, why, argv.join(' '));
    }
    // --to may be the run's now itself: a window that ended now was published.
    const edge = await plan(dir, [...FIXTURE, '--only', 'oi-cs', '--from', '2026-10-30T08:00:00Z', '--to', '2026-10-30T08:35:00Z']);
    assert.equal(edge.code, EXIT.ok, edge.text);
  }));

test('plan: the tree holds no adapter yet, so no lane runs one: any is false', () =>
  inTmp(async (dir) => {
    const r = await plan(dir, []);
    assert.equal(r.code, EXIT.ok, r.text);
    assert.deepEqual(r.out, ['lane kafka none', 'lane tiles none', 'lane feeds none', 'window none']);
    assert.deepEqual(r.json, { format: PLAN_FORMAT, lanes: { kafka: [], tiles: [], feeds: [] }, any: false, from: null, to: null });
    assert.deepEqual(readLanes(join(ROOT, 'config', 'lanes.json'), join(ROOT, 'adapters')), { kafka: [], tiles: [], feeds: [] });
  }));

test('plan: a lanes file that is not exactly the three sorted lanes of existing adapters, one lane each, is refused', () =>
  inTmp(async (dir) => {
    const lanes = join(dir, 'lanes.json');
    const cases = [
      [{ format: 'domains.lanes.v2', comment: '', lanes: { kafka: [], tiles: [], feeds: [] } }, /format is "domains\.lanes\.v2"/],
      [{ format: 'domains.lanes.v1', comment: '', lanes: { kafka: [], tiles: [] } }, /lanes holds exactly kafka, tiles, feeds/],
      [{ format: 'domains.lanes.v1', comment: '', lanes: { kafka: [], tiles: [], feeds: [], vps: [] } }, /lanes holds exactly/],
      [{ format: 'domains.lanes.v1', lanes: { kafka: [], tiles: [], feeds: [] } }, /holds exactly format, comment and lanes/],
      [{ format: 'domains.lanes.v1', comment: '', lanes: { kafka: ['fixture-stream', 'fixture-file'], tiles: [], feeds: [] } }, /not sorted and distinct/],
      [{ format: 'domains.lanes.v1', comment: '', lanes: { kafka: ['fixture-stream'], tiles: ['fixture-stream'], feeds: [] } }, /fixture-stream is in the lanes kafka and tiles/],
      [{ format: 'domains.lanes.v1', comment: '', lanes: { kafka: ['oi-cs'], tiles: [], feeds: [] } }, /kafka names oi-cs, and .+source\.json does not exist/],
      [{ format: 'domains.lanes.v1', comment: '', lanes: { kafka: ['Bad'], tiles: [], feeds: [] } }, /is not an adapter directory's name/],
      [{ format: 'domains.lanes.v1', comment: '', lanes: { kafka: ['fixture-stream', 'fixture-stream'], tiles: [], feeds: [] } }, /the lane kafka is not sorted and distinct at fixture-stream/],
      [{ format: 'domains.lanes.v1', comment: 7, lanes: { kafka: [], tiles: [], feeds: [] } }, /comment is not a string/],
      [{ format: 'domains.lanes.v1', comment: '', lanes: { kafka: 'fixture-stream', tiles: [], feeds: [] } }, /the lane kafka is not a list/],
      [{ format: 'domains.lanes.v1', comment: '', lanes: { kafka: [`a${'-b'.repeat(32)}`], tiles: [], feeds: [] } }, /is not an adapter directory's name/],
    ];
    for (const [json, why] of cases) {
      writeFileSync(lanes, JSON.stringify(json));
      const r = await plan(dir, fx({ '--lanes': lanes }));
      assert.equal(r.code, EXIT.usage, JSON.stringify(json));
      assert.match(r.text, why, JSON.stringify(json));
    }
    writeFileSync(lanes, '{');
    assert.equal((await plan(dir, fx({ '--lanes': lanes }))).code, EXIT.usage);
    // A lane's adapter whose source.json is a directory: named as no file.
    const adapters = join(dir, 'ad');
    mkdirSync(join(adapters, 'fake', 'source.json'), { recursive: true });
    writeFileSync(lanes, JSON.stringify({ format: 'domains.lanes.v1', comment: '', lanes: { kafka: ['fake'], tiles: [], feeds: [] } }));
    const r = await plan(dir, fx({ '--lanes': lanes, '--adapters': adapters }));
    assert.equal(r.code, EXIT.usage, r.text);
    assert.match(r.text, /kafka names fake, and .+source\.json is not a file/);
  }));

test('plan: usage, a registry that does not validate and an output that cannot be written are exit 2', () =>
  inTmp(async (dir) => {
    const bad = join(dir, 'sources.json');
    writeFileSync(bad, JSON.stringify({ format: 'domains.sources.v1', comment: 'x', sources: [{ id: 'oi-cs' }] }));
    const reg = await plan(dir, fx({ '--sources': bad }));
    assert.equal(reg.code, EXIT.usage);
    assert.match(reg.text, /the registry .+ does not read or validate/);
    assert.equal((await plan(dir, [...FIXTURE, '--lane', 'kafka'])).code, EXIT.usage);
    // A flag of one value given twice is refused, never the last taken.
    const twice = await plan(dir, [...FIXTURE, '--now', '2026-10-30T09:00:00Z']);
    assert.equal(twice.code, EXIT.usage, twice.text);
    assert.match(twice.text, /--now is given twice/);
    assert.equal(twice.json, null, 'no plan written');
    // --now is a time to the second, as the window it bounds.
    const minute = await plan(dir, fx({ '--now': '2026-10-30T08:35Z' }));
    assert.equal(minute.code, EXIT.usage, minute.text);
    assert.match(minute.text, /--now "2026-10-30T08:35Z" is not YYYY-MM-DDTHH:MM:SSZ/);
    // --out is checked before anything is read: a directory that is not there is named, not the lanes file that does not read.
    const early = [];
    const io = { out: (l) => early.push(l), err: (l) => early.push(l) };
    assert.equal(await main(['--out', join(dir, 'no', 'such', 'plan.json'), ...fx({ '--lanes': join(dir, 'absent.json') })], io), EXIT.usage);
    assert.match(early.join('\n'), /^plan: --out .+plan\.json: its directory .+such is not there$/m);
    assert.equal(await main(['--out', dir, ...FIXTURE], io), EXIT.usage);
    assert.match(early.join('\n'), /^plan: --out .+ is a directory, not a file$/m);
    assert.doesNotMatch(early.join('\n'), /lanes file/);
    const out = [];
    assert.equal(await main([...FIXTURE], { out: (l) => out.push(l), err: (l) => out.push(l) }), EXIT.usage);
    assert.equal(await main(['--out', join(dir, 'no', 'such', 'plan.json'), ...FIXTURE], { out: (l) => out.push(l), err: (l) => out.push(l) }), EXIT.usage);
    assert.match(out.join('\n'), /--out is needed/);
  }));
