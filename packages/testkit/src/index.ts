// @domains/testkit: the two harnesses of the Worker tests.
//   withWorker   runs a Worker in workerd (Miniflare) and disposes it after
//   world        a GHCR stand-in behind a mock fetch and a Cache API stub with a clock, in Node
// Miniflare and esbuild load only when withWorker runs, so a test that uses
// world alone never starts them.
export type { BodyTrack, CacheEntry, Clock, Ctx, LayerSpec, World, WorldOptions, WorkerModule } from "./world.ts";
export { BLOB_HOST, CacheStub, digest, HOST, hex, inWorld, MANIFEST_TYPE, manifestJson, REGISTRY, sha256hex, T0, world } from "./world.ts";
export type { Outbound, RunningWorker, WorkerOptions } from "./workerd.ts";
export { bundle, COMPATIBILITY_DATE, COMPATIBILITY_FLAGS, ORIGIN, withWorker } from "./workerd.ts";
