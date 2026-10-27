// usage: node zs.mjs <topic> <seconds> <outfile>
const [topic, secs, out] = [process.argv[2], +process.argv[3], process.argv[4]];
import fs from 'node:fs';
const ws = new WebSocket(`wss://zonestream.openintel.nl/ws/${topic}`);
const t0 = Date.now();
const lines = [];
let first = null;
ws.onopen = () => console.error(topic, 'open', Date.now() - t0, 'ms');
ws.onmessage = (e) => { if (first === null) first = Date.now() - t0; lines.push(JSON.stringify({ rx: Date.now(), m: String(e.data) })); };
ws.onerror = (e) => console.error(topic, 'error', e.message || e.type);
ws.onclose = (e) => console.error(topic, 'close', e.code);
setTimeout(() => { try { ws.close(); } catch {} fs.writeFileSync(out, lines.join('\n') + '\n'); console.error(topic, 'messages', lines.length, 'first_ms', first, 'secs', secs); process.exit(0); }, secs * 1000);
