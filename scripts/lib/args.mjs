// scripts/lib/args.mjs — `--flag`, `--key value`, `--key=value` and positionals.
// A key given twice keeps its last value, and repeatedFlag names it, so a
// script that takes one value a flag can refuse the repeat instead of
// dropping the first without a word. The list sits under a symbol that is
// not enumerable: no flag can be it, and a listing of the keys never shows it.
const REPEATED = Symbol('repeated');

export function parseArgs(argv) {
  const out = { _: [] };
  const repeated = [];
  Object.defineProperty(out, REPEATED, { value: repeated, enumerable: false });
  const set = (k, v) => {
    if (k !== '_' && Object.hasOwn(out, k) && !repeated.includes(k)) repeated.push(k);
    out[k] = v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      set(a.slice(2, eq), a.slice(eq + 1));
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      set(a.slice(2), argv[++i]);
    } else {
      set(a.slice(2), true);
    }
  }
  return out;
}

// The first flag of parseArgs's result given twice, or null.
export const repeatedFlag = (args) => args[REPEATED]?.[0] ?? null;
