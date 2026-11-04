// adapters/thc-ct/src/pass.ts — one candidate's integrity pass: the whole
// file read from one host, checked, gunzipped, normalised and sorted into
// sealed runs, all before the first write (DOM-029, design D3 and D4).
//
//   const pass = await readPass(candidate, ctx, limits);   // or throws HostFault
//
// In this order:
//   1. the located size (HEAD's Content-Length, or the listing's size) above
//      maxFileBytes is `size`, with no GET;
//   2. GET with ctx.userAgent and Accept-Encoding: identity, under
//      AbortSignal.timeout(readDeadlineS): a status other than 200 is a fault
//      named for the host (`cs2`, `hf`), a thrown fetch too, and the deadline
//      `timeout`, whether it falls before the answer or inside the body;
//   3. a Content-Encoding other than none or identity is `encoding`: the
//      bytes kept are the file as the host stores it, never a body a hop
//      re-encoded;
//   4. the body, held whole as blocks of up to 8 MiB: its Content-Length, the
//      located size and the bytes read must be equal, else `length`, and a body
//      that runs past the located size stops there;
//   5. its lines (lines.ts): a gzip that does not decode is `gzip`. Each line
//      goes through normalise and key of @domains/names under ctx.psl; a
//      refusal is counted by its code, and a name joins the names sorter
//      flagged FLAG_EXACT, or FLAG_WILDCARD for a `*.` line;
//   6. more than refusedFault of the non-empty lines refused is `format` (a
//      CSV column, quoting or a space refuses every line as charset, design
//      M22); then no name kept is `empty` (a valid empty gzip inflates to 0
//      bytes with no error, design M21). Without these two, the pack writer
//      would write an empty or near-empty pack that verifies ok (design M26).
// The pass returns the body's blocks, the names sorter with every key added,
// and its counts. Nothing has been written.
import type { AdapterContext } from "@domains/adapter";
import { key, normalise, type Psl } from "@domains/names";
import { GzipError, type LineCounts, linesOf } from "./lines.ts";
import type { Candidate, Host } from "./locate.ts";
import { RunSorter } from "./sorter.ts";

// The flags of a names record (docs/format.md section 5.1), as oi-nrd-fqdn writes them.
export const FLAG_EXACT = 1;
export const FLAG_WILDCARD = 2;
// A body is held as blocks of this many bytes, so a file of 1 GB is 128 arrays, not 16,000 reads.
export const BLOCK_BYTES = 8 << 20;
// The seals of the names sorter in flight while the lines go on.
export const MAX_SEALS = 2;

// The faults of a host (design D25): the host's name for a status or a thrown
// fetch, and one code for each check of the pass.
export const FAULT_CODES = Object.freeze(["cs2", "hf", "timeout", "length", "encoding", "gzip", "empty", "format", "size"] as const);
export type FaultCode = (typeof FAULT_CODES)[number];

export class HostFault extends Error {
  readonly host: Host;
  readonly code: FaultCode;
  constructor(host: Host, code: FaultCode, detail: string) {
    super(detail);
    this.name = "HostFault";
    this.host = host;
    this.code = code;
  }
}

export interface PassLimits {
  readonly runKeys: number;
  readonly maxFileBytes: number;
  readonly readDeadlineS: number;
  readonly refusedFault: number;
}

export interface PassStats {
  readonly bytes: number;
  // Every line, the empty ones among them.
  readonly lines: number;
  readonly empty_lines: number;
  readonly crlf_lines: number;
  readonly upper_lines: number;
  // `*.` lines kept.
  readonly wild_lines: number;
  readonly refused_lines: number;
  // Refused lines by the refusal code of @domains/names.
  readonly refused: ReadonlyMap<string, number>;
  // Refused lines over non-empty lines.
  readonly refused_share: number;
}

export interface Pass {
  readonly candidate: Candidate;
  readonly chunks: readonly Uint8Array[];
  readonly names: RunSorter;
  readonly stats: PassStats;
}

const UPPER = /[A-Z]/;

// True when an error is the deadline's abort (TimeoutError), or an abort.
export const isTimeout = (err: unknown): boolean => {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
};

const message = (err: unknown): string => (err as Error)?.message ?? String(err);

export const deadline = (limits: { readonly readDeadlineS: number }): AbortSignal => AbortSignal.timeout(Math.max(1, Math.ceil(limits.readDeadlineS * 1000)));

// Steps 2 to 4: the body's blocks, exactly `bytes` long.
async function readBody(c: Candidate, ctx: AdapterContext, limits: PassLimits): Promise<Uint8Array[]> {
  let res: Response;
  try {
    res = await ctx.fetch(c.url, { headers: { "user-agent": ctx.userAgent, "accept-encoding": "identity" }, signal: deadline(limits) });
  } catch (err) {
    if (isTimeout(err)) throw new HostFault(c.host, "timeout", `GET ${c.url} found no answer within ${limits.readDeadlineS} s`);
    throw new HostFault(c.host, c.host, `GET ${c.url} failed: ${message(err)}`);
  }
  const drop = async (): Promise<void> => {
    await res.body?.cancel().catch(() => {
      // Deliberately empty: the answer is refused for the fault named; its body is not read.
    });
  };
  if (res.status !== 200) {
    await drop();
    throw new HostFault(c.host, c.host, `GET ${c.url} answered ${res.status}`);
  }
  const encoding = res.headers.get("content-encoding");
  if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {
    await drop();
    throw new HostFault(c.host, "encoding", `GET ${c.url} answered Content-Encoding ${JSON.stringify(encoding)}; only the file's own bytes are kept`);
  }
  const declared = res.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared.trim()) || Number(declared.trim()) !== c.bytes) {
    await drop();
    throw new HostFault(c.host, "length", `GET ${c.url} answered Content-Length ${JSON.stringify(declared)}; the file was located at ${c.bytes} B`);
  }
  // Each block is sized to what is left of the located bytes, so the blocks of
  // a whole body are full and exactly c.bytes long; a body that ends short is
  // refused before its last block is kept.
  const blocks: Uint8Array[] = [];
  let block: Uint8Array | null = null;
  let fill = 0;
  let total = 0;
  const reader = res.body?.getReader() ?? null;
  if (reader !== null) {
    try {
      for (;;) {
        const r = await reader.read();
        if (r.done) break;
        let chunk = r.value;
        if (total + chunk.byteLength > c.bytes) {
          await reader.cancel().catch(() => {
            // Deliberately empty: the body is refused as longer than located.
          });
          throw new HostFault(c.host, "length", `GET ${c.url} sent more than the ${c.bytes} B located`);
        }
        while (chunk.byteLength > 0) {
          if (block === null) {
            block = new Uint8Array(Math.min(BLOCK_BYTES, c.bytes - total));
            fill = 0;
          }
          const n = Math.min(block.byteLength - fill, chunk.byteLength);
          block.set(chunk.subarray(0, n), fill);
          fill += n;
          total += n;
          chunk = chunk.subarray(n);
          if (fill === block.byteLength) {
            blocks.push(block);
            block = null;
          }
        }
      }
    } catch (err) {
      if (err instanceof HostFault) throw err;
      if (isTimeout(err)) throw new HostFault(c.host, "timeout", `GET ${c.url} did not end within ${limits.readDeadlineS} s (${total} of ${c.bytes} B read)`);
      throw new HostFault(c.host, c.host, `GET ${c.url} failed after ${total} of ${c.bytes} B: ${message(err)}`);
    }
  }
  if (total !== c.bytes || block !== null) throw new HostFault(c.host, "length", `GET ${c.url} sent ${total} B; its Content-Length and the location say ${c.bytes} B`);
  return blocks;
}

// Steps 5 and 6 over the held blocks.
async function sortNames(c: Candidate, chunks: readonly Uint8Array[], psl: Psl, limits: PassLimits): Promise<{ names: RunSorter; stats: PassStats }> {
  const names = new RunSorter(limits.runKeys);
  const counts: LineCounts = { lines: 0, empty: 0, crlf: 0 };
  const refused = new Map<string, number>();
  let upper = 0;
  let wild = 0;
  let refusedLines = 0;
  let kept = 0;
  try {
    for await (const batch of linesOf(chunks, counts)) {
      for (const line of batch) {
        if (UPPER.test(line)) upper += 1;
        const n = normalise(line, psl);
        if ("refused" in n) {
          refusedLines += 1;
          refused.set(n.refused, (refused.get(n.refused) ?? 0) + 1);
          continue;
        }
        kept += 1;
        if (n.wild) wild += 1;
        names.add(key(n.name), n.wild ? FLAG_WILDCARD : FLAG_EXACT);
      }
      if (names.pending > MAX_SEALS) await names.drain(MAX_SEALS);
    }
  } catch (err) {
    if (err instanceof GzipError) throw new HostFault(c.host, "gzip", `${c.url}: ${err.message}`);
    throw err;
  }
  const nonEmpty = counts.lines - counts.empty;
  const share = nonEmpty === 0 ? 0 : refusedLines / nonEmpty;
  const codes = [...refused].sort(([a], [b]) => (a < b ? -1 : 1));
  if (nonEmpty > 0 && share > limits.refusedFault)
    throw new HostFault(
      c.host,
      "format",
      `${c.url}: ${refusedLines} of ${nonEmpty} non-empty lines are refused (${codes.map(([k, v]) => `${k} ${v}`).join(", ")}), over ${limits.refusedFault} of them: the line format changed`,
    );
  if (kept === 0) throw new HostFault(c.host, "empty", `${c.url}: no name is kept from ${counts.lines} line(s) of ${chunks.reduce((s, b) => s + b.byteLength, 0)} B`);
  return {
    names,
    stats: {
      bytes: c.bytes,
      lines: counts.lines,
      empty_lines: counts.empty,
      crlf_lines: counts.crlf,
      upper_lines: upper,
      wild_lines: wild,
      refused_lines: refusedLines,
      refused,
      refused_share: share,
    },
  };
}

export async function readPass(c: Candidate, ctx: AdapterContext, limits: PassLimits): Promise<Pass> {
  if (c.bytes > limits.maxFileBytes) throw new HostFault(c.host, "size", `${c.url} is located at ${c.bytes} B, over the ${limits.maxFileBytes} B a day's file may hold`);
  const chunks = await readBody(c, ctx, limits);
  const { names, stats } = await sortNames(c, chunks, ctx.psl, limits);
  return { candidate: c, chunks, names, stats };
}
