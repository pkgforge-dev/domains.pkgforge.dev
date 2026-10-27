const url = process.argv[2]; const secs = +process.argv[3] || 15;
const t0 = Date.now(); let n = 0, first = '';
const ws = new WebSocket(url);
ws.onopen = () => console.log(url, 'open', Date.now() - t0, 'ms');
ws.onmessage = (e) => { n++; if (!first) first = String(e.data).slice(0, 200); };
ws.onerror = (e) => console.log(url, 'error', e.message || e.type);
ws.onclose = (e) => console.log(url, 'close', e.code);
setTimeout(() => { console.log(url, 'messages', n, 'first', first); process.exit(0); }, secs * 1000);
