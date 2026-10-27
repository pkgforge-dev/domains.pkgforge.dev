// Sample an OpenINTEL Zonestream WebSocket topic for N seconds; write JSON lines to a file.
// Usage: node zonestream_ws_sample.mjs <topic> <seconds> <outfile>
// Needs Node >= 22 (global WebSocket). No key or login.
import { writeFileSync } from 'node:fs';
const [topic, secs, out] = process.argv.slice(2);
const ws = new WebSocket(`wss://zonestream.openintel.nl/ws/${topic}`);
const lines = [];
const t0 = Date.now();
ws.onopen = () => console.error(`open ${topic} ${new Date().toISOString()}`);
ws.onmessage = (e) => lines.push(typeof e.data === 'string' ? e.data : String(e.data));
ws.onerror = (e) => console.error('error', e.message ?? e.type);
setTimeout(() => {
  ws.close();
  writeFileSync(out, lines.join('\n') + '\n');
  console.error(`${topic}: ${lines.length} messages in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  process.exit(0);
}, Number(secs) * 1000);
