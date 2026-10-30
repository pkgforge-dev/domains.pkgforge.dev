// docs/format.md section 17 against the constants of packages/state and the
// rules it names: a number or a grammar the section states is the one the
// code holds, so an edit of either side alone fails here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_CURSOR_BYTES } from "@domains/adapter";
import { ANNOTATION_MAX_CHARS, WORKFLOW_RUN_ID } from "@domains/ghcr";
import { HISTORY_DAYS, OWED_DAYS, RUN_ID, STATE_FORMAT, STATE_MAX_BYTES } from "../src/index.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FORMAT = readFileSync(join(ROOT, "docs", "format.md"), "utf8");
const start = FORMAT.indexOf("## 17. The state, `state.json`");
const end = FORMAT.indexOf("## 18. ");
const S17 = FORMAT.slice(start, end);
// The row of the field table whose first cell is `name`.
const row = (name: string): string => {
  const line = S17.split("\n").find((l) => l.startsWith(`| \`${name}\` |`));
  assert.ok(line !== undefined, `section 17 has a row ${name}`);
  return line;
};
// The one number the pattern's group catches in `text`.
const number = (text: string, re: RegExp): number => {
  const m = re.exec(text);
  assert.ok(m !== null, `${re} in ${text.slice(0, 120)}`);
  return Number(m[1]!.replaceAll(",", ""));
};

test("state docs: section 17 states the format, the limits and the days the code holds", () => {
  assert.ok(start > 0 && end > start, "docs/format.md has sections 17 and 18");
  assert.match(row("format"), new RegExp(`^\\| \`format\` \\| \`${STATE_FORMAT.replaceAll(".", "\\.")}\`\\. A reader refuses another format\\.`));
  assert.equal(number(S17, /It is at most\s+(\d+) MiB \(`STATE_MAX_BYTES`\)/), STATE_MAX_BYTES / 1_048_576);
  assert.equal(number(row("cursors"), /A cursor is any JSON value of at most (\d+) KiB/), MAX_CURSOR_BYTES / 1024);
  assert.equal(number(row("cursors"), /is at most (\d+) characters of canonical JSON/), ANNOTATION_MAX_CHARS);
  assert.equal(number(row("history"), /the newest (\d+) kept \(`HISTORY_DAYS`\)/), HISTORY_DAYS);
  assert.equal(number(row("owed"), /each owed more than (\d+) days \(`OWED_DAYS`\)/), OWED_DAYS);
});

test("state docs: the run of moved is the grammar section 17 states: digits with no leading zero, at most 20, or local", () => {
  assert.match(row("moved"), /digits with no leading zero and at most 20 of them \(`WORKFLOW_RUN_ID` of `@domains\/ghcr`\), or `local`/);
  assert.equal(String(WORKFLOW_RUN_ID), String(/^[1-9][0-9]{0,19}$/));
  for (const ok of ["1", `9${"0".repeat(19)}`, "local"]) assert.ok(RUN_ID.test(ok), ok);
  for (const bad of ["0", "01", `1${"0".repeat(20)}`, "Local", "local1"]) assert.ok(!RUN_ID.test(bad), bad);
});
