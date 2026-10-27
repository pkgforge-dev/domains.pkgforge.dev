import fs from 'node:fs';
// Minimal PSL matcher: returns { suffix, reg } for a lowercase ASCII/punycode hostname.
export function loadPSL(path, { icannOnly = false } = {}) {
  const rules = new Set(), wild = new Set(), exc = new Set();
  let priv = false;
  for (const raw of fs.readFileSync(path, 'utf8').split('\n')) {
    const l = raw.trim();
    if (l.startsWith('// ===BEGIN PRIVATE')) priv = true;
    if (!l || l.startsWith('//')) continue;
    if (icannOnly && priv) continue;
    if (l.startsWith('!')) exc.add(l.slice(1));
    else if (l.startsWith('*.')) wild.add(l.slice(2));
    else rules.add(l);
  }
  return function split(host) {
    const lab = host.split('.');
    let sufLen = 1; // default rule '*'
    for (let i = 0; i < lab.length; i++) {
      const cand = lab.slice(i).join('.');
      const n = lab.length - i;
      if (exc.has(cand)) { sufLen = n - 1; break; }
      if (rules.has(cand)) { sufLen = Math.max(sufLen, n); }
      const parent = lab.slice(i + 1).join('.');
      if (i + 1 < lab.length && wild.has(parent)) sufLen = Math.max(sufLen, n);
    }
    if (lab.length <= sufLen) return { suffix: host, reg: null };
    return { suffix: lab.slice(-sufLen).join('.'), reg: lab.slice(-(sufLen + 1)).join('.') };
  };
}
