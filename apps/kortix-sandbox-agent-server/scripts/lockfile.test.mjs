import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const daemon = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('the image Bun installs the standalone daemon with its frozen lockfile', { timeout: 90_000 }, () => {
  const expected = JSON.parse(readFileSync(join(daemon, 'package.json'), 'utf8')).engines.bun;
  const bun = process.env.DAEMON_BUN ?? 'bun';
  const args = process.env.DAEMON_BUN ? [] : ['x', `bun@${expected}`];
  const version = spawnSync(bun, [...args, '--version'], { encoding: 'utf8', timeout: 30_000 });
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout.trim(), expected, 'Run with the image Bun via DAEMON_BUN');
  const root = mkdtempSync(join(tmpdir(), 'daemon-lock-'));
  try {
    const cwd = join(root, 'apps/kortix-sandbox-agent-server');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(root, 'patches'));
    for (const name of ['package.json', 'bun.lock']) {
      copyFileSync(join(daemon, name), join(cwd, name));
    }
    const manifest = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
    for (const patch of Object.values(manifest.patchedDependencies)) {
      copyFileSync(resolve(daemon, patch), resolve(cwd, patch));
    }
    const before = readFileSync(join(cwd, 'bun.lock'), 'utf8');
    const run = spawnSync(bun, [...args, 'install', '--frozen-lockfile'], {
      cwd, encoding: 'utf8', timeout: 60_000,
    });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    assert.equal(readFileSync(join(cwd, 'bun.lock'), 'utf8'), before);
    // Scoped overrides must survive the lockfile format upgrade and real install.
    for (const parent of ['eslint', '@eslint/config-array', '@eslint/eslintrc', '@typescript-eslint/typescript-estree', '@earendil-works/pi-coding-agent']) {
      const resolved = spawnSync(bun, [...args, '-e', `const { createRequire } = require('node:module'); const parent = require.resolve('${parent}/package.json'); console.log(createRequire(parent)('minimatch/package.json').version)`], {
        cwd, encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(resolved.status, 0, resolved.stderr);
      assert.equal(resolved.stdout.trim(), '11.0.1', `${parent} must use the scoped minimatch override`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
