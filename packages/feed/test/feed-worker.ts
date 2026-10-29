// packages/feed/test/feed-worker.ts — the Worker the feed workerd test runs. It
// proves packages/feed/src runs in workerd under the pinned compatibility date
// and flags (no nodejs_compat): the planner, the bind of a time copy to its key
// copy (timeBindFault), and readFeed over both copies read with
// DecompressionStream.
//
//   POST /feed   the body is JSON: { packs, live, sources, query, read }: packs
//                by tag ({ idx, parts, time } as hex, time { idx, parts } or
//                null for none), the live set (the shape of root.json's
//                datasets), the source rows, the window query of planWindow,
//                and the read options of readFeed (order, limit, after, filter,
//                copy). Answers the page: rows, next, partial and stats.
// A FeedError answers 422 with its code and message. Any other path or method
// answers 404.
import { FEED_CODEC, FEED_TIME_CODEC, fromHex, PackReader, partsSource } from "@domains/pack";
import { type CopyChoice, FeedError, type FeedOrder, type LivePack, planWindow, readFeed, type SourceRowLike, sourceTable, type WindowQuery } from "../src/index.ts";

interface HexCopy {
  idx: string;
  parts: string[];
}

interface Ask {
  packs: Record<string, HexCopy & { time: HexCopy | null }>;
  live: { feed: LivePack[] };
  sources: SourceRowLike[];
  query: WindowQuery;
  read: { order: FeedOrder; limit: number; copy: CopyChoice; after: { firstSeen: number; key: string } | null };
}

const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

async function feed(request: Request): Promise<Response> {
  const ask = (await request.json()) as Ask;
  try {
    const open = async (pack: LivePack) => {
      const bytes = ask.packs[pack.tag];
      // No page caches, as memoryOpen of helpers.ts: the stats compare.
      const reader = await PackReader.open(fromHex(bytes.idx), partsSource(bytes.parts.map(fromHex)), FEED_CODEC, { pageCache: 0 });
      const time = bytes.time === null ? null : await PackReader.open(fromHex(bytes.time.idx), partsSource(bytes.time.parts.map(fromHex)), FEED_TIME_CODEC, { pageCache: 0 });
      return { reader, time };
    };
    const page = await readFeed(planWindow(ask.live, ask.query), { open, table: sourceTable(ask.sources), ...ask.read });
    return json(page);
  } catch (error) {
    if (error instanceof FeedError) return json({ code: error.code, message: error.message }, 422);
    throw error;
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/feed") return feed(request);
    return new Response("not found", { status: 404 });
  },
};
