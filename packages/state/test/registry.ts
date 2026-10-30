// packages/state/test/registry.ts — a GHCR double for the guard tests, and the
// three steps of one ingest run driven through @domains/state against it. All
// synthetic: no byte, digest or tag was read from GHCR.
//
// The double holds tags as `PACKAGE:TAG` → digest, and the bytes of each
// digest. A digest is the SHA-256 of the bytes pushed (a stand-in for the
// manifest digest, which is a function of the bytes the same way).
//   push(ref, bytes)  a write-once tag, as scripts/ghcr/push.mjs writes one:
//                     `pushed` when absent; `present` when it holds these
//                     bytes (nothing written); `replaced` when it holds other
//                     bytes, which the tag keeps (nothing written; push.mjs
//                     exits 3)
//   head(ref)         the digest a tag holds, or null: an anonymous HEAD, or a
//                     read with the job's token, alike here
//   tag(ref, digest)  `oras tag`: a moving tag set to a digest the double holds
// `beforeHead(ref, n)`, set at any time, runs before the n-th head of a ref:
// the place a test plants a second writer. Every call is logged in `calls`.
//
// The run's steps, as DOM-024 places them:
//   lane(...)     a lane's adapter run (scripts/ingest/run.mjs): pushes its
//                 segments write-once and proposes from the cursor it read
//   pushJob(...)  the job `push`: reads the live state, advances it over the
//                 proposals (a HEAD of each ref), and moves `state:latest`
//   moveState     the guarded move (moveTag of scripts/state/lib.mjs): guard,
//                 push the run object, guard again, then `oras tag`
import { createHash } from "node:crypto";
import { type Cursor, canonicalJson } from "@domains/adapter";
import { fileTag, rawTag, segTag, stateRunTag } from "@domains/ghcr";
import { type Advanced, advance, cursorOf, encodeState, guard, type Lane, type Proposal, type ProposedDay, parseState, propose, type State } from "../src/index.ts";

export const LATEST = "state:latest";

export type PushAnswer = "pushed" | "present" | "replaced";

export const digestOf = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

export class MockRegistry {
  readonly tags = new Map<string, string>();
  readonly blobs = new Map<string, Uint8Array>();
  readonly calls: string[] = [];
  beforeHead: ((ref: string, n: number) => void) | null = null;
  readonly #heads = new Map<string, number>();

  head(ref: string): string | null {
    const n = (this.#heads.get(ref) ?? 0) + 1;
    this.#heads.set(ref, n);
    this.beforeHead?.(ref, n);
    this.calls.push(`head ${ref}`);
    return this.tags.get(ref) ?? null;
  }

  push(ref: string, bytes: Uint8Array): { readonly answer: PushAnswer; readonly digest: string } {
    const digest = digestOf(bytes);
    const held = this.tags.get(ref);
    if (held !== undefined) {
      const answer = held === digest ? "present" : "replaced";
      this.calls.push(`push ${ref} ${answer}`);
      return { answer, digest: held };
    }
    this.tags.set(ref, digest);
    this.blobs.set(digest, bytes);
    this.calls.push(`push ${ref} pushed`);
    return { answer: "pushed", digest };
  }

  tag(ref: string, digest: string): void {
    if (!this.blobs.has(digest)) throw new Error(`oras tag: the double holds no manifest ${digest}`);
    this.calls.push(`tag ${ref} ${digest}`);
    this.tags.set(ref, digest);
  }

  // The bytes a tag holds, or null.
  read(ref: string): Uint8Array | null {
    const digest = this.tags.get(ref);
    return digest === undefined ? null : (this.blobs.get(digest) ?? null);
  }

  // The live state, as a reader parses it, or null.
  state(): State | null {
    const bytes = this.read(LATEST);
    return bytes === null ? null : parseState(bytes);
  }
}

// The guarded move of `state:latest` to `next`: the digest `expected` was read
// before the run planned it. Returns the digest moved to.
export function moveState(reg: MockRegistry, next: State, expected: string | null): string {
  guard(LATEST, expected, reg.head(LATEST));
  const runRef = `state:${stateRunTag(next.updated)}`;
  const pushed = reg.push(runRef, encodeState(next));
  if (pushed.answer === "replaced") throw new Error(`${runRef} holds another manifest`);
  guard(LATEST, expected, reg.head(LATEST));
  reg.tag(LATEST, pushed.digest);
  return pushed.digest;
}

export interface LaneSegment {
  readonly source: string;
  readonly dataset: "names" | "domains";
  readonly start: string;
  readonly end: string;
  // The records' text, which stands for the pack's bytes.
  readonly records: string;
  // The raw file of a file source's segment, whose SHA-256 names its tag (fileTag).
  readonly file?: string;
  readonly quarantined?: boolean;
}

// A raw lane object of a lane's run: its bytes, pushed under rawTag of its
// source and window unless `pushed` is false (the tag then stays as it is:
// absent, or holding what a test put there), and proposed with the digest of
// these bytes either way.
export interface LaneRaw {
  readonly source: string;
  readonly start: string;
  readonly end: string;
  readonly bytes: string;
  readonly pushed?: boolean;
}

export interface LaneRun {
  readonly adapter: string;
  readonly lane: Lane | null;
  readonly run: string;
  readonly attempt?: number;
  readonly at: string;
  // The live state the lane read at its start.
  readonly live: State | null;
  readonly segments: readonly LaneSegment[];
  readonly after: Cursor;
  readonly history?: readonly ProposedDay[];
  readonly raw?: readonly LaneRaw[];
}

export interface LaneResult {
  readonly proposal: Proposal;
  readonly answers: readonly PushAnswer[];
}

// One adapter run of a lane: each segment pushed under its write-once tag,
// then the proposal from the cursor the lane read.
export function lane(reg: MockRegistry, r: LaneRun): LaneResult {
  const answers: PushAnswer[] = [];
  const segments = r.segments.map((s) => {
    const variant = s.dataset === "domains" ? "d" : undefined;
    const tag = s.file === undefined ? segTag(s.source, s.start, s.end, variant) : fileTag(s.source, s.start, digestOf(s.file), variant);
    const ref = `obs:${tag}`;
    const pushed = reg.push(ref, new TextEncoder().encode(s.records));
    if (pushed.answer === "replaced") throw new Error(`${ref} holds another manifest`);
    answers.push(pushed.answer);
    return { ref, digest: pushed.digest, source: s.source, dataset: s.dataset, start: s.start, end: s.end, count: s.records.split("\n").filter(Boolean).length, quarantined: s.quarantined ?? false };
  });
  const proposal = propose({
    adapter: r.adapter,
    lane: r.lane,
    run: r.run,
    attempt: r.attempt ?? 1,
    at: r.at,
    before: cursorOf(r.live, r.adapter),
    after: r.after,
    segments,
    raw: (r.raw ?? []).map((x) => {
      const ref = `obs:${rawTag(x.source, x.start, x.end)}`;
      const bytes = new TextEncoder().encode(x.bytes);
      if (x.pushed !== false) {
        const pushed = reg.push(ref, bytes);
        if (pushed.answer === "replaced") throw new Error(`${ref} holds another manifest`);
        answers.push(pushed.answer);
      }
      return { ref, digest: digestOf(bytes), source: x.source, start: x.start, end: x.end };
    }),
    history: r.history ?? [],
  });
  return { proposal, answers };
}

export interface PushJob {
  readonly advanced: Advanced;
  // The digest state:latest moved to, or null when nothing changed.
  readonly moved: string | null;
}

// The job `push`: read the live state, advance it over the proposals, and
// move `state:latest` under the guard when it changed.
export function pushJob(reg: MockRegistry, proposals: readonly Proposal[], options: { readonly now: string; readonly run: string }): PushJob {
  const expected = reg.head(LATEST);
  const live = reg.state();
  const advanced = advance(live, proposals, (ref) => reg.head(ref), options);
  if (!advanced.changed) return { advanced, moved: null };
  return { advanced, moved: moveState(reg, advanced.state, expected) };
}

// The proposal as JSON with the fields that differ between two runs of one
// lane (the run, the attempt, the time) left out.
export const sameWork = (p: Proposal): string => canonicalJson({ ...p, run: null, attempt: null, at: null });
