// DOM-030 instrument, copied from .tmp/dom030/review/lens-claims/root73.mts as it
// ran: it needs no path moved. The claim audit wrote it
// to re-read the root cost of 2026-11-02T00:32:58Z, whose own script was not kept. Run from the
// repository root.
// scratch (claim audit): read the layer of the root of root_seq 73 by its digest, anonymously,
// check its size, then time JSON.parse and validateRoot on it as the entry says.
import { ghcrReader, repoOf } from "@domains/ghcr";
import { validateRoot } from "@domains/root";

const g = ghcrReader({ userAgent: "domains.pkgforge.dev/1.0 (+https://github.com/pkgforge-dev/domains.pkgforge.dev; contact: domains@pkgforge.dev)" });
const repo = repoOf("root");
const digest = "sha256:59f8e15436130350bc27a7222414f68afff37582018a19ea13446ae0aab78e4e";
const probe = await g.readRange(repo, digest, 0, 1);
console.log("total size from Content-Range:", probe.size);
const whole = await g.readRange(repo, digest, 0, probe.size as number);
console.log("bytes read:", whole.bytes.byteLength);
const text = new TextDecoder().decode(whole.bytes);
for (let i = 0; i < 5; i += 1) {
  const t0 = performance.now();
  const json = JSON.parse(text);
  const t1 = performance.now();
  const r = validateRoot(json, { strict: false });
  const t2 = performance.now();
  console.log(`run ${i + 1}: parse ${(t1 - t0).toFixed(2)} ms, validateRoot ${(t2 - t1).toFixed(2)} ms, root_seq ${r.root_seq}, as_of ${r.as_of}, created ${r.created}`);
}
