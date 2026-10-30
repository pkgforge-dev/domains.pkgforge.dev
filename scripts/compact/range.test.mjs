// scripts/compact/range.mjs: the two stages of one range, as the matrix runs
// them, held to `all` in one process, from files or from the GHCR double of
// scripts/root/fixture.mjs. Real packs of synthetic records
// (scripts/compact/fixture.mjs); each refusal is planted alone.
//
//   node scripts/test.mjs scripts/compact --name "range cli"
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CompactError, planRanges, writeRange } from '@domains/compact';
import { artifactType, GhcrError } from '@domains/ghcr';
import { PackError, readIdx } from '@domains/pack';
import { canonical, SOURCES_LAYER_FORMAT } from '@domains/root';
import { RateLimitError } from '../ghcr/rate.mjs';
import { registry } from '../root/fixture.mjs';
import { Fault } from '../root/lib.mjs';
import { main as assembleMain } from './assemble.mjs';
import { plannedWeek } from './fixture.mjs';
import { EXIT, main } from './range.mjs';

async function call(fn, argv, deps = {}) {
  const out = [];
  const err = [];
  const code = await fn(argv, { out: (l) => out.push(l), err: (l) => err.push(l), sleep: async () => undefined, ...deps });
  return { code, out, err, text: `${out.join('\n')}\n${err.join('\n')}` };
}

async function inTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'compact-range-'));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A plan file edited and given the id of its edited body (planFile of
// packages/compact), so a check past the id is reached.
function reId(body) {
  const { id: _, ...rest } = body;
  return { ...rest, id: createHash('sha256').update(canonical(rest)).digest('hex') };
}

const filesOf = (dir) =>
  Object.fromEntries(
    readdirSync(dir)
      .sort()
      .map((n) => [n, readFileSync(join(dir, n))]),
  );

test('range cli: count and write range by range, each in a directory of its own, give the files `all` gives', () =>
  inTmp(async (dir) => {
    const w = await plannedWeek(dir);
    const counts = join(dir, 'counts');
    for (let r = 0; r < 3; r += 1) {
      const c = await call(main, ['count', '--plan', w.planPath, '--range', String(r), '--inputs', w.inputsDir, '--out', counts]);
      assert.equal(c.code, EXIT.ok, c.text);
      assert.match(c.out[0], new RegExp(`^count key ${r} of 3: \\d+ records \\(\\d+ input records\\)`));
    }
    const jobs = {};
    for (let r = 0; r < 3; r += 1) {
      const job = join(dir, `job${r}`);
      const x = await call(main, ['write', '--plan', w.planPath, '--range', String(r), '--counts', counts, '--inputs', w.inputsDir, '--out', job]);
      assert.equal(x.code, EXIT.ok, x.text);
      assert.match(x.text, new RegExp(`^check key ${r}: (\\d+) records, the inputs' \\1 distinct keys`, 'm'));
      Object.assign(jobs, filesOf(job));
    }
    const all = join(dir, 'all');
    const a = await call(main, ['all', '--plan', w.planPath, '--inputs', w.inputsDir, '--out', all]);
    assert.equal(a.code, EXIT.ok, a.text);
    const single = filesOf(all);
    for (const name of Object.keys(single).filter((n) => n.startsWith('count.'))) delete single[name];
    assert.deepEqual(Object.keys(jobs).sort(), Object.keys(single).sort());
    for (const [name, bytes] of Object.entries(single)) assert.deepEqual(jobs[name], bytes, name);
    assert.ok(Object.keys(single).includes('part.000'));
  }));

test('range cli: a file that exists, a plan of ranges with no counts, or a flag out of place is exit 2', () =>
  inTmp(async (dir) => {
    const w = await plannedWeek(dir);
    const out = join(dir, 'out');
    assert.equal((await call(main, ['count', '--plan', w.planPath, '--range', '0', '--inputs', w.inputsDir, '--out', out])).code, EXIT.ok);
    const again = await call(main, ['count', '--plan', w.planPath, '--range', '0', '--inputs', w.inputsDir, '--out', out]);
    assert.equal(again.code, EXIT.usage, again.text);
    assert.match(again.text, /count\.key\.000\.json exists: a range writes into a new directory/);
    const noCounts = await call(main, ['write', '--plan', w.planPath, '--range', '1', '--inputs', w.inputsDir, '--out', join(dir, 'x')]);
    assert.equal(noCounts.code, EXIT.usage, noCounts.text);
    assert.match(noCounts.text, /--counts DIR is needed/);
    for (const argv of [
      ['merge', '--plan', w.planPath, '--out', out],
      ['all', '--plan', w.planPath, '--range', '0', '--out', out],
      ['count', '--plan', w.planPath, '--out', out],
      ['write', '--plan', join(dir, 'none.json'), '--range', '0', '--out', out],
    ]) {
      assert.equal((await call(main, argv)).code, EXIT.usage, argv.join(' '));
    }
  }));

test("range cli: counts of another plan, or an input that is not the plan's, is a fault, exit 1", () =>
  inTmp(async (dir) => {
    const w = await plannedWeek(dir);
    const other = await plannedWeek(join(dir, 'other'), 'names', 2);
    const counts = join(dir, 'counts');
    for (let r = 0; r < 2; r += 1) assert.equal((await call(main, ['count', '--plan', other.planPath, '--range', String(r), '--inputs', other.inputsDir, '--out', counts])).code, EXIT.ok);
    const x = await call(main, ['write', '--plan', w.planPath, '--range', '0', '--counts', counts, '--inputs', w.inputsDir, '--out', join(dir, 'job')]);
    assert.equal(x.code, EXIT.fault, x.text);
    assert.match(x.text, /range: FAIL plan the count of range 0 is of the plan [0-9a-f]{64}, not [0-9a-f]{64}/);
    // A part of an input cut by one byte: the index the plan names holds it to its size.
    const part = join(w.inputs[4].dir, 'part.000');
    const whole = readFileSync(part);
    writeFileSync(part, whole.subarray(0, -1));
    const cut = await call(main, ['count', '--plan', w.planPath, '--range', '0', '--inputs', w.inputsDir, '--out', join(dir, 'c2')]);
    assert.equal(cut.code, EXIT.fault, cut.text);
    assert.match(cut.text, /range: FAIL tiling part 0: the index gives it \d+ B and the store holds \d+ B/);
    writeFileSync(part, whole);
    // An index of another pack.
    const idx = join(w.inputs[4].dir, 'idx');
    cpSync(join(w.inputs[5].dir, 'idx'), idx);
    cpSync(join(w.inputs[5].dir, 'part.000'), part);
    const other2 = await call(main, ['count', '--plan', w.planPath, '--range', '0', '--inputs', w.inputsDir, '--out', join(dir, 'c3')]);
    assert.equal(other2.code, EXIT.fault, other2.text);
    assert.match(other2.text, /range: FAIL .*names-d-20261023[\\/]idx hashes to sha256:[0-9a-f]{64}; the plan names names:names-d-20261023's as sha256:/);
  }));

test('range cli: a plan edited after it was written, or counts that read other inputs, is a fault, exit 1', () =>
  inTmp(async (dir) => {
    const w = await plannedWeek(dir);
    const edited = join(dir, 'edited.json');
    const plan = JSON.parse(readFileSync(w.planPath, 'utf8'));
    writeFileSync(edited, JSON.stringify({ ...plan, key: { ...plan.key, cuts: [plan.key.cuts[0], `${plan.key.cuts[1]}x`] } }));
    const e = await call(main, ['count', '--plan', edited, '--range', '0', '--inputs', w.inputsDir, '--out', join(dir, 'e')]);
    assert.equal(e.code, EXIT.fault, e.text);
    assert.match(e.text, /range: FAIL plan the plan's id is not the SHA-256 of its body: the plan was edited after it was written/);
    const counts = join(dir, 'counts');
    for (let r = 0; r < 3; r += 1) assert.equal((await call(main, ['count', '--plan', w.planPath, '--range', String(r), '--inputs', w.inputsDir, '--out', counts])).code, EXIT.ok);
    const c1 = join(counts, 'count.key.001.json');
    const counted = JSON.parse(readFileSync(c1, 'utf8'));
    // Counts that read more input records than the plan's inputs hold, and fewer.
    for (const step of [1, -1]) {
      writeFileSync(c1, JSON.stringify({ ...counted, input_records: counted.input_records + step }));
      const x = await call(main, ['write', '--plan', w.planPath, '--range', '0', '--counts', counts, '--inputs', w.inputsDir, '--out', join(dir, `job${step}`)]);
      assert.equal(x.code, EXIT.fault, x.text);
      assert.match(x.text, new RegExp(`range: FAIL the counts read (\\d+) input records; the plan's inputs hold ${w.plan.records}`));
      assert.equal(Number(/the counts read (\d+)/.exec(x.text)[1]), w.plan.records + step);
    }
  }));

test('range cli: a plan with nothing to merge or a range the plan does not cut is exit 2; an input with no time copy to merge is exit 1', () =>
  inTmp(async (dir) => {
    const w = await plannedWeek(dir);
    const waiting = join(dir, 'wait.json');
    writeFileSync(waiting, JSON.stringify(reId({ ...w.plan, verdict: 'wait', key: null, time: null, matrix: { include: [] } })));
    const nothing = await call(main, ['count', '--plan', waiting, '--range', '0', '--inputs', w.inputsDir, '--out', join(dir, 'n')]);
    assert.equal(nothing.code, EXIT.usage, nothing.text);
    assert.match(nothing.text, /the plan's verdict is wait: there is nothing to merge/);
    const counts = join(dir, 'counts');
    for (const verb of ['count', 'write']) {
      const x = await call(main, [verb, '--plan', w.planPath, '--range', '3', '--inputs', w.inputsDir, '--out', counts, ...(verb === 'write' ? ['--counts', w.inputsDir] : [])]);
      assert.equal(x.code, EXIT.usage, `${verb}\n${x.text}`);
      assert.match(x.text, /--range 3 is not one of the plan's 3 ranges/);
    }
    // A feed week whose plan merges the time copy, and one input that lists none.
    const f = await plannedWeek(join(dir, 'feed'), 'feed');
    assert.equal(f.plan.time.mode, 'merge');
    const lacking = join(dir, 'lacking.json');
    const inputs = f.plan.inputs.map((p, i) => {
      if (i !== 2) return p;
      const { time: _, ...rest } = p;
      return rest;
    });
    writeFileSync(lacking, JSON.stringify(reId({ ...f.plan, inputs })));
    const t = await call(main, ['count', '--plan', lacking, '--range', '0', '--inputs', f.inputsDir, '--out', join(dir, 't')]);
    assert.equal(t.code, EXIT.fault, t.text);
    assert.match(t.text, /range: FAIL feed:feed-d-20261021 carries no time copy/);
  }));

test('range cli: a merge that drops one input key, the first of all, fails the check of its part, FAIL count, exit 1', () =>
  inTmp(async (dir) => {
    const w = await plannedWeek(dir);
    // The planted defect: writeRange over inputs that never yield the smallest key of the merge.
    const first = w.plan.inputs.map((p) => p.key_min).sort()[0];
    const merge = (readers, codec, cuts, window, sink, options) =>
      writeRange(
        readers.map((r) => ({
          index: r.index,
          scan: async function* (lo, hi) {
            for await (const rec of r.scan(lo, hi)) if (codec.key(rec) !== first) yield rec;
          },
        })),
        codec,
        cuts,
        window,
        sink,
        options,
      );
    const x = await call(main, ['all', '--plan', w.planPath, '--inputs', w.inputsDir, '--out', join(dir, 'out')], { merge });
    assert.equal(x.code, EXIT.fault, x.text);
    assert.match(
      x.text,
      new RegExp(`range: FAIL count the output holds \\d+ record\\(s\\) and its inputs \\d+ distinct key\\(s\\): the output lacks the key "${first.replaceAll('.', '\\.')}" of its inputs`),
    );
  }));

test('range cli: the inputs read from GHCR with no credential give the parts the files give', () =>
  inTmp(async (dir) => {
    const w = await plannedWeek(dir);
    const local = join(dir, 'local');
    assert.equal((await call(main, ['all', '--plan', w.planPath, '--inputs', w.inputsDir, '--out', local])).code, EXIT.ok);
    const reg = registry();
    try {
      for (const i of w.inputs) {
        const layers = readdirSync(i.dir).map((title) => ({ title, bytes: readFileSync(join(i.dir, title)) }));
        reg.seed('names', i.tag, artifactType('pack'), i.manifest.annotations, layers);
      }
      const sources = Object.entries(w.root.through).map(([id, through]) => ({ id, through, fetched: null }));
      reg.seedRoot(w.root, { sources: { format: SOURCES_LAYER_FORMAT, sources } });
      const remote = join(dir, 'remote');
      const r = await call(main, ['all', '--plan', w.planPath, '--out', remote]);
      assert.equal(r.code, EXIT.ok, r.text);
      assert.deepEqual(filesOf(remote), filesOf(local));
      assert.deepEqual(reg.w.unusedBodies(), [], 'every GHCR answer body is read or cancelled');
    } finally {
      reg.close();
    }
    // The same plan copied elsewhere reads the same.
    cpSync(w.planPath, join(dir, 'copy.json'));
    assert.equal((await call(main, ['all', '--plan', join(dir, 'copy.json'), '--inputs', w.inputsDir, '--out', join(dir, 'again')])).code, EXIT.ok);
  }));

test('range cli: a time copy cut into fewer ranges than the key copy: the ranges past it count and write the key copy alone, and the assembly merges both', () =>
  inTmp(async (dir) => {
    const f = await plannedWeek(dir, 'feed', 3);
    assert.equal(f.plan.time.mode, 'merge');
    const timeIdx = f.inputs.map((i) => readIdx(readFileSync(join(i.dir, 'time.idx'))));
    const t = planRanges(timeIdx, { ranges: 2 });
    const planPath = join(dir, 'two.json');
    writeFileSync(planPath, JSON.stringify(reId({ ...f.plan, time: { ranges: t.ranges, cuts: [...t.cuts], bytes: [...t.bytes], mode: 'merge' } })));
    const counts = join(dir, 'counts');
    for (let r = 0; r < 3; r += 1) {
      const c = await call(main, ['count', '--plan', planPath, '--range', String(r), '--inputs', f.inputsDir, '--out', counts]);
      assert.equal(c.code, EXIT.ok, c.text);
      assert.equal(c.out.filter((l) => l.startsWith('count time ')).length, r < 2 ? 1 : 0, `range ${r}\n${c.text}`);
    }
    const job = join(dir, 'job');
    for (let r = 0; r < 3; r += 1) {
      const x = await call(main, ['write', '--plan', planPath, '--range', String(r), '--counts', counts, '--inputs', f.inputsDir, '--out', job]);
      assert.equal(x.code, EXIT.ok, `range ${r}\n${x.text}`);
      assert.equal(x.out.filter((l) => l.startsWith('range time ')).length, r < 2 ? 1 : 0, `range ${r}\n${x.text}`);
    }
    writeFileSync(join(dir, 'tags.json'), '[]');
    const a = await call(assembleMain, ['--plan', planPath, '--dir', job, '--out', join(dir, 'asm'), '--tags', join(dir, 'tags.json'), '--run', '7', '--inputs', f.inputsDir], { env: {} });
    assert.equal(a.code, 0, a.text);
    assert.match(a.text, /^check time: merged, \d+ part\(s\), bound to the key copy$/m);
  }));

test('range cli: an output directory that is a file, or under a file, is exit 2 before the plan is read', () =>
  inTmp(async (dir) => {
    const file = join(dir, 'file');
    writeFileSync(file, 'x');
    for (const [out, why] of [
      [file, /range: --out .*file: .*file is a file, not a directory/],
      [join(file, 'sub', 'deeper'), /range: --out .*deeper: .*file is a file, not a directory/],
    ]) {
      const r = await call(main, ['count', '--plan', join(dir, 'no-such-plan.json'), '--range', '0', '--out', out]);
      assert.equal(r.code, EXIT.usage, r.text);
      assert.match(r.text, why);
    }
  }));

// A GHCR double that holds the inputs' layers as blobs by digest, less `drop`.
function blobReader(w, drop = () => false) {
  const blobs = new Map();
  for (const i of w.inputs) {
    for (const title of readdirSync(i.dir)) {
      const bytes = readFileSync(join(i.dir, title));
      if (!drop(i.tag, title)) blobs.set(`sha256:${createHash('sha256').update(bytes).digest('hex')}`, bytes);
    }
  }
  return {
    readRange: async (_repo, digest, start, end) => {
      const b = blobs.get(digest);
      if (b === undefined) throw new GhcrError('missing', `GHCR holds no blob ${digest.slice(0, 19)}`, 404);
      return { bytes: new Uint8Array(b.subarray(start, end)), status: 206 };
    },
  };
}

test('range cli: each error class has its exit code: a defect 70, a blob the plan names that GHCR does not give 1, GHCR unreachable 2, a usage error 2, a fault 1', () =>
  inTmp(async (dir) => {
    const w = await plannedWeek(dir);
    const counts = join(dir, 'counts');
    for (let r = 0; r < 3; r += 1) assert.equal((await call(main, ['count', '--plan', w.planPath, '--range', String(r), '--inputs', w.inputsDir, '--out', counts])).code, EXIT.ok);
    const cases = [
      [new TypeError('a defect'), EXIT.internal, /^range: internal error: TypeError: a defect/m],
      [new GhcrError('unreachable', 'no route to ghcr.io'), EXIT.usage, /^range: no route to ghcr\.io$/m],
      [new RateLimitError('429 past the cap'), EXIT.usage, /^range: 429 past the cap$/m],
      [new CompactError('usage', 'a call out of bounds'), EXIT.usage, /^range: FAIL usage a call out of bounds$/m],
      [new CompactError('range', 'a window the inputs do not meet'), EXIT.fault, /^range: FAIL range a window the inputs do not meet$/m],
      [new PackError('crc', 'a block that does not read'), EXIT.fault, /^range: FAIL crc a block that does not read$/m],
      [new Fault('an input that is not the plan'), EXIT.fault, /^range: FAIL an input that is not the plan$/m],
    ];
    for (const [i, [e, code, line]] of cases.entries()) {
      const merge = async () => {
        throw e;
      };
      const r = await call(main, ['write', '--plan', w.planPath, '--range', '0', '--counts', counts, '--inputs', w.inputsDir, '--out', join(dir, `o${i}`)], { merge });
      assert.equal(r.code, code, `${e.name} ${e.message}\n${r.text}`);
      assert.match(r.text, line);
    }
    // From GHCR: every blob there reads as the files do.
    assert.equal((await call(main, ['all', '--plan', w.planPath, '--out', join(dir, 'g0')], { reader: blobReader(w) })).code, EXIT.ok);
    // An index the plan names that GHCR does not hold, and a part: a fault, never PRIVATE PACKAGE.
    for (const [title, label] of [
      ['idx', 'idx'],
      ['part.000', 'part.000'],
    ]) {
      const reader = blobReader(w, (tag, t) => tag === 'names-d-20261021' && t === title);
      const r = await call(main, ['all', '--plan', w.planPath, '--out', join(dir, `g-${title}`)], { reader });
      assert.equal(r.code, EXIT.fault, r.text);
      assert.ok(!r.out.includes('PRIVATE PACKAGE'), r.text);
      assert.match(
        r.text,
        new RegExp(
          `range: FAIL the plan names names:names-d-20261021's ${label.replace('.', '\\.')} as sha256:[0-9a-f]{64} \\(\\d+ B\\), which GHCR does not give with no credential \\(GHCR holds no blob`,
        ),
      );
    }
  }));
