// scripts/lib/line.mjs — one line of output from text a script did not write
// (an adapter's fault detail, a remote body, a proposal's text). Each control
// character, and the two Unicode line and paragraph separators, is written as
// an escape (\n, \r, \t, \u001b), so the text stays on its line and no part of
// it starts a line of its own: a line that starts `::` is a workflow command
// to the Actions runner (::error::, ::add-mask::, ::stop-commands::).
const SEPARATORS = String.fromCharCode(0x2028, 0x2029);
const CONTROL = new RegExp(`[\\u0000-\\u001f\\u007f${SEPARATORS}]`, 'g');
const NAMED = Object.freeze({ '\n': '\\n', '\r': '\\r', '\t': '\\t' });
const escapeOf = (c) => NAMED[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;

export function oneLine(text) {
  return String(text).replace(CONTROL, escapeOf);
}
