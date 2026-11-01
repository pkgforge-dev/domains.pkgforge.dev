// DOM-026 instrument, copied from .tmp/dom026/clientid.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// Read-only: does the broker accept the contact User-Agent as a Kafka client id?
// ApiVersions v0 and ListOffsets v1 (latest) of one NRD topic, over the repository's client.
import { KafkaClient } from '../../../../scripts/measure/kafka-client.mjs';
import { LATEST } from '../../../../scripts/measure/kafka-protocol.mjs';
import { USER_AGENT } from '../../../../scripts/lib/user-agent.mjs';
const client = await KafkaClient.connect({ clientId: USER_AGENT });
try {
  const apis = await client.apiVersions();
  const lo = await client.listOffsets([{ topic: 'newly_registered_domain', partitions: [{ partition: 0, timestamp: LATEST }] }]);
  console.log('client id', JSON.stringify(USER_AGENT), 'bytes', Buffer.byteLength(USER_AGENT));
  console.log('ApiVersions apis', apis.size, '| ListOffsets latest', lo[0].partitions[0].offset);
} finally { client.close(); }
