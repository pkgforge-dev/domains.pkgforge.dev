// adapters/oi-nrd/test/broker.ts — the three NRD topics on the fake broker of
// DOM-004's tests (scripts/measure/fixtures/kafka/broker.mjs: real magic-2
// batches with their CRC-32C, on 127.0.0.1), built from the messages a test
// names, and the message values of each topic's shape (DOM-026, design 7.2).
//
//   await withBroker([nrd(at("05:41:00"), "a.com"), ...], {}, async (address, broker) => ...);
//
// Each topic is one partition, codec none, one record a batch, as every read
// of the real topics found (DOM-004). Everything here is synthetic.
import type { SocketAddress } from "@domains/adapter";
import { FakeBroker, makePartition } from "../../../scripts/measure/fixtures/kafka/broker.mjs";

export const DOMAIN = "newly_registered_domain";
export const FQDN = "newly_registered_fqdn";
export const CONFIRMED = "confirmed_newly_registered_domain";
export const TOPIC_NAMES = [DOMAIN, FQDN, CONFIRMED] as const;

// The first offset of each topic: the real topics' magnitudes (design 1.1).
export const BASE: Readonly<Record<string, number>> = Object.freeze({ [DOMAIN]: 173_000_000, [FQDN]: 182_000_000, [CONFIRMED]: 81_000_000 });

export interface Message {
  readonly topic: string;
  // The Kafka record timestamp, in ms.
  readonly recordMs: number;
  // The record's value: JSON text, other bytes, or none.
  readonly value: string | Uint8Array | null;
}

export interface BrokerOptions {
  // Base offsets whose batch has its last byte flipped after its CRC-32C.
  readonly corrupt?: Readonly<Record<string, readonly number[]>>;
  // A topic of more than the one partition 0 (the others hold no record).
  readonly partitions?: Readonly<Record<string, number>>;
  // The first offset of a topic, when not BASE's.
  readonly base?: Readonly<Record<string, number>>;
  // FakeBroker's faults: silentApi, fetchError, chunkSize, ...
  readonly faults?: Readonly<Record<string, unknown>>;
}

const DAY_MS = 86_400_000;

// The ms of a time of 2026-10-31, "HH:MM:SS", or of a full ISO time.
export const at = (time: string): number => Date.parse(time.includes("T") ? time : `2026-10-31T${time}Z`);

// The JSON `timestamp` of a message: OpenINTEL's emission time, about 0.5 s
// before its record time (design 1.2).
const emitted = (recordMs: number): number => Math.floor(recordMs / 1000) - 1;

// A newly_registered_domain message. certAgeS: timestamp minus submission_timestamp.
export function nrd(recordMs: number, name: string, certAgeS = 30.5): Message {
  const timestamp = emitted(recordMs);
  return { topic: DOMAIN, recordMs, value: JSON.stringify({ domain: `${name}.`, cert_index: 7, ct_name: "Synthetic Log 2026", timestamp, submission_timestamp: timestamp - certAgeS }) };
}

// A zone row of newly_registered_domain: no certificate, no submission_timestamp.
export function nrdZone(recordMs: number, name: string): Message {
  return { topic: DOMAIN, recordMs, value: JSON.stringify({ domain: `${name}.`, timestamp: emitted(recordMs), ct_name: "zone_data", cert_index: -1 }) };
}

// A newly_registered_fqdn message, whose name ends in no dot (design 1.2); a
// name may start `*.`.
export function fqdn(recordMs: number, name: string, certAgeS = 30.5): Message {
  const timestamp = emitted(recordMs);
  return { topic: FQDN, recordMs, value: JSON.stringify({ fqdn: name, cert_index: 7, ct_name: "Synthetic Log 2026", timestamp, submission_timestamp: timestamp - certAgeS }) };
}

// A confirmed_newly_registered_domain message: no submission_timestamp.
export function confirmed(recordMs: number, name: string, confidence: number): Message {
  return { topic: CONFIRMED, recordMs, value: JSON.stringify({ domain: `${name}.`, cert_index: 11, confidence, ct_name: "Synthetic Log 2026", timestamp: emitted(recordMs) }) };
}

// A zone row of the confirmed topic, with the confidence it states.
export function confirmedZone(recordMs: number, name: string, confidence: number): Message {
  return { topic: CONFIRMED, recordMs, value: JSON.stringify({ domain: `${name}.`, cert_index: -1, ct_name: "zone_data", timestamp: emitted(recordMs), confidence }) };
}

// A message of any value.
export const raw = (topic: string, recordMs: number, value: string | Uint8Array | null): Message => ({ topic, recordMs, value });

// An age of `days` days and a few seconds, in seconds.
export const days = (n: number): number => (n * DAY_MS) / 1000 + 3.25;

// FakeBroker's topics: each named topic, its messages in the order given at
// offsets from its base.
export function topicsOf(messages: readonly Message[], options: BrokerOptions = {}): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const topic of TOPIC_NAMES) {
    const records = messages.filter((m) => m.topic === topic).map((m) => ({ timestamp: m.recordMs, value: m.value === null ? null : typeof m.value === "string" ? m.value : Buffer.from(m.value) }));
    const baseOffset = options.base?.[topic] ?? BASE[topic]!;
    // makePartition is JS: its default `corrupt = []` types the list as never[].
    const corrupt = [...(options.corrupt?.[topic] ?? [])] as never[];
    const first = makePartition({ baseOffset, records, perBatch: 1, codec: "none", corrupt });
    const others = Array.from({ length: (options.partitions?.[topic] ?? 1) - 1 }, () => makePartition({ baseOffset: 0, records: [], perBatch: 1, codec: "none" }));
    out[topic] = [first, ...others];
  }
  return out;
}

export async function withBroker<T>(messages: readonly Message[], options: BrokerOptions, fn: (address: SocketAddress, broker: FakeBroker) => Promise<T>): Promise<T> {
  const broker = new FakeBroker(topicsOf(messages, options), options.faults ?? {});
  const port = await broker.start();
  try {
    return await fn({ hostname: "127.0.0.1", port }, broker);
  } finally {
    await broker.stop();
  }
}
