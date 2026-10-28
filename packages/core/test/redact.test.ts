// packages/core/src/redact.ts: the shapes are scripts/scan-secrets.mjs's, and
// redact() replaces every match whole, keeping no prefix and no tail of it.
//
// ⛔ No secret-shaped literal appears in this file: the secret scan reads it.
// Each sample is assembled at run time from a prefix and a filler, as
// scripts/scan-secrets.test.mjs does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SHAPES } from "../../../scripts/scan-secrets.mjs";
import { REDACT_SHAPES, redact } from "../src/redact.ts";

const fill = (n: number, c = "a"): string => c.repeat(n);
// Each sample holds the secret alone, so the whole sample is what redact removes.
const SECRETS: Record<string, string> = {
  "github-token": `${"gh"}${"p_"}${fill(36)}`,
  "private-key-block": `${"-----BEGIN "}${"RSA PRIVATE KEY-----"}`,
  "url-userinfo": `${"https://"}user:${"hunter2"}@${"example.org"}`,
  jwt: `${"ey"}${"Jhbgciokabcd"}.${"ey"}${"Jzdwiokabcd"}.${fill(20)}`,
  "cloudflare-token": `${"cf"}${"ut_"}${fill(40, "B")}`,
  "cloudflare-legacy-token": `${"Bear"}${"er "}${fill(40, "c")}`,
  "cloudflare-oauth": `${"oauth"}${"_token"} = "${fill(24, "d")}"`,
  "gitlab-token": `${"gl"}${"pat-"}${fill(24, "e")}`,
  "sk-style-key": `${"s"}${"k-"}${fill(40, "f")}`,
  "huggingface-token": `${"h"}${"f_"}${fill(34, "i")}`,
  "npm-token": `${"np"}${"m_"}${fill(36, "j")}`,
  "slack-token": `${"xo"}${"xb-"}${"1234567890"}-${fill(24, "k")}`,
  "aws-access-key-id": `${"AK"}${"IA"}${fill(16, "Q")}`,
  // 40 characters and a tail: the 40-character bearer shape matches a prefix of it.
  "generic-bearer": `Authorization: ${"Bear"}${"er "}${fill(40, "g")}.${fill(8, "h")}`,
};

test("redact: the shapes equal scripts/scan-secrets.mjs SHAPES, name for name and expression for expression, in order", () => {
  const scan = SHAPES.map((s) => [s.name, s.re.source, s.re.flags]);
  assert.deepEqual(
    REDACT_SHAPES.map((s) => [s.name, s.re.source, s.re.flags]),
    scan,
  );
});

test("redact: every shape's sample is replaced whole and names its shape", () => {
  assert.deepEqual(Object.keys(SECRETS).sort(), REDACT_SHAPES.map((s) => s.name).sort());
  for (const [name, secret] of Object.entries(SECRETS)) {
    const out = redact(`before ${secret} after`);
    assert.match(out, new RegExp(`^before \\[redacted:[a-z+-]*\\b${name}\\b[a-z+-]*\\] after$`), name);
    assert.ok(!out.includes(secret), name);
  }
});

test("redact: a bearer longer than 40 characters is redacted to its end, leaving no tail", () => {
  const secret = SECRETS["generic-bearer"] ?? "";
  const out = redact(`header ${secret} end`);
  assert.equal(out, "header [redacted:generic-bearer+cloudflare-legacy-token] end");
  assert.ok(!out.includes(fill(8, "h")), "the tail after the first 40 characters is gone");
});

test("redact: every match on a line is replaced, not only the first", () => {
  const a = SECRETS["npm-token"] ?? "";
  const b = `${"np"}${"m_"}${fill(40, "z")}`;
  assert.equal(redact(`${a} and ${b}`), "[redacted:npm-token] and [redacted:npm-token]");
});

test("redact: prose that names the shapes is left as it is", () => {
  const prose = [
    "The workflow pushes with its own GITHUB_TOKEN, a ghs_ token that expires with the job.",
    "A Cloudflare token starts with cfut_ and is set with wrangler secret put.",
    "Send the Authorization header with a Bearer credential.",
    "Visit https://example.org/path or https://user@example.org/ for details.",
  ].join("\n");
  assert.equal(redact(prose), prose);
  assert.equal(redact(""), "");
});
