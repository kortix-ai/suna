import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Exercise the real artifact builder, including its private-package vendor guard.
test('the UI npm artifact builds without conflicting private export origins', () => {
  // No NODE_OPTIONS: the build must bring its own heap, as smoke:install and publish call it.
  const { NODE_OPTIONS: _unset, ...env } = process.env;
  const result = spawnSync('node', ['scripts/build.mjs'], {
    cwd: fileURLToPath(new URL('../', import.meta.url)),
    env,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (result.status !== 0) throw new Error(result.error?.message ?? `${result.stdout}\n${result.stderr}`);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('export targets present');
}, 310_000);
