// scripts/lib/test-counter.mjs — a node:test reporter that records which tests
// actually ran, for `scripts/test.mjs`. node --test reports a file whose tests
// were all filtered out by --test-name-pattern as one passing test named after
// the file, so a filter that matches nothing still "passes"; this reporter
// leaves those file-level entries out, so a caller can tell zero from some.
export default async function* testCounter(source) {
  const ran = [];
  for await (const event of source) {
    if ((event.type !== 'test:pass' && event.type !== 'test:fail') || event.data.details?.type === 'suite') continue;
    const name = String(event.data.name).replace(/\\/g, '/');
    const file = String(event.data.file ?? '').replace(/\\/g, '/');
    if (file && file.endsWith(name)) continue;
    ran.push({ name: event.data.name, ok: event.type === 'test:pass' });
  }
  yield `${JSON.stringify({ ran })}\n`;
}
