// adapters/oi-nrd through main of scripts/ingest/run.mjs, in process, over the
// broker's recorded answers (fixtures/, --recordings): the disk writer, the
// verifier under the required checks, the stats line, and a push to the GHCR
// double of scripts/root/fixture.mjs that fails (design 7.3, settled C11 and
// C18). The list is the fixture list the recording was made under; the state
// is a file holding the recorded cursor. No test reaches the network.
//
// run.mjs sends the contact User-Agent of scripts/lib/user-agent.mjs as the
// Kafka client id, and the replay matches whole requests by their bytes: the
// recording's client_id must be that constant, or these tests need a new
// recording (the recorded tests pass client_id itself, settled C10).
//
//   node scripts/test.mjs adapters/oi-nrd --name "oi-nrd run"
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { canonicalJson } from '@domains/adapter';
import { emptyState, proposalFile } from '@domains/state';
import { call, inRegistry, inTmp, stateFile } from '../../../scripts/ingest/fixture.mjs';
import { EXIT, main } from '../../../scripts/ingest/run.mjs';
import { USER_AGENT } from '../../../scripts/lib/user-agent.mjs';
import { PSL_FILE } from '../record.mjs';
import { TOPICS } from '../src/index.ts';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const recorded = JSON.parse(readFileSync(join(FIXTURES, 'recorded.json'), 'utf8'));
const { cursor, now } = JSON.parse(readFileSync(join(FIXTURES, 'cursor.json'), 'utf8'));
const RUN = '41000000001';

// A state that holds the recorded cursor of oi-nrd.
const stateOf = (dir) => stateFile(dir, { ...emptyState('2026-10-31T10:00:00Z'), cursors: { 'oi-nrd': cursor }, moved: { 'oi-nrd': { at: '2026-10-31T10:00:00Z', run: '41000000000' } } });
const argsOf = (out, state, more = ['--no-push']) => ['--adapter', 'oi-nrd', '--out', out, '--state', state, '--recordings', FIXTURES, '--psl', PSL_FILE, '--now', now, '--run', RUN, ...more];
const statsOf = (r) => JSON.parse(r.out.find((l) => l.startsWith('stats oi-nrd ')).slice('stats oi-nrd '.length));

// Each object a run wrote, a segment or a raw lane object, by tag: each file's
// SHA-256 (a manifest.json byte for byte), and for blobs.json per blob its
// title, digest and size (its `file` is an absolute path).
function writtenOf(out) {
  const work = join(out, 'work', 'oi-nrd');
  return readdirSync(work, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^(raw-)?oi-nrd/.test(e.name))
    .map((e) => e.name)
    .sort()
    .map((tag) => ({
      tag,
      files: readdirSync(join(work, tag))
        .sort()
        .map((f) => {
          const bytes = readFileSync(join(work, tag, f));
          if (f === 'blobs.json') return [f, JSON.parse(bytes.toString('utf8')).map((b) => [b.title, b.digest, b.size])];
          return [f, createHash('sha256').update(bytes).digest('hex')];
        }),
    }));
}

test("oi-nrd run: the recording's client id is run.mjs's contact User-Agent", () => {
  assert.equal(recorded.client_id, USER_AGENT, 'record the fixtures again: run.mjs sends USER_AGENT as the Kafka client id');
});

test('oi-nrd run: two runs from the same cursor write the same manifests and blobs, byte for byte', () =>
  inTmp(async (tmp) => {
    const state = stateOf(tmp);
    const one = await call(main, argsOf(join(tmp, 'one'), state));
    const two = await call(main, argsOf(join(tmp, 'two'), state));
    assert.equal(one.code, EXIT.ok, one.text);
    assert.equal(two.code, EXIT.ok, two.text);
    const a = writtenOf(join(tmp, 'one'));
    // Three segments, each with its manifest, and three raw lane objects; only
    // oi-nrd's segment carries facts.json.
    assert.equal(a.length, 6, a.map((x) => x.tag).join(' '));
    const has = (file) =>
      a
        .filter((x) => x.files.some(([f]) => f === file))
        .map((x) => x.tag.replace(/\..*/, ''))
        .sort();
    assert.deepEqual(has('manifest.json'), ['oi-nrd', 'oi-nrd-confirmed', 'oi-nrd-fqdn']);
    assert.deepEqual(has('members.json'), ['raw-oi-nrd', 'raw-oi-nrd-confirmed', 'raw-oi-nrd-fqdn']);
    assert.deepEqual(has('facts.json'), ['oi-nrd']);
    assert.deepEqual(writtenOf(join(tmp, 'two')), a);
    assert.deepEqual(two.out, one.out);
  }));

test('oi-nrd run: every segment verifies ok under the required checks, and the stats line names each source', () =>
  inTmp(async (tmp) => {
    const state = stateOf(tmp);
    const r = await call(main, argsOf(join(tmp, 'out'), state));
    assert.equal(r.code, EXIT.ok, r.text);
    assert.equal(r.out[0], `cursor oi-nrd ${canonicalJson(cursor)} (${state})`);
    const segments = r.out.filter((l) => l.startsWith('segment '));
    assert.deepEqual(
      segments.map((l) => l.split(' ').slice(2, 4).concat(l.split(' ').at(-1))),
      TOPICS.map((t) => [t.source, t.dataset, 'ok']),
    );
    for (const t of TOPICS) {
      const line = segments.find((l) => l.split(' ')[2] === t.source);
      assert.match(line, new RegExp(` ${recorded.topics[t.topic].through} ${recorded.edge} records \\d+ verdict ok$`), line);
    }
    assert.equal(r.out.filter((l) => l.startsWith('raw ')).length, 3);
    assert.deepEqual(
      r.out.filter((l) => l.startsWith('stats ')),
      [r.out.find((l) => l.startsWith('stats oi-nrd '))],
    );
    const stats = statsOf(r);
    for (const t of TOPICS) {
      assert.equal(stats[`${t.source}.messages`], recorded.topics[t.topic].messages, t.source);
      assert.equal(stats[`${t.source}.windows`], 1, t.source);
      assert.equal(stats[`${t.source}.lag`], recorded.topics[t.topic].stop - recorded.topics[t.topic].edge, t.source);
    }
    assert.equal(r.out.at(-1), 'no push: --no-push; 3 segment(s) and 3 raw object(s) verified');
    assert.deepEqual(
      r.out.filter((l) => l.startsWith('fault ')),
      [],
    );
  }));

test('oi-nrd run: a push that fails writes no proposal, so the cursor does not move', () =>
  inRegistry(async (reg, tmp) => {
    // Every copy of the first raw lane object to the registry fails, so
    // push.mjs's retries fail too.
    const failed = [];
    const oras = async (args, opts) => {
      if (args[0] === 'copy' && /:raw-oi-nrd\./.test(args.at(-1))) {
        failed.push(args.at(-1));
        return { code: 1, stdout: '', stderr: 'Error: a planted failure of the copy\n' };
      }
      return reg.oras(args, opts);
    };
    const out = join(tmp, 'out');
    const r = await call(main, argsOf(out, stateOf(tmp), []), { reg, now, extra: { oras } });
    assert.ok(failed.length > 0, 'the planted failure was reached');
    assert.equal(new Set(failed).size, 1, 'no later object was pushed');
    assert.notEqual(r.code, EXIT.ok, r.text);
    assert.equal(existsSync(join(out, 'proposals', proposalFile('oi-nrd'))), false, 'no proposal');
    assert.ok(!r.out.some((l) => l.startsWith('proposal ')), r.text);
    // Nothing of the run is in obs but what was pushed before the failure: no segment.
    assert.deepEqual(
      [...reg.w.manifests.keys()].filter((k) => /^obs:oi-nrd/.test(k)),
      [],
    );
  }));
