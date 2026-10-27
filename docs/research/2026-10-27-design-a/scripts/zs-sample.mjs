// Sample OpenINTEL Zonestream topics; args: outdir seconds
import fs from 'node:fs';
const [outdir, secs] = [process.argv[2], Number(process.argv[3] || 600)];
const topics = ['newly_registered_domain', 'newly_registered_fqdn', 'zone_diff'];
for (const t of topics) {
  const out = fs.createWriteStream(`${outdir}/${t}.ndjson`);
  const stat = { opened: null, n: 0, closed: null, errs: [] };
  const connect = () => {
    const ws = new WebSocket(`wss://zonestream.openintel.nl/ws/${t}`);
    ws.onopen = () => { stat.opened ??= new Date().toISOString(); };
    ws.onmessage = (e) => { stat.n++; out.write(JSON.stringify({ rx: Date.now(), m: String(e.data) }) + '\n'); };
    ws.onerror = (e) => { stat.errs.push(String(e.message || e.type)); };
    ws.onclose = (e) => { stat.closed = new Date().toISOString(); stat.code = e.code; if (Date.now() < end) setTimeout(connect, 2000); };
    return ws;
  };
  var end = Date.now() + secs * 1000;
  connect();
  setTimeout(() => { out.end(); fs.writeFileSync(`${outdir}/${t}.stat.json`, JSON.stringify({ ...stat, secs })); }, secs * 1000);
}
setTimeout(() => process.exit(0), secs * 1000 + 3000);
