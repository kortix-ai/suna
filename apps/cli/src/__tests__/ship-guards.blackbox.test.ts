import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runCommand, writeConfig, writeRunner } from './support/account-cli-harness.ts';

// Black-box characterization of runShip's guard chain — the part the split of
// ship.ts must not disturb: project guard → git guard → host/auth resolution →
// manifest verification. Each run is a real `bun` process (the account-cli
// harness) with a throwaway folder and config. Every case stops before any
// network call, so the fake API is started but never asserted on.

const runner = writeRunner(mkdtempSync(join(tmpdir(), 'kortix-ship-guards-')), 'ship.ts', 'runShip');

function makeProject(kind: 'plain' | 'git' | 'kortix-git'): string {
  const dir = mkdtempSync(join(tmpdir(), 'kortix-ship-dir-'));
  if (kind !== 'plain') mkdirSync(join(dir, '.kortix'), { recursive: true });
  if (kind === 'kortix-git') {
    writeFileSync(
      join(dir, 'kortix.yaml'),
      'project:\n  name: ship-guards\nagents: []\n',
      'utf8',
    );
    const git = Bun.spawnSync(['git', 'init', '-q'], { cwd: dir });
    if (!git.success) throw new Error(`git init failed: ${git.stderr}`);
  }
  return dir;
}

describe('runShip guards, black-box', () => {
  test('no .kortix/ and no kortix.yaml: exit 1, names the fix', async () => {
    const dir = makeProject('plain');
    const res = await runCommand(runner, [], { cwd: dir });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Not a Kortix project');
    expect(res.stderr).toContain('kortix init');
    rmSync(dir, { recursive: true, force: true });
  });

  test('a Kortix project outside a git repo: exit 1, names the fix', async () => {
    const dir = makeProject('git');
    const res = await runCommand(runner, [], { cwd: dir });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Not inside a git repository.');
    rmSync(dir, { recursive: true, force: true });
  });

  test('--host with an unconfigured host: exit 1 before any network call', async () => {
    const dir = makeProject('kortix-git');
    const config = writeConfig(mkdtempSync(join(tmpdir(), 'kortix-ship-cfg-')), 'http://127.0.0.1:9');
    const res = await runCommand(runner, ['--host', 'no-such-host'], { cwd: dir, configFile: config });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('Host "no-such-host" is not logged in.');
    rmSync(dir, { recursive: true, force: true });
  });

  test('past the guards, a broken manifest fails before any network call', async () => {
    // Auth resolution succeeded (config host test is logged in), so the flow
    // reaches the manifest "compile" check — which rejects a YAML syntax error
    // without touching the API.
    const dir = makeProject('kortix-git');
    writeFileSync(join(dir, 'kortix.yaml'), 'project: [unclosed\n', 'utf8');
    const config = writeConfig(mkdtempSync(join(tmpdir(), 'kortix-ship-cfg-')), 'http://127.0.0.1:9');
    const res = await runCommand(runner, [], { cwd: dir, configFile: config });
    expect(res.code).toBe(1);
    expect(res.stderr).toContain("kortix.yaml doesn't parse");
    rmSync(dir, { recursive: true, force: true });
  });
});
