// apps/api/src/context.ts — what a route handler gets for one request.
import type { GhcrReader } from "@domains/ghcr";
import type { ApiCache } from "./cache.ts";

// The Worker's bindings: plain variables only. The Worker holds no secret.
export interface Env {
  // The commit the deploy names with --var BUILD:<12 hex>; /healthz's version.
  BUILD?: string;
}

// The part of the Workers ExecutionContext this Worker uses.
export interface WaitContext {
  waitUntil(p: Promise<unknown>): void;
}

export interface RequestContext {
  readonly env: Env;
  readonly g: GhcrReader;
  readonly cache: ApiCache;
  // The request's id in the log: its cf-ray, or `-` where there is none.
  readonly ray: string;
  readonly now: () => number;
  // console.error with the Worker's name and the request's id: a 5xx, a cache
  // failure or a stale root, nothing else.
  readonly log: (message: string) => void;
}
