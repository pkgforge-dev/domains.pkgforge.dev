// .githooks/commit-msg: the hook is seen to refuse a message that credits a tool,
// to allow a clean one and a human co-author, to ignore git's own `#` lines, to
// leave the project's own word `cursor` alone and refuse the editor of that name
// only in its tool forms, to refuse a trailer from a no-reply address whatever
// name it carries, and to refuse when it has read nothing. It runs under `sh`;
// where `sh` is not on the PATH the tests are skipped and say so, and a skip is
// not a pass.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { ROOT } from './files.mjs';

const HOOK = join(ROOT, '.githooks', 'commit-msg');
const hasSh = spawnSync('sh', ['-c', 'exit 0']).status === 0;
const dir = mkdtempSync(join(tmpdir(), 'domains-hook-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// Runs the hook over a message and reads its exit code from its own process.
function hook(message) {
  const file = join(dir, 'msg.txt');
  if (message !== null) writeFileSync(file, message);
  const r = spawnSync('sh', [HOOK, message === null ? join(dir, 'absent.txt') : file], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

const opts = { skip: hasSh ? false : 'sh is not on the PATH, so the hook was not run' };
// Built at run time so this file holds no tool name beside a trailer shape.
const TOOL = ['Cl', 'aude'].join('');
const EDITOR = ['Cur', 'sor'].join('');
// A tool name that is on no list of the hook.
const UNLISTED = ['Acme', 'Bot'].join('');

test('a clean message is allowed, and git comment lines are ignored', opts, () => {
  assert.equal(hook('Ingest: read the manifest first\n\nThe dump is large, so the manifest says what changed.\n').status, 0);
  assert.equal(hook(`Ingest: read the manifest\n\n# On branch main\n# Co-Authored-By: ${TOOL} <x@example.org>\n`).status, 0, 'a # line never reaches the stored message');
});

test('a co-author trailer that names a tool is refused', opts, () => {
  const r = hook(`Ingest: read the manifest\n\nCo-Authored-By: ${TOOL} Sonnet <noreply@example.org>\n`);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /a tool is credited in the pending message/);
  assert.match(r.stderr, /co-author trailer naming/);
});

test('a generated-with line is refused', opts, () => {
  const r = hook('Ingest: read the manifest\n\nGenerated with a tool\n');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /carries "generated with"/);
});

test('a tool or vendor name in the body is refused', opts, () => {
  assert.equal(hook(`Ingest: read the manifest\n\nWritten with help from ${TOOL}.\n`).status, 1);
  assert.equal(hook('Ingest: the Copilot panel is not a feed\n').status, 1);
});

test('a human co-author is allowed', opts, () => {
  assert.equal(hook('Ingest: read the manifest\n\nCo-authored-by: Jane Doe <jane@example.org>\n').status, 0);
  assert.equal(hook('Ingest: read the manifest\n\nCo-authored-by: Jane Doe <12345+jane@users.noreply.github.com>\n').status, 0, "GitHub's own address for a person has an id before the plus");
});

test('the word cursor is the project vocabulary and passes; the editor of that name is refused only in its tool forms', opts, () => {
  assert.equal(hook('Ingest: advance the Kafka cursor after the push\n\nThe state cursor moves in the promote job only; a cursor proposal is not a write.\n').status, 0);
  const trailer = hook(`Ingest: advance the cursor\n\nCo-authored-by: ${EDITOR} <agent@example.org>\n`);
  assert.equal(trailer.status, 1);
  assert.match(trailer.stderr, new RegExp(`co-author trailer naming "${EDITOR.toLowerCase()}"`));
  const line = hook(`Ingest: advance the cursor\n\n${EDITOR} Agent made this change.\n`);
  assert.equal(line.status, 1);
  assert.match(line.stderr, /carries "cursor agent"/);
});

test('a trailer from a no-reply address is refused whatever name it carries, and an unlisted name with a personal address passes', opts, () => {
  const refused = hook(`Ingest: read the manifest\n\nCo-authored-by: ${UNLISTED} <noreply@example.org>\n`);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /co-author trailer from a no-reply address/);
  assert.equal(hook(`Ingest: read the manifest\n\nCo-authored-by: ${UNLISTED} <no-reply@example.org>\n`).status, 1);
  assert.equal(hook(`Ingest: read the manifest\n\nCo-authored-by: ${UNLISTED} <${UNLISTED.toLowerCase()}@example.org>\n`).status, 0, 'the documented limit: add the name to NAMES');
});

test('a message with no line outside git comments is refused as unread, and a missing file exits 2', opts, () => {
  const empty = hook('# only comments\n# here\n');
  assert.equal(empty.status, 1);
  assert.match(empty.stderr, /nothing was read/);
  const missing = hook(null);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no such message file/);
});

test('the hook with no argument exits 2', opts, () => {
  const r = spawnSync('sh', [HOOK], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});
