// Minimal Public Suffix List matcher (ICANN section and the full list).
import fs from 'node:fs';

export function loadPsl(path) {
  const txt = fs.readFileSync(path, 'utf8').split(/\r?\n/);
  const mk = () => ({ rules: new Set(), wild: new Set(), exc: new Set() });
  const icann = mk();
  const all = mk();
  let section = '';
  for (const raw of txt) {
    const line = raw.trim();
    if (line.startsWith('// ===BEGIN ICANN')) { section = 'icann'; continue; }
    if (line.startsWith('// ===END ICANN')) { section = ''; continue; }
    if (line.startsWith('// ===BEGIN PRIVATE')) { section = 'private'; continue; }
    if (line.startsWith('// ===END PRIVATE')) { section = ''; continue; }
    if (!line || line.startsWith('//')) continue;
    const rule = line.split(/\s+/)[0];
    const targets = section === 'icann' ? [icann, all] : [all];
    for (const t of targets) {
      if (rule.startsWith('!')) t.exc.add(rule.slice(1));
      else if (rule.startsWith('*.')) t.wild.add(rule.slice(2));
      else t.rules.add(rule);
    }
  }
  return { icann, all };
}

// returns number of labels in the public suffix of `labels`
function suffixLabels(set, labels) {
  const n = labels.length;
  let best = 1; // default rule '*'
  for (let i = 0; i < n; i++) {
    const s = labels.slice(i).join('.');
    if (set.exc.has(s)) return n - i - 1;
    if (set.rules.has(s)) { if (n - i > best) best = n - i; }
    if (i + 1 < n && set.wild.has(labels.slice(i + 1).join('.'))) { if (n - i > best) best = n - i; }
  }
  return best;
}

// returns {suffix, reg} for a lowercase ASCII name; reg is null when the name is itself a suffix
export function split(set, name) {
  const labels = name.split('.');
  const k = suffixLabels(set, labels);
  const suffix = labels.slice(-k).join('.');
  const reg = labels.length > k ? labels.slice(-(k + 1)).join('.') : null;
  return { suffix, reg };
}
