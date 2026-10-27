import tls from 'node:tls'; import net from 'node:net';
const host='kafka.zonestream.openintel.nl';
for (const port of [9091, 9092, 9093, 443]) {
  await new Promise((res) => {
    const t0 = Date.now();
    const s = net.connect({ host, port, timeout: 8000 });
    s.on('connect', () => { console.log(port, 'tcp connect ok', Date.now() - t0, 'ms', s.remoteAddress); s.end(); res(); });
    s.on('timeout', () => { console.log(port, 'tcp timeout'); s.destroy(); res(); });
    s.on('error', (e) => { console.log(port, 'tcp error', e.code); res(); });
  });
}
const s = tls.connect({ host, port: 9091, servername: host, timeout: 10000 }, () => {
  console.log('tls ok', s.getProtocol(), s.authorized, s.authorizationError, JSON.stringify(s.getPeerCertificate().subject), s.getPeerCertificate().valid_to);
  s.end();
});
s.on('error', (e) => console.log('tls error', e.code, e.message));
s.on('timeout', () => { console.log('tls timeout'); s.destroy(); });
setTimeout(() => process.exit(0), 12000);
