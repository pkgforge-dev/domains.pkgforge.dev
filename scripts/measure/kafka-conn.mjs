// scripts/measure/kafka-conn.mjs — the TCP reach of the broker's candidate
// ports, then a TLS handshake on 9091, each bounded by a timeout.
//
// Copied from docs/research/2026-10-27-design-a/scripts/kafka-conn.mjs. What
// changed: the reach is the shared client's (kafka-client.mjs), every port has
// the same timeout, and no address of either end is printed.
//
// Usage: node scripts/measure/kafka-conn.mjs [--host H] [--ports 9091,9092,9093,443]
//        [--tls-port 9091] [--timeout-ms 10000]
// One JSON line per port, then one for the TLS handshake.
// Exit codes: 0 every reach was tried (open or not), 2 bad arguments.
import { reach } from './kafka-client.mjs';
import { commonArgs, intArg, isMain, run, UsageError } from './kafka-cli.mjs';

export const DEFAULT_PORTS = [9091, 9092, 9093, 443];

export function parsePorts(value) {
  if (value === undefined) return DEFAULT_PORTS;
  if (typeof value !== 'string') throw new UsageError('--ports needs a comma-separated list');
  return value.split(',').map((p) => intArg(p.trim(), '--ports', 1));
}

async function main(argv) {
  const { args, host } = commonArgs(argv);
  const ports = parsePorts(args.ports);
  const tlsPort = args['tls-port'] === undefined ? 9091 : intArg(args['tls-port'], '--tls-port', 1);
  const timeoutMs = args['timeout-ms'] === undefined ? 10e3 : intArg(args['timeout-ms'], '--timeout-ms', 1);
  for (const port of ports) console.log(JSON.stringify(await reach(host, port, timeoutMs)));
  console.log(JSON.stringify(await reach(host, tlsPort, timeoutMs, { useTls: true })));
  return 0;
}

if (isMain(import.meta.url)) await run('kafka-conn', main);
