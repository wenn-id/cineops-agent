import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

test('validate script passes on a clean checkout', async () => {
  const { stdout } = await run(process.execPath, ['scripts/validate.mjs']);
  assert.match(stdout, /Validated/);
});
