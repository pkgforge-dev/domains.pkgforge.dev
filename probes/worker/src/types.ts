// probes/worker/src/types.ts — the Worker types the probe uses, declared here so
// the code typechecks with or without @cloudflare/workers-types. Each interface
// names only the members the probe calls; the runtime objects carry more, and the
// runtime's R2Bucket, ScheduledController and ExecutionContext satisfy these.
//
// Types only: every import of this file is `import type`, so Node's type
// stripping (the tests) and the Worker bundle load nothing from it.

// An object as R2 returns it from put and list.
export interface ProbeObject {
  readonly key: string;
  readonly size: number;
  readonly uploaded: Date;
  // Present on a listed object only when the list asked for it with include.
  readonly customMetadata?: Record<string, string>;
}

export interface ProbeListOptions {
  prefix?: string;
  cursor?: string;
  // Exclusive: the listing starts at the first key after this one.
  startAfter?: string;
  // R2 answers at most 1,000 objects a call, and fewer when include asks for metadata.
  limit?: number;
  include?: ("httpMetadata" | "customMetadata")[];
}

export interface ProbeObjects {
  readonly objects: ProbeObject[];
  readonly truncated: boolean;
  // Present when truncated is true: the position of the next page.
  readonly cursor?: string;
}

export interface ProbePutOptions {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

// The R2 bucket binding, reduced to the two calls the probe makes. Every put is
// a class A operation and every list is a class A operation (R2 pricing).
export interface ProbeBucket {
  put(key: string, value: string | ArrayBuffer | ArrayBufferView, options?: ProbePutOptions): Promise<ProbeObject | null>;
  list(options?: ProbeListOptions): Promise<ProbeObjects>;
}

// The bindings of wrangler.toml.
export interface Env {
  readonly PROBE: ProbeBucket;
}

// The scheduled controller of a cron invocation. scheduledTime is the slot the
// cron fired for, in milliseconds since the epoch; cron is the trigger string
// exactly as wrangler.toml writes it.
export interface CronController {
  readonly cron: string;
  readonly scheduledTime: number;
}

export interface ProbeContext {
  waitUntil(promise: Promise<unknown>): void;
}
