// scripts/scan-secrets.mjs — refuse credential shapes in tracked and new files.
//
// Reports file, line and shape name; never the value. Each shape needs a prefix
// and enough length that ordinary prose cannot match it. This project holds no
// credential of its own (CI uses the workflow's own GITHUB_TOKEN, and the Worker
// is deployed with the operator's wrangler login), so the shapes are the generic
// ones: GitHub tokens, PEM private keys, credentials in a URL, JWTs, Cloudflare
// tokens of both forms and sign-in files, GitLab tokens, `sk-` style keys, Hugging
// Face (`hf_`), npm (`npm_`), Slack (`xox[abpr]-`) and AWS access key ids
// (`AKIA`), and any long bearer in an Authorization line. A source whose key has
// a prefix adds its shape here in the same change as the code that reads the key.
// Reviewed exceptions live in scripts/scan-secrets.allow.json, keyed by path and
// shape name, each with a written reason.
//
// Usage:
//   node scripts/scan-secrets.mjs         files staged for commit
//   node scripts/scan-secrets.mjs --all   every tracked and new file
//   node scripts/scan-secrets.mjs <path>...   those files alone (a test's)
// Exit codes: 0 clean, 1 findings, 2 could not run.
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listFiles, ROOT } from './files.mjs';

export const SHAPES = [
  // A GitHub token: personal `ghp_`, OAuth `gho_`, user `ghu_`, server (a workflow's
  // GITHUB_TOKEN) `ghs_`, refresh `ghr_`, or a fine-grained `github_pat_`.
  { name: 'github-token', re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { name: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'url-userinfo', re: /\bhttps?:\/\/[^\s/:@'"`]+:[^\s/:@'"`]{3,}@[A-Za-z0-9.-]+/ },
  // A signed JSON web token.
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/ },
  // A Cloudflare credential of the scannable form: a Global API Key `cfk_`, a
  // user API token `cfut_`, an account API token `cfat_` or an Access service
  // token's secret `cfast_`, each 40 characters and a checksum.
  { name: 'cloudflare-token', re: /\bcf(?:k|ut|at|ast)_[A-Za-z0-9]{40,}/ },
  // A Cloudflare API token of the older form, 40 characters with no prefix,
  // known only by where it sits: sent as a bearer, or set as a Cloudflare
  // token's variable; an older Global API Key sent as `X-Auth-Key`.
  {
    name: 'cloudflare-legacy-token',
    re: /\bBearer\s+[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])|\b(?:CLOUDFLARE_API_(?:TOKEN|KEY)|CF_API_(?:TOKEN|KEY)|CF_[A-Z0-9_]*_TOKEN)["']?\s*[=:]\s*["']?[A-Za-z0-9_-]{37,}|\bX-Auth-Key["']?\s*[=:]\s*["']?[0-9a-f]{37,45}\b/,
  },
  // A wrangler or `cf` sign-in as its own file keeps it (TOML or JSON).
  { name: 'cloudflare-oauth', re: /\b(?:oauth_token|refresh_token)["']?\s*[=:]\s*["'][^"'\s]{20,}["']/ },
  // A GitLab token: a personal access token `glpat-` and its siblings (deploy,
  // runner, trigger, CI job, feed, OAuth application, service account, incoming
  // mail, agent), 20 characters or more, and the routable form's tail.
  { name: 'gitlab-token', re: /\bgl(?:pat|dt|rt|ptt|cbt|ft|oas|soat|imt|agent)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){0,2}/ },
  { name: 'sk-style-key', re: /\b(?:sk|pplx)-[A-Za-z0-9_-]{32,}/ },
  // A Hugging Face user access token: `hf_` and 34 or more letters and digits.
  { name: 'huggingface-token', re: /\bhf_[A-Za-z0-9]{34,}/ },
  // An npm access token: `npm_` and 36 or more letters and digits.
  { name: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36,}/ },
  // A Slack token: bot `xoxb-`, user `xoxp-`, app `xoxa-` or refresh `xoxr-`.
  { name: 'slack-token', re: /\bxox[abpr]-[0-9A-Za-z-]{10,}/ },
  // An AWS access key id: `AKIA` and 16 upper-case letters and digits.
  { name: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  // Any long bearer credential in a header line, whatever issued it.
  { name: 'generic-bearer', re: /\bAuthorization["']?\s*[=:]\s*["']?Bearer\s+[A-Za-z0-9._~+/-]{32,}/i },
];

const BINARY = /\.(png|jpe?g|gif|ico|webp|woff2?|zip|gz|zst|xz|parquet|crx)$/i;

// The findings of one file's text: "<path>:<line>: <shape>", and how many an
// allowlist entry suppressed. `allow` is the parsed scan-secrets.allow.json.
export function scanText(rel, text, allow = []) {
  const findings = [];
  let suppressed = 0;
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const shape of SHAPES) {
      if (!shape.re.test(lines[i])) continue;
      if (allow.some((a) => a.path === rel && (a.shapes ?? []).includes(shape.name))) suppressed += 1;
      else findings.push(`${rel}:${i + 1}: ${shape.name}`);
    }
  }
  return { findings, suppressed };
}

function main() {
  // Files named on the command line are scanned alone, each as given.
  const named = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  let listing;
  try {
    listing = named.length ? { files: named, walked: false } : listFiles(process.argv.includes('--all') ? 'all' : 'staged');
  } catch (err) {
    console.error(`could not run: ${err.message}`);
    process.exit(2);
  }
  if (listing.walked) console.log('note: no git work tree here; walked the tree instead');
  if (listing.files.length === 0) {
    console.log('secret scan: 0 files selected (nothing staged?); nothing was examined');
    process.exit(0);
  }

  let allow = [];
  try {
    allow = JSON.parse(readFileSync(join(ROOT, 'scripts', 'scan-secrets.allow.json'), 'utf8'));
  } catch {
    // no allowlist: every finding is reported
  }

  const findings = [];
  let suppressed = 0;
  let scanned = 0;
  for (const rel of listing.files) {
    if (BINARY.test(rel)) continue;
    let text;
    try {
      text = readFileSync(isAbsolute(rel) ? rel : join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    const r = scanText(rel, text, allow);
    findings.push(...r.findings);
    suppressed += r.suppressed;
  }

  if (findings.length > 0) {
    for (const f of findings) console.error(`FAIL ${f}`);
    process.exit(1);
  }
  if (suppressed > 0) console.log(`note: ${suppressed} finding(s) suppressed by scripts/scan-secrets.allow.json`);
  console.log(`secret scan: ${scanned} files clean`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
