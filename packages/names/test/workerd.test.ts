// packages/names in workerd (Miniflare, through @domains/testkit), under the
// harness's compatibility date and flags (no nodejs_compat): the Worker path is
// proven, not assumed. node:url does not exist there, so the IDN conversion runs
// through the URL parser; this test holds its answers equal to Node's, and to
// node:url domainToASCII, name by name.
//
//   node scripts/test.mjs packages/names --name workerd
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { domainToASCII } from "node:url";
import { withWorker } from "@domains/testkit";
import { key, loadPsl, normalise, split } from "../src/index.ts";

const WORKER = join(import.meta.dirname, "names-worker.ts");
const BYTES = readFileSync(join(import.meta.dirname, "fixtures", "psl-2026-10-27.dat"));

// IDN names, one of each refusal, both sections and a wildcard.
const IDN = ["bücher.example", "MÜNCHEN.de", "*.ü.com.", "x.公司.cn", "a.個人.香港", "straße.de", "пример.рф", "例え.jp", "ＡＢＣ.com", "ex。example"];
const NAMES = [...IDN, "api.example.com.np", "x.github.io", "github.io", "*.API.Example.COM.", "co.uk", "192.0.2.1", "１.２.３.４", "a b.com", "ü@evil.example", "a／b.com", "localhost", "a..com", ""];

interface Row {
  input: string;
  refused?: string;
  name?: string;
  wild?: boolean;
  key?: string;
  suffix?: string;
  reg?: string | null;
  site?: string | null;
  labels?: number;
}

test("names workerd: normalise, split and key in workerd answer what they answer in Node, IDN names included", async () => {
  const psl = await loadPsl(BYTES);
  const expected: Row[] = NAMES.map((input) => {
    const r = normalise(input, psl);
    if ("refused" in r) return { input, refused: r.refused };
    return { input, name: r.name, wild: r.wild, key: key(r.name), ...split(r.name, psl) };
  });
  const query = NAMES.map((n) => `name=${encodeURIComponent(n)}`).join("&");
  await withWorker({ scriptPath: WORKER }, async (w) => {
    const res = await w.fetch(`/names?${query}`, { method: "POST", body: BYTES });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { sha256: string; rules: { icann: number; private: number }; rows: Row[] };
    assert.equal(body.sha256, psl.sha256);
    assert.deepEqual(body.rules, { icann: 6949, private: 3448 });
    assert.deepEqual(body.rows, expected);
    // The IDN names, converted in workerd, are what node:url gives.
    for (const row of body.rows.filter((r) => IDN.includes(r.input))) {
      const bare = row.input.replace(/\.$/, "").replace(/^\*\./, "");
      assert.equal(row.name, domainToASCII(bare), row.input);
    }
    const byInput = new Map(body.rows.map((r) => [r.input, r]));
    assert.deepEqual(byInput.get("x.公司.cn"), {
      input: "x.公司.cn",
      name: "x.xn--55qx5d.cn",
      wild: false,
      key: "cn.xn--55qx5d.x",
      suffix: "xn--55qx5d.cn",
      reg: "x.xn--55qx5d.cn",
      site: "x.xn--55qx5d.cn",
      labels: 3,
    });
    assert.equal(byInput.get("192.0.2.1")!.refused, "numeric-tld");
    assert.equal(byInput.get("ü@evil.example")!.refused, "charset");
  });
});

test("names workerd: a list cut short is refused in workerd as in Node", async () => {
  const cut = BYTES.subarray(0, BYTES.indexOf("// ===BEGIN PRIVATE DOMAINS==="));
  await withWorker({ scriptPath: WORKER }, async (w) => {
    const res = await w.fetch("/names?name=example.com", { method: "POST", body: cut });
    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: "missing marker // ===BEGIN PRIVATE DOMAINS===" });
  });
});
