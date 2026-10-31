import { expect, test } from 'bun:test';
import { resolve } from 'node:path';

// Exercise the actual npm artifact pipeline: compiling source alone misses
// collisions between private package root and subpath imports during vendoring.
test('the publishable UI artifact builds and its Node entry points load', async () => {
  const process = Bun.spawn(['node', 'scripts/build.mjs'], {
    cwd: resolve(import.meta.dir, '..'),
    env: { ...Bun.env, NODE_OPTIONS: '--max-old-space-size=8192' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ]);
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: '' });
  expect(stdout).toContain('export targets present');
}, 300_000);
