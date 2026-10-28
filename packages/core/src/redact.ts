// packages/core/src/redact.ts — the one redaction helper (docs/security/secrets.md,
// "Logging"). Every secret-shaped value reaches a log, an error or an answer
// through redact(), which replaces each whole match with `[redacted:<shape>]`
// and keeps no prefix of it.
//
//   console.error(redact(`upstream said: ${text}`))
//
// The shapes are the SHAPES of scripts/scan-secrets.mjs, the same names and the
// same expressions. That script reads node:fs and cannot run in workerd, so the
// list is held here as well, and packages/core/test/redact.test.ts fails when
// the two lists differ in a name, an expression or the order.

export interface Shape {
  name: string;
  re: RegExp;
}

export const REDACT_SHAPES: readonly Shape[] = Object.freeze([
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { name: "private-key-block", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: "url-userinfo", re: /\bhttps?:\/\/[^\s/:@'"`]+:[^\s/:@'"`]{3,}@[A-Za-z0-9.-]+/ },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/ },
  { name: "cloudflare-token", re: /\bcf(?:k|ut|at|ast)_[A-Za-z0-9]{40,}/ },
  {
    name: "cloudflare-legacy-token",
    re: /\bBearer\s+[A-Za-z0-9_-]{40}(?![A-Za-z0-9_-])|\b(?:CLOUDFLARE_API_(?:TOKEN|KEY)|CF_API_(?:TOKEN|KEY)|CF_[A-Z0-9_]*_TOKEN)["']?\s*[=:]\s*["']?[A-Za-z0-9_-]{37,}|\bX-Auth-Key["']?\s*[=:]\s*["']?[0-9a-f]{37,45}\b/,
  },
  { name: "cloudflare-oauth", re: /\b(?:oauth_token|refresh_token)["']?\s*[=:]\s*["'][^"'\s]{20,}["']/ },
  { name: "gitlab-token", re: /\bgl(?:pat|dt|rt|ptt|cbt|ft|oas|soat|imt|agent)-[A-Za-z0-9_-]{20,}(?:\.[A-Za-z0-9_-]+){0,2}/ },
  { name: "sk-style-key", re: /\b(?:sk|pplx)-[A-Za-z0-9_-]{32,}/ },
  { name: "huggingface-token", re: /\bhf_[A-Za-z0-9]{34,}/ },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36,}/ },
  { name: "slack-token", re: /\bxox[abpr]-[0-9A-Za-z-]{10,}/ },
  { name: "aws-access-key-id", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "generic-bearer", re: /\bAuthorization["']?\s*[=:]\s*["']?Bearer\s+[A-Za-z0-9._~+/-]{32,}/i },
]);

// The global form of each shape, built once: a non-global expression finds only
// the first match on a line.
const GLOBAL = REDACT_SHAPES.map((s) => ({ name: s.name, re: new RegExp(s.re.source, `${s.re.flags}g`) }));

interface Span {
  start: number;
  end: number;
  names: string[];
}

// The text with every match of every shape replaced. Matches are found on the
// original text and overlapping ones are merged first: replacing shape by shape
// would let a shorter shape (a 40-character bearer) cut a longer match in two
// and leave the tail of the secret in the output.
export function redact(text: string): string {
  const spans: Span[] = [];
  for (const s of GLOBAL) {
    for (const m of text.matchAll(s.re)) spans.push({ start: m.index, end: m.index + m[0].length, names: [s.name] });
  }
  if (spans.length === 0) return text;
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const s of spans) {
    const last = merged.at(-1);
    if (last !== undefined && s.start < last.end) {
      last.end = Math.max(last.end, s.end);
      for (const n of s.names) if (!last.names.includes(n)) last.names.push(n);
    } else {
      merged.push({ start: s.start, end: s.end, names: [...s.names] });
    }
  }
  let out = "";
  let at = 0;
  for (const s of merged) {
    out += `${text.slice(at, s.start)}[redacted:${s.names.join("+")}]`;
    at = s.end;
  }
  return out + text.slice(at);
}
