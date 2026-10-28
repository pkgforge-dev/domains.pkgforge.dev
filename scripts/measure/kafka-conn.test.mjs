// scripts/measure/kafka-conn.mjs: one line per port, open or closed, then the
// TLS handshake, which fails against a plain listener; no address is printed.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { closedPort, FakeBroker, runCli } from './fixtures/kafka/broker.mjs';
import { DEFAULT_PORTS, parsePorts } from './kafka-conn.mjs';

const brokers = [];
after(async () => {
  for (const b of brokers) await b.stop();
});

test('kafka-conn reports each port and the TLS handshake as JSON lines', async () => {
  const b = new FakeBroker({});
  await b.start();
  brokers.push(b);
  const shut = await closedPort();
  const run = await runCli('scripts/measure/kafka-conn.mjs', ['--host', '127.0.0.1', '--ports', `${b.port},${shut}`, '--tls-port', String(b.port), '--timeout-ms', '3000']);
  assert.equal(run.code, 0, run.stderr);
  const lines = run.stdout
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.deepEqual([lines[0].port, lines[0].ok], [b.port, true]);
  assert.deepEqual([lines[1].port, lines[1].ok, lines[1].error], [shut, false, 'ECONNREFUSED']);
  assert.deepEqual([lines[2].tls, lines[2].ok], [true, false], 'a plain listener does not finish a TLS handshake');
  assert.equal(/address/i.test(run.stdout), false);
});

test('kafka-conn reads its port list and refuses a bad one', async () => {
  assert.deepEqual(parsePorts(undefined), DEFAULT_PORTS);
  assert.deepEqual(parsePorts('1, 2'), [1, 2]);
  assert.equal((await runCli('scripts/measure/kafka-conn.mjs', ['--ports', 'a,b'])).code, 2);
});
