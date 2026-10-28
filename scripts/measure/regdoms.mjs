// scripts/measure/regdoms.mjs — registrable domains, sites and suffixes of a
// sorted record file, after design B's regdoms.mjs
// (docs/research/2026-10-27-design-b/scripts/regdoms.mjs), for the THC day
// measurement (DOM-009).
//
// The registrable domain (`reg`) comes from the ICANN section of the list and
// the site from both sections, as design A M5 counted them. Records arrive in
// key order, so most keys fall under the registrable domain of the key before
// them: psl.mjs regKeyCached reuses it whenever no rule lies under it, and the
// list is walked only for the others.
//
// Distinct registrable domains are counted by hashing each name's domain (h53
// of f64cmp.mjs) into one array and sorting it; the runs of the sorted array are
// the names a domain holds, which groups.mjs turns into a histogram. A key the
// sort order puts between two names of one domain (`com.example-x` sorts between
// `com.example` and `com.example.www`, because `-` is below `.`) splits a run of
// keys but not a run of hashes, so the count stays exact up to hash collisions
// (about n^2 / 2^54 for n domains: 0.05 for 30 million).
//
// Usage:
//   import { createSplitter } from './regdoms.mjs'
//   node scripts/measure/regdoms.mjs --psl FILE --input SORTED.tsv [--json OUT]   prints the counts as JSON
// Exit codes: 0 counted, 1 the input is not a sorted record file, 2 could not run.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { createF64, h53, sampleLimit, sortUnique } from './f64cmp.mjs';
import { loadPsl, regKeyCached } from './psl.mjs';
import { RecordError, readRecords, reverseName } from './revlabel.mjs';

// The suffixes design A M5 reported one by one.
export const SELECTED_SUFFIXES = ['com', 'net', 'org', 'com.np', 'np', 'co.uk', 'ru', 'de', 'cn', 'xyz', 'top', 'shop', 'online', 'app', 'dev', 'se', 'ch', 'fr', 'nu', 'sk', 'ee', 'li'];
// A run of at least this many names keeps its domain's text, so the largest
// domains of groups.mjs can be named; every other domain is a hash only.
export const NAMED_RUN = 1000;

// True when the first label of a key (its top-level label) is all digits. No
// delegated TLD is, so such a name is an address literal such as `192.0.2.1`
// that a certificate carried: it passes the charset of section 3.1 and is
// counted here, not refused.
export function allDigitsTld(key) {
  let i = 0;
  for (; i < key.length; i++) {
    const c = key.charCodeAt(i);
    if (c === 46) break;
    if (c < 48 || c > 57) return false;
  }
  return i > 0;
}

// add(key, flags) takes the records in key order. finish() returns the counts,
// the sorted per-name domain hashes (for groups.mjs), the domain texts of long
// runs, and the sampled hashes of the names and the domains (1 in 2^sampleBits,
// for thc-union.mjs).
export function createSplitter(psl, { capacity = 1 << 20, sampleBits = 0 } = {}) {
  const limit = sampleLimit(sampleBits);
  const regOf = regKeyCached(psl.icann);
  const siteOf = regKeyCached(psl.all);
  const regPerName = createF64(capacity);
  const sites = createF64(Math.max(16, capacity >>> 2));
  const nameSample = createF64(Math.max(16, Math.ceil(capacity / 2 ** sampleBits) * 1.1));
  const named = new Map();
  const suffixNames = new Map();
  const tlds = new Set();
  let names = 0;
  let nameBytes = 0;
  let plain = 0;
  let wildcard = 0;
  let both = 0;
  let suffixItself = 0;
  let numericTld = 0;
  let reg = null;
  let regHash = 0;
  let run = 0;
  let site = null;
  const closeRun = () => {
    if (reg === null) return;
    const dot = reg.lastIndexOf('.');
    const suffix = reg.slice(0, dot);
    suffixNames.set(suffix, (suffixNames.get(suffix) ?? 0) + run);
    if (run >= NAMED_RUN) named.set(regHash, reverseName(reg));
  };
  return {
    add(key, flags) {
      names += 1;
      nameBytes += key.length;
      if (flags === 1) plain += 1;
      else if (flags === 2) wildcard += 1;
      else both += 1;
      const h = h53(key);
      if (h < limit) nameSample.push(h);
      if (allDigitsTld(key)) numericTld += 1;
      const r = regOf(key);
      if (r === null) {
        suffixItself += 1;
        const dot = key.indexOf('.');
        tlds.add(dot === -1 ? key : key.slice(0, dot));
      } else {
        if (r !== reg) {
          closeRun();
          reg = r;
          regHash = h53(r);
          run = 0;
          tlds.add(r.slice(0, r.indexOf('.')));
        }
        run += 1;
        regPerName.push(regHash);
      }
      const s = siteOf(key);
      if (s !== null && s !== site) {
        site = s;
        sites.push(h53(s));
      }
    },
    finish() {
      closeRun();
      reg = null;
      const sortedRegs = regPerName.array().sort();
      let distinctRegs = 0;
      const regSample = createF64(1 << 10);
      for (let i = 0; i < sortedRegs.length; i++) {
        if (i > 0 && sortedRegs[i] === sortedRegs[i - 1]) continue;
        distinctRegs += 1;
        if (sortedRegs[i] < limit) regSample.push(sortedRegs[i]);
      }
      const bySuffix = [...suffixNames.entries()].map(([k, n]) => [reverseName(k), n]);
      const suffixCount = new Map(bySuffix);
      return {
        names,
        avg_name_bytes: names === 0 ? 0 : +(nameBytes / names).toFixed(2),
        flags: { plain, wildcard, both },
        names_that_are_a_suffix: suffixItself,
        names_with_an_all_digit_tld: numericTld,
        distinct_registrable_icann: distinctRegs,
        distinct_sites_full_psl: sortUnique(sites.array()).length,
        tlds: tlds.size,
        tlds_all_digits: [...tlds].filter((t) => allDigitsTld(t)).length,
        top_suffixes: bySuffix.sort((a, b) => b[1] - a[1]).slice(0, 40),
        suffix_counts_selected: Object.fromEntries(SELECTED_SUFFIXES.map((s) => [s, suffixCount.get(s) ?? 0])),
        sortedRegs,
        named,
        nameSample: sortUnique(nameSample.array()),
        regSample: regSample.array(),
      };
    },
  };
}

async function main(argv) {
  const args = parseArgs(argv);
  if (typeof args.psl !== 'string' || typeof args.input !== 'string') {
    console.error('usage: node scripts/measure/regdoms.mjs --psl FILE --input SORTED.tsv [--json OUT]');
    return 2;
  }
  let psl;
  try {
    psl = loadPsl(args.psl);
  } catch (err) {
    console.error(`regdoms: ${err.message}`);
    return 2;
  }
  const splitter = createSplitter(psl);
  try {
    await readRecords(args.input, (key, flags) => splitter.add(key, flags));
  } catch (err) {
    console.error(`regdoms: ${err.message}`);
    return err instanceof RecordError ? 1 : 2;
  }
  const { sortedRegs, named, nameSample, regSample, ...counts } = splitter.finish();
  const out = { input: args.input, psl_sha256: psl.sha256, ...counts };
  if (typeof args.json === 'string') writeFileSync(args.json, JSON.stringify(out, null, 1) + '\n');
  console.log(JSON.stringify(out));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2));
