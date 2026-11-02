// packages/core/src/contact.ts: the one User-Agent of ruling 11, which the
// Worker imports from @domains/core and scripts/lib/user-agent.mjs re-exports
// by path for the workflows that install nothing from npm.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { USER_AGENT as SCRIPTS_USER_AGENT } from "../../../scripts/lib/user-agent.mjs";
import { USER_AGENT } from "../src/index.ts";

test("contact: USER_AGENT names the project, its repository and the contact domains@pkgforge.dev", () => {
  assert.equal(USER_AGENT, "domains.pkgforge.dev/1.0 (+https://github.com/pkgforge-dev/domains.pkgforge.dev; contact: domains@pkgforge.dev)");
});

test("contact: scripts/lib/user-agent.mjs re-exports it by a relative path, which resolves with no node_modules, and contact.ts imports nothing", () => {
  assert.equal(SCRIPTS_USER_AGENT, USER_AGENT);
  const script = readFileSync(new URL("../../../scripts/lib/user-agent.mjs", import.meta.url), "utf8");
  assert.match(script, /^export \{ USER_AGENT \} from '\.\.\/\.\.\/packages\/core\/src\/contact\.ts';$/m);
  assert.doesNotMatch(script, /from '@domains\//);
  const contact = readFileSync(new URL("../src/contact.ts", import.meta.url), "utf8");
  assert.doesNotMatch(contact, /^import /m);
});
