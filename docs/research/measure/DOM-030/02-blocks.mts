// DOM-030 instrument, copied from .tmp/dom030/blocks.mts as it ran, with its import and
// output paths moved to docs/research/measure/DOM-030/. Run from the
// repository root.
// .tmp/dom030/blocks.mts — scratch measurement for DOM-030's maxRawBlockBytes:
// the largest raw block of every live pack the root names (key copy and time copy),
// read anonymously from GHCR. Not part of the tree.
//   node docs/research/measure/DOM-030/02-blocks.mts
import { ghcrReader, repoOf } from "../../../../packages/ghcr/src/index.ts";
import { PackIndex } from "../../../../packages/pack/src/index.ts";
import { validateRoot } from "../../../../packages/root/src/index.ts";
import { USER_AGENT } from "../../../../scripts/lib/user-agent.mjs";

const g = ghcrReader({ userAgent: USER_AGENT, timeoutMs: 30_000 });
const m = await g.getManifest(repoOf("root"), "latest");
const layer = m.json.layers?.find((l) => l.annotations?.["org.opencontainers.image.title"] === "root.json");
if (!layer) throw new Error("no root.json layer");
const r = await g.readRange(repoOf("root"), layer.digest, 0, layer.size);
const root = validateRoot(JSON.parse(new TextDecoder().decode(r.bytes)), { strict: false });
console.log(`root ${m.digest} seq ${root.root_seq} created ${root.created}`);

type Job = { ds: string; tag: string; tier: string; repo: string; idx: { digest: string; size: number }; copy: string };
const jobs: Job[] = [];
for (const [ds, packs] of Object.entries(root.datasets)) {
  for (const p of packs) {
    jobs.push({ ds, tag: p.tag, tier: p.tier, repo: p.repo, idx: p.idx, copy: "key" });
    if (p.time) jobs.push({ ds, tag: p.tag, tier: p.tier, repo: p.repo, idx: p.time.idx, copy: "time" });
  }
}
const out: { ds: string; tag: string; tier: string; copy: string; blocks: number; records: number; maxRaw: number; maxPacked: number; perBlock: number }[] = [];
let next = 0;
async function worker(): Promise<void> {
  for (;;) {
    const j = jobs[next++];
    if (!j) return;
    const bytes = (await g.readRange(j.repo, j.idx.digest, 0, j.idx.size)).bytes;
    const index = await PackIndex.open(bytes);
    let maxRaw = 0;
    let maxPacked = 0;
    for await (const e of index.entries()) {
      if (e.raw > maxRaw) maxRaw = e.raw;
      if (e.packed > maxPacked) maxPacked = e.packed;
    }
    out.push({ ds: j.ds, tag: j.tag, tier: j.tier, copy: j.copy, blocks: index.header.blocks, records: index.header.records, maxRaw, maxPacked, perBlock: index.header.recordsPerBlock });
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
const by = new Map<string, { n: number; maxRaw: number; at: string; maxPacked: number }>();
for (const o of out) {
  const k = `${o.ds} ${o.tier} ${o.copy}`;
  const b = by.get(k) ?? { n: 0, maxRaw: 0, at: "", maxPacked: 0 };
  b.n += 1;
  if (o.maxRaw > b.maxRaw) {
    b.maxRaw = o.maxRaw;
    b.at = o.tag;
  }
  b.maxPacked = Math.max(b.maxPacked, o.maxPacked);
  by.set(k, b);
}
for (const [k, b] of [...by].sort()) console.log(`${k}: packs ${b.n}, max raw block ${b.maxRaw} B (${b.at}), max packed ${b.maxPacked} B`);
const all = Math.max(...out.map((o) => o.maxRaw));
console.log(`packs read ${out.length} of ${jobs.length}; largest raw block ${all} B; GHCR requests ${g.dial.count}`);
