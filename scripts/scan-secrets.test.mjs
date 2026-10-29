// scripts/scan-secrets.mjs: every shape seen to match a sample and to leave
// prose alone, and the command line seen to refuse a planted credential.
//
// ⛔ No secret-shaped literal appears in this file: the scan reads this file
// too. Each sample is assembled at run time from a prefix and a filler.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ROOT } from './files.mjs';
import { SHAPES, scanText } from './scan-secrets.mjs';

const fill = (n, c = 'a') => c.repeat(n);
const SAMPLES = {
  'github-token': `token ${'gh' + 'p_'}${fill(36)}`,
  'private-key-block': `${'-----BEGIN '}${'RSA PRIVATE KEY-----'}`,
  'url-userinfo': `${'https://'}user:${'hunter2'}@${'example.org/path'}`,
  jwt: `${'ey' + 'Jhbgciokabcd'}.${'ey' + 'Jzdwiokabcd'}.${fill(20)}`,
  'cloudflare-token': `${'cf' + 'ut_'}${fill(40, 'B')}`,
  'cloudflare-legacy-token': `Authorization: ${'Bear' + 'er '}${fill(40, 'c')}`,
  'cloudflare-oauth': `${'oauth' + '_token'} = "${fill(24, 'd')}"`,
  'gitlab-token': `${'gl' + 'pat-'}${fill(24, 'e')}`,
  'sk-style-key': `${'s' + 'k-'}${fill(40, 'f')}`,
  'huggingface-token': `token ${'h' + 'f_'}${fill(34, 'i')}`,
  'npm-token': `//registry.npmjs.org/:_authToken=${'np' + 'm_'}${fill(36, 'j')}`,
  'slack-token': `${'xo' + 'xb-'}${'1234567890'}-${'1234567890'}-${fill(24, 'k')}`,
  'aws-access-key-id': `aws_access_key_id = ${'AK' + 'IA'}${fill(16, 'Q')}`,
  'generic-bearer': `Authorization: ${'Bear' + 'er '}${fill(40, 'g')}.${fill(8, 'h')}`,
  'cloudflare-account-name': `names the account \`${'someone'}${'@'}${'example.org'}${"'s Acc"}ount\``,
};

test('every shape matches its sample, and every sample is named by its own shape', () => {
  assert.deepEqual(Object.keys(SAMPLES).sort(), SHAPES.map((s) => s.name).sort());
  for (const shape of SHAPES) assert.match(SAMPLES[shape.name], shape.re, shape.name);
});

test('prose that mentions the shapes by name does not match', () => {
  const prose = [
    'The workflow pushes with its own GITHUB_TOKEN, a ghs_ token that expires with the job.',
    'A Cloudflare token starts with cfut_ and is set with wrangler secret put.',
    'Send the Authorization header with a Bearer credential.',
    'Visit https://example.org/path or https://user@example.org/ for details.',
    'gitlab tokens start with glpat- and sk- is a common prefix.',
    'Hugging Face tokens start with hf_ and npm tokens with npm_.',
    'Slack tokens start with xoxb- or xoxp-, and an AWS key id starts with AKIA.',
    'The file hf_transfer is a tool, and npm_config_cache is a variable.',
    'The key AKIAXXXX is too short, and AKIA followed by lower case is prose.',
    "wrangler whoami names the operator's account, and a user's Account page lists it.",
    'Mail domains@pkgforge.dev about the account.',
  ].join('\n');
  assert.deepEqual(scanText('docs/x.md', prose).findings, []);
});

test('scanText names the file, the line and the shape, never the value', () => {
  const r = scanText('docs/x.md', `clean\n${SAMPLES['github-token']}\n`);
  assert.deepEqual(r.findings, ['docs/x.md:2: github-token']);
  assert.ok(!r.findings.join('').includes('ghp_'));
});

test('an allowlist entry suppresses its path and shape only', () => {
  const allow = [{ path: 'a.json', shapes: ['url-userinfo'], reason: 'public archive data' }];
  assert.deepEqual(scanText('a.json', SAMPLES['url-userinfo'], allow), { findings: [], suppressed: 1 });
  assert.equal(scanText('b.json', SAMPLES['url-userinfo'], allow).findings.length, 1);
  assert.equal(scanText('a.json', SAMPLES['github-token'], allow).findings.length, 1);
});

test('the command line exits 1 on a planted credential, 0 on a clean file and on an allowed one, read from its own process', () => {
  // The script reads the tree it sits in, so each case runs a copy in a scratch directory.
  const dir = mkdtempSync(join(tmpdir(), 'domains-scan-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    for (const f of ['scan-secrets.mjs', 'files.mjs']) copyFileSync(join(ROOT, 'scripts', f), join(dir, 'scripts', f));
    const run = (allow, ...args) => {
      writeFileSync(join(dir, 'scripts', 'scan-secrets.allow.json'), JSON.stringify(allow));
      try {
        const stdout = execFileSync(process.execPath, ['scripts/scan-secrets.mjs', ...args], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return { status: 0, stdout, stderr: '' };
      } catch (err) {
        return { status: err.status, stdout: String(err.stdout), stderr: String(err.stderr) };
      }
    };
    writeFileSync(join(dir, 'clean.txt'), 'nothing to see\n');
    writeFileSync(join(dir, 'planted.txt'), `${SAMPLES['github-token']}\n`);
    const clean = run([], 'clean.txt');
    assert.equal(clean.status, 0, clean.stderr);
    assert.match(clean.stdout, /secret scan: 1 files clean/);
    const planted = run([], 'clean.txt', 'planted.txt');
    assert.equal(planted.status, 1);
    assert.match(planted.stderr, /FAIL planted\.txt:1: github-token/);
    const allowed = run([{ path: 'planted.txt', shapes: ['github-token'], reason: 'a fixture' }], 'planted.txt');
    assert.equal(allowed.status, 0, allowed.stderr);
    assert.match(allowed.stdout, /1 finding\(s\) suppressed/);
    const all = run([], '--all');
    assert.equal(all.status, 1, 'a walked tree with the planted file is refused');
    assert.match(all.stderr, /FAIL planted\.txt:1: github-token/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the allowlist of this tree is a list of reviewed entries, each with a written reason', async () => {
  const { readFileSync } = await import('node:fs');
  const allow = JSON.parse(readFileSync(join(ROOT, 'scripts', 'scan-secrets.allow.json'), 'utf8'));
  assert.ok(Array.isArray(allow));
  for (const a of allow) {
    assert.equal(typeof a.path, 'string');
    assert.ok(Array.isArray(a.shapes) && a.shapes.length > 0, a.path);
    assert.ok(typeof a.reason === 'string' && a.reason.length >= 20, `${a.path} needs a written reason`);
  }
});
