// adapters/thc-ct/src/locate.ts — where a THC day's file is: the hosts in
// order, each answering present (a candidate), absent or a fault (DOM-029,
// design D3 and section 4.4).
//
//   const loc = new Locator(ctx, hosts, limits);
//   loc.live(day)       // [cs2, hf]: cs2 first, then the bucket
//   loc.backfill(day)   // [hf, cs2]: the bucket holds every day, cs2 lists from 2026-10-01
// Each is a list of probes, called in order and only as needed, so the
// bucket's listing is read only when cs2 is absent, faulted, or its pass
// faults. A candidate is { host, url, bytes, lastModified }:
//   cs2  HEAD https://cs2.ip.thc.org/<day>.txt.gz: 200 gives the candidate,
//        its bytes Content-Length and lastModified Last-Modified; 404 is
//        absent; any other answer, a thrown fetch or the deadline is a fault;
//   hf   the entry of the bucket's listing whose path ends in /<day>.txt.gz:
//        url resolve + path + "?download=true", bytes its size, lastModified
//        its mtime. The path always comes from the listing, never from the
//        date: 2026-10-31 sits at 2026/11/2026-10-31.txt.gz, the month of its
//        upload (design F1). A day the listing lacks is absent; a listing that
//        fails is a fault, never an absence.
// The url is the one written as the segments' dev.pkgforge.domains.url
// (AGENTS.md absolute 11): cs2's file URL or the bucket's resolve URL, never
// the signed CDN URL the resolve redirects to.
//
// readListing reads the listing once a Locator: GET the listing URL, follow
// each Link rel="next" on the listing's origin, at most maxListingPages pages.
// An entry of type file whose path is <year>/<month>/<YYYY-MM-DD>.txt.gz names
// that day; other entries are not a day's file and are passed over. A day
// named twice, a size that is not a whole number, or a page that is not a JSON
// list is a fault: the listing changed shape, and nothing is read by guess.
// cs2Index reads cs2's index page (nginx's autoindex) for the backfill plan
// (scripts/ingest/thc-plan.mjs): each <day>.txt.gz, its size and the minute it
// is listed at.
import type { AdapterContext, Fetch } from "@domains/adapter";
import { isDay } from "./cursor.ts";
import { deadline, HostFault, isTimeout } from "./pass.ts";

export type Host = "cs2" | "hf";

export interface Candidate {
  readonly host: Host;
  readonly url: string;
  readonly bytes: number;
  // ISO 8601 UTC, or null when the host names none.
  readonly lastModified: string | null;
}

export type Located = { readonly found: Candidate } | { readonly absent: Host; readonly detail: string } | { readonly fault: HostFault };
export type Probe = () => Promise<Located>;

export interface Hosts {
  // cs2's root: the file of a day is <cs2><day>.txt.gz.
  readonly cs2: string;
  // The bucket's recursive tree listing (Hugging Face's API).
  readonly listing: string;
  // The bucket's resolve root: a file is <resolve><path>?download=true.
  readonly resolve: string;
}

export interface LocateLimits {
  readonly readDeadlineS: number;
  readonly maxListingPages: number;
}

export interface ListingEntry {
  readonly day: string;
  readonly path: string;
  readonly size: number;
  readonly mtime: string | null;
}

export type Listing = ReadonlyMap<string, ListingEntry>;

const DAY_PATH = /^\d{4}\/\d{1,2}\/(\d{4}-\d{2}-\d{2})\.txt\.gz$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const message = (err: unknown): string => (err as Error)?.message ?? String(err);
const isoSecond = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19)}Z`;

// An HTTP date (Last-Modified) as ISO 8601 UTC to the second, or null.
export function httpDate(text: string | null): string | null {
  if (text === null) return null;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? isoSecond(ms) : null;
}

// The URL of a Link header's rel="next", or null.
export function nextLink(header: string | null): string | null {
  if (header === null) return null;
  for (const part of header.split(",")) {
    const m = /^\s*<([^>]*)>\s*;(.*)$/.exec(part);
    if (m !== null && /(?:^|;)\s*rel\s*=\s*"?next"?\s*(?:;|$)/i.test(m[2]!)) return m[1]!;
  }
  return null;
}

// The day files of one listing page, added to `into`. Throws HostFault `hf`.
export function listingEntries(page: unknown, into: Map<string, ListingEntry>, what: string): void {
  const bad = (detail: string): HostFault => new HostFault("hf", "hf", `${what}: ${detail}`);
  if (!Array.isArray(page)) throw bad("the page is not a JSON list");
  page.forEach((e: unknown, i: number) => {
    if (!isObj(e)) throw bad(`entry ${i} is not an object`);
    if (e.type !== "file") return;
    if (typeof e.path !== "string") throw bad(`entry ${i} has no path`);
    const m = DAY_PATH.exec(e.path);
    if (m === null) return;
    const day = m[1]!;
    if (!isDay(day)) throw bad(`entry ${i} ${JSON.stringify(e.path)} names no calendar day from 2026-01-01`);
    if (typeof e.size !== "number" || !Number.isSafeInteger(e.size) || e.size < 0) throw bad(`entry ${i} ${e.path} has the size ${JSON.stringify(e.size)}, not a whole number`);
    const was = into.get(day);
    if (was !== undefined) throw bad(`the listing names ${day} twice, at ${was.path} and ${e.path}`);
    const mtime = typeof e.mtime === "string" && ISO_MS.test(e.mtime) && Number.isFinite(Date.parse(e.mtime)) ? isoSecond(Date.parse(e.mtime)) : null;
    into.set(day, { day, path: e.path, size: e.size, mtime });
  });
}

// The bucket's listing, every page. Throws HostFault `hf` (`timeout` for the deadline).
export async function readListing(fetch: Fetch, url: string, userAgent: string, limits: LocateLimits): Promise<Listing> {
  const origin = new URL(url).origin;
  const out = new Map<string, ListingEntry>();
  let at: string | null = url;
  for (let page = 1; at !== null; page++) {
    if (page > limits.maxListingPages) throw new HostFault("hf", "hf", `the listing ${url} has more than ${limits.maxListingPages} pages`);
    let res: Response;
    try {
      res = await fetch(at, { headers: { "user-agent": userAgent, accept: "application/json" }, signal: deadline(limits) });
    } catch (err) {
      if (isTimeout(err)) throw new HostFault("hf", "timeout", `GET ${at} found no answer within ${limits.readDeadlineS} s`);
      throw new HostFault("hf", "hf", `GET ${at} failed: ${message(err)}`);
    }
    let text: string;
    try {
      text = await res.text();
    } catch (err) {
      if (isTimeout(err)) throw new HostFault("hf", "timeout", `GET ${at} did not end within ${limits.readDeadlineS} s`);
      throw new HostFault("hf", "hf", `GET ${at} failed: ${message(err)}`);
    }
    if (res.status !== 200) throw new HostFault("hf", "hf", `GET ${at} answered ${res.status}`);
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      // The parser's message quotes the body; the fault says what failed.
      throw new HostFault("hf", "hf", `GET ${at}: the page is not JSON (${text.length} characters)`);
    }
    listingEntries(json, out, `the listing page ${page} (${at})`);
    const next = nextLink(res.headers.get("link"));
    if (next === null) at = null;
    else {
      let u: URL;
      try {
        u = new URL(next, at);
      } catch {
        throw new HostFault("hf", "hf", `the listing page ${page} links its next page at ${JSON.stringify(next)}, which is not a URL`);
      }
      if (u.origin !== origin) throw new HostFault("hf", "hf", `the listing page ${page} links its next page at ${u.href}, off the listing's origin ${origin}`);
      at = u.href;
    }
  }
  return out;
}

export interface IndexEntry {
  readonly bytes: number;
  // The minute the index lists the file at, ISO 8601 UTC.
  readonly listed: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const INDEX_LINE = /^<a href="(\d{4}-\d{2}-\d{2})\.txt\.gz">(\d{4}-\d{2}-\d{2})\.txt\.gz<\/a>\s+(\d{2})-([A-Z][a-z]{2})-(\d{4}) (\d{2}):(\d{2})\s+(\d+)\s*$/;

// cs2's index page: each day file it lists. A line that names a day file and
// does not parse, or a day listed twice, throws HostFault `cs2`.
export function cs2Index(html: string): Map<string, IndexEntry> {
  const out = new Map<string, IndexEntry>();
  html.split("\n").forEach((line, i) => {
    if (!/\.txt\.gz"/.test(line)) return;
    const m = INDEX_LINE.exec(line.trim());
    if (m === null || m[1] !== m[2]) throw new HostFault("cs2", "cs2", `cs2's index line ${i + 1} names a day's file in a shape not read: ${JSON.stringify(line.slice(0, 200))}`);
    const day = m[1]!;
    const month = MONTHS.indexOf(m[4]!);
    const [date, year, hour, minute] = [Number(m[3]), Number(m[5]), Number(m[6]), Number(m[7])];
    const at = new Date(Date.UTC(year, month, date, hour, minute));
    // Date.UTC rolls 31-Sep to 01-Oct and 24:00 to the next day: only the read-back refuses them.
    if (!isDay(day) || month < 0 || at.getUTCDate() !== date || at.getUTCMonth() !== month || at.getUTCHours() !== hour || at.getUTCMinutes() !== minute)
      throw new HostFault("cs2", "cs2", `cs2's index line ${i + 1} names ${day} at ${m[3]}-${m[4]}-${m[5]} ${m[6]}:${m[7]}, not a calendar day and time`);
    const listed = isoSecond(at.getTime());
    if (out.has(day)) throw new HostFault("cs2", "cs2", `cs2's index lists ${day} twice`);
    const bytes = Number(m[8]);
    if (!Number.isSafeInteger(bytes)) throw new HostFault("cs2", "cs2", `cs2's index line ${i + 1} lists ${day} at ${m[8]} B, not a whole number`);
    out.set(day, { bytes, listed });
  });
  return out;
}

export class Locator {
  private readonly ctx: AdapterContext;
  private readonly hosts: Hosts;
  private readonly limits: LocateLimits;
  private listing: Promise<Listing> | null = null;

  constructor(ctx: AdapterContext, hosts: Hosts, limits: LocateLimits) {
    this.ctx = ctx;
    this.hosts = hosts;
    this.limits = limits;
  }

  live(day: string): Probe[] {
    return [() => this.cs2(day), () => this.hf(day)];
  }

  backfill(day: string): Probe[] {
    return [() => this.hf(day), () => this.cs2(day)];
  }

  async cs2(day: string): Promise<Located> {
    const url = `${this.hosts.cs2}${day}.txt.gz`;
    let res: Response;
    try {
      res = await this.ctx.fetch(url, { method: "HEAD", headers: { "user-agent": this.ctx.userAgent, "accept-encoding": "identity" }, signal: deadline(this.limits) });
    } catch (err) {
      if (isTimeout(err)) return { fault: new HostFault("cs2", "timeout", `HEAD ${url} found no answer within ${this.limits.readDeadlineS} s`) };
      return { fault: new HostFault("cs2", "cs2", `HEAD ${url} failed: ${message(err)}`) };
    }
    await res.body?.cancel().catch(() => {
      // Deliberately empty: a HEAD's body is not read.
    });
    if (res.status === 404) return { absent: "cs2", detail: `HEAD ${url} answered 404` };
    if (res.status !== 200) return { fault: new HostFault("cs2", "cs2", `HEAD ${url} answered ${res.status}`) };
    const length = res.headers.get("content-length");
    if (length === null || !/^\d+$/.test(length.trim()) || !Number.isSafeInteger(Number(length.trim())))
      return { fault: new HostFault("cs2", "cs2", `HEAD ${url} answered 200 with Content-Length ${JSON.stringify(length)}, not a size`) };
    return { found: { host: "cs2", url, bytes: Number(length.trim()), lastModified: httpDate(res.headers.get("last-modified")) } };
  }

  async hf(day: string): Promise<Located> {
    this.listing ??= readListing(this.ctx.fetch, this.hosts.listing, this.ctx.userAgent, this.limits);
    let listing: Listing;
    try {
      listing = await this.listing;
    } catch (err) {
      if (err instanceof HostFault) return { fault: err };
      throw err;
    }
    const e = listing.get(day);
    if (e === undefined) return { absent: "hf", detail: `the bucket's listing (${listing.size} day files) does not name ${day}` };
    return { found: { host: "hf", url: `${this.hosts.resolve}${e.path}?download=true`, bytes: e.size, lastModified: e.mtime } };
  }
}
