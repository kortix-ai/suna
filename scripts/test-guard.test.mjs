// scripts/test-guard.mjs: a Mac refuses a whole package suite; CI, Linux,
// targeted runs and KORTIX_FULL_TEST=1 always pass through.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { refuses } from './test-guard.mjs';

const guard = fileURLToPath(new URL('./test-guard.mjs', import.meta.url));

test('a Mac with no target refuses', () => {
  assert.equal(refuses([], 'darwin', {}), true);
  assert.equal(refuses(['--bail'], 'darwin', {}), true);
});

test('a file, a name filter or -t targets the run', () => {
  assert.equal(refuses(['src/a.test.ts'], 'darwin', {}), false);
  assert.equal(refuses(['--bail', 'session'], 'darwin', {}), false);
  assert.equal(refuses(['-t', 'x'], 'darwin', {}), false);
  assert.equal(refuses(['--test-name-pattern=x'], 'darwin', {}), false);
});

test('CI, Linux and the override run the whole suite', () => {
  assert.equal(refuses([], 'darwin', { CI: '1' }), false);
  assert.equal(refuses([], 'darwin', { CI: 'true' }), false);
  assert.equal(refuses([], 'darwin', { CI: 'false' }), true);
  assert.equal(refuses([], 'linux', {}), false);
  assert.equal(refuses([], 'darwin', { KORTIX_FULL_TEST: '1' }), false);
});

test('the guard execs the command with the appended args unchanged', () => {
  const env = { ...process.env, CI: '', KORTIX_FULL_TEST: '', npm_package_name: 'demo' };
  const refused = spawnSync('node', [guard, 'echo ran'], { env: { ...env, KORTIX_TEST_GUARD_PLATFORM: 'darwin' }, encoding: 'utf8' });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /refused: whole demo suite on a Mac; pass the test file\(s\): pnpm --filter demo test <file>/);
  const linux = spawnSync('node', [guard, 'echo ran'], { env: { ...env, KORTIX_TEST_GUARD_PLATFORM: 'linux' }, encoding: 'utf8' });
  assert.equal(linux.stdout, 'ran\n');
  const ran = spawnSync('node', [guard, 'echo "$X" && echo ran', 'a b', '-t'], { env: { ...env, X: 'x', KORTIX_TEST_GUARD_PLATFORM: 'darwin' }, encoding: 'utf8' });
  assert.equal(ran.status, 0);
  assert.equal(ran.stdout, 'x\nran a b -t\n');
  const failed = spawnSync('node', [guard, 'f() { exit 3; }; f', 'f.test.ts'], { env, encoding: 'utf8' });
  assert.equal(failed.status, 3);
});
