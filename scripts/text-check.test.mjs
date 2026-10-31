// The checks of scripts/text-check.mjs: which files the narrative check reads,
// each marker it refuses, the present-tense writing it must not refuse, and the
// byte check. The last test runs the narrative check over this tree.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { listFiles, ROOT } from './files.mjs';
import { findBytes, findNarrative, NARRATIVE_MARKERS, narrativeScope, stringLiterals, withoutCode } from './text-check.mjs';

const DOC = 'docs/architecture.md';

test('reads the technical documents, the generated root documents and the registries only', () => {
  for (const rel of [
    'AGENTS.md',
    'README.md',
    'HUMAN.md',
    'SECURITY.md',
    DOC,
    'docs/sources.md',
    'docs/clock.md',
    'docs/resources.md',
    'docs/methodology/gate.md',
    'docs/conventions/prose.md',
    'docs/security/secrets.md',
    'apps/serve/public/SKILL.md',
    'apps/serve/public/llms.txt',
    'apps/serve/public/openapi.json',
  ]) {
    assert.equal(narrativeScope(rel), 'text', rel);
  }
  assert.equal(narrativeScope('apps/serve/src/docs.ts'), 'registry');
  for (const rel of [
    'CHANGELOG.md',
    'TODO/PROGRESS.md',
    'TODO/ingest.md',
    'docs/research/2026-10-27-design-a.md',
    'docs/research/2026-10-27-design-a/scripts/psl.mjs',
    'apps/serve/src/serve.ts',
    'apps/serve/test/docs.test.ts',
  ]) {
    assert.equal(narrativeScope(rel), null, rel);
  }
});

test('refuses every marker in a technical document', () => {
  const samples = {
    'no longer': 'The cache no longer holds misses.',
    'used to': 'The guard used to read the address.',
    previously: 'The route was previously 404.',
    originally: 'Selection originally walked one tier.',
    formerly: 'The header, formerly x-source, names the tier.',
    'until recently': 'Until recently the clock ran hourly.',
    'back then': 'Back then the index had no first-seen column.',
    'had been': 'The package had been public.',
    'turned out': 'The tile turned out to be 8 KiB.',
    'we decided': 'We decided to keep one store.',
    'the first review': 'The first deep review found two defects.',
    'after the merge': 'After the merge the gate is green.',
    'has happened': 'This has happened twice.',
    'once, a story': 'A session once deleted its corpus.',
    'is now': 'The check is now armed.',
    'now does': 'It now answers 404 for a miss.',
    'since an entry': 'The status page reads one row since DOM-041.',
  };
  assert.deepEqual(Object.keys(samples).sort(), NARRATIVE_MARKERS.map((m) => m.name).sort());
  for (const [name, line] of Object.entries(samples)) {
    assert.deepEqual(findNarrative(DOC, `# t\n\n${line}\n`), [`${DOC}:3: narrative marker '${name}'`], name);
  }
});

test('passes present-tense technical writing', () => {
  const text = [
    'A token is used to push the layer; the layer is used to derive nothing.',
    'Each tick keeps its rows for 8 days, and a page read past 30 minutes of no tick says the clock is stale.',
    'The answer says when it was checked, and what the session was asked to do.',
    'A redirect hop is guarded; once a probe fails it runs once more.',
    'Now and then is not a marker; neither is "since a Cloudflare zone answers".',
  ].join('\n');
  assert.deepEqual(findNarrative(DOC, text), []);
});

test('skips markdown code spans and fenced blocks, so a page can name a marker', () => {
  const text = 'The check refuses `no longer` and `previously`.\n\n```text\nthe route was previously 404\n```\n\nThe route was previously 404.\n';
  assert.deepEqual(findNarrative(DOC, text), [`${DOC}:7: narrative marker 'previously'`]);
  assert.equal(withoutCode('a\n```\nb\n```\nc').split('\n').length, 5);
});

test('reads only the string literals of a registry, never its comments', () => {
  const src = [
    '// the feed no longer holds it: a comment, not a document',
    '/* previously a block comment */',
    'const a = "the feed no longer holds the file";',
    "const b = 'kept';",
    'const c = `a ${x ? "b" : `inner ${y}`} previously`;',
  ].join('\n');
  const found = findNarrative('apps/serve/src/docs.ts', src);
  assert.deepEqual(found, ["apps/serve/src/docs.ts:3: narrative marker 'no longer'", "apps/serve/src/docs.ts:5: narrative marker 'previously'"]);
  assert.deepEqual(
    stringLiterals('x("a", `b${"c"}d`)').map((s) => s.text),
    ['a', 'b', 'c', 'd'],
  );
});

test('the byte check refuses a control byte and invalid UTF-8, and accepts tab, newline and carriage return', () => {
  assert.deepEqual(findBytes('a.md', Buffer.from('a\tb\r\nc\n')), []);
  assert.deepEqual(findBytes('a.md', Buffer.from([0x61, 0x00, 0x62])), ['a.md: control byte 0x00 at offset 1']);
  assert.deepEqual(findBytes('a.md', Buffer.from([0x61, 0x7f])), ['a.md: control byte 0x7f at offset 1']);
  assert.deepEqual(findBytes('a.md', Buffer.from([0x61, 0xff, 0xfe])), ['a.md: invalid UTF-8']);
  assert.deepEqual(findBytes('a.md', Buffer.from('⛔ ⭐ ⚠ é')), []);
});

test('the script exits 1 on a planted marker and 0 on a clean tree, read from its own process', () => {
  // The script reads the tree it sits in, so each case runs a copy in a scratch directory with no git work tree.
  const dir = mkdtempSync(join(tmpdir(), 'domains-text-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    for (const f of ['text-check.mjs', 'files.mjs']) copyFileSync(join(ROOT, 'scripts', f), join(dir, 'scripts', f));
    const run = (body) => {
      writeFileSync(join(dir, 'AGENTS.md'), body);
      try {
        const stdout = execFileSync(process.execPath, ['scripts/text-check.mjs'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { status: 0, stdout, stderr: '' };
      } catch (err) {
        return { status: err.status, stdout: String(err.stdout), stderr: String(err.stderr) };
      }
    };
    const clean = run('# a\n\nThe index holds one row a name.\n');
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /text check: \d+ files clean; 1 technical documents carry no narrative marker/);
    const planted = run('# a\n\nThe index no longer holds one row a name.\n');
    assert.equal(planted.status, 1);
    assert.match(planted.stderr, /FAIL AGENTS\.md:3: narrative marker 'no longer'/);
    const control = run('# a\n\nA control byte \u0001 here.\n');
    assert.equal(control.status, 1);
    assert.match(control.stderr, /FAIL AGENTS\.md: control byte 0x01 at offset \d+/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the technical documents in this tree carry no narrative marker', () => {
  const found = [];
  for (const rel of listFiles('all').files) {
    if (!narrativeScope(rel)) continue;
    let text;
    try {
      text = readFileSync(join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    found.push(...findNarrative(rel, text.replace(/\r\n/g, '\n')));
  }
  assert.deepEqual(found, []);
});
