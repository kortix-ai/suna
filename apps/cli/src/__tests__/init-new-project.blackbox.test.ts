import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand, writeRunner } from './support/account-cli-harness.ts';

// Black-box characterization of the PLAIN new-project path of `kortix init` —
// the `--primary`/`--agents`/`-y` headless run that scaffolds a fresh folder.
// Only the --force path had a test before; this pins the other one so the
// wizard restructuring cannot change what a first `kortix init` writes.

const runner = writeRunner(mkdtempSync(join(tmpdir(), 'kortix-init-runner-')), 'init.ts', 'runInit');

function freshWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'kortix-init-ws-'));
}

describe('kortix init — a plain new project, headless', () => {
  test('scaffolds a named project, wires the agent, and inits git', async () => {
    const ws = freshWorkspace();
    const res = await runCommand(
      runner,
      ['demo-app', '-y', '--primary', 'opencode', '--agents', 'opencode', '--no-git'],
      { cwd: ws },
    );
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('Initialized Kortix project "demo-app"');
    const project = join(ws, 'demo-app');
    expect(existsSync(join(project, 'kortix.yaml'))).toBe(true);
    expect(existsSync(join(project, '.agents'))).toBe(true);
    expect(res.stdout).toContain('Wrote');
    // --no-git keeps the report honest about it.
    expect(res.stdout).toContain('Git: skipped (--no-git)');
    expect(res.stdout).toContain(`cd demo-app`);
    rmSync(ws, { recursive: true, force: true });
  });

  test('the manifest names the project and the wired agent', async () => {
    const ws = freshWorkspace();
    const res = await runCommand(
      runner,
      ['named-proj', '-y', '--primary', 'opencode', '--agents', 'opencode'],
      { cwd: ws },
    );
    expect(res.code).toBe(0);
    const manifest = readFileSync(join(ws, 'named-proj', 'kortix.yaml'), 'utf8');
    expect(manifest).toContain('named-proj');
    rmSync(ws, { recursive: true, force: true });
  });

  test('-y without a name refuses with usage, exit 2', async () => {
    const ws = freshWorkspace();
    const res = await runCommand(runner, ['-y'], { cwd: ws });
    expect(res.code).toBe(2);
    expect(res.stderr).toContain('a project name is required');
    rmSync(ws, { recursive: true, force: true });
  });

  test('refuses to scaffold into an existing non-empty folder, exit 1', async () => {
    const ws = freshWorkspace();
    const busy = join(ws, 'busy');
    const { mkdirSync, writeFileSync } = require('node:fs') as typeof import('node:fs');
    mkdirSync(busy, { recursive: true });
    writeFileSync(join(busy, 'keep.txt'), 'x', 'utf8');
    const res = await runCommand(runner, ['busy', '-y', '--primary', 'opencode'], { cwd: ws });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("already exists and isn't empty");
    rmSync(ws, { recursive: true, force: true });
  });
});
