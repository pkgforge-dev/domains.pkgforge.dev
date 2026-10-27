import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseArgs } from './args.mjs';

test('reads positionals, bare flags, `--key value` and `--key=value`', () => {
  assert.deepEqual(parseArgs(['dir', '--check', '--name', 'bindings', '--out=a=b', 'tail']), {
    _: ['dir', 'tail'],
    check: true,
    name: 'bindings',
    out: 'a=b',
  });
});

test('a flag followed by another flag is a bare flag, not its value', () => {
  assert.deepEqual(parseArgs(['--json', '--all']), { _: [], json: true, all: true });
});
