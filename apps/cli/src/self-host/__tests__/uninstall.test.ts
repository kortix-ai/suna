import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { confirmsUninstall, uninstallComposeArgs } from '../../commands/self-host.ts';

// `kortix self-host uninstall` — pure-helper + arg-gating coverage only.
// Deliberately does NOT exercise the real teardown path (which shells out to
// `docker compose down --volumes --remove-orphans`): the two scenarios below
// (no config yet / non-interactive without --yes) both return before ever
// touching Docker, which is exactly what keeps this suite fast and
// Docker-optional like its self-host-cli.test.ts sibling.

describe('uninstall pure helpers', () => {
  test('confirmsUninstall requires an exact (trimmed) match of the instance name', () => {
    expect(confirmsUninstall('default', 'default')).toBe(true);
    expect(confirmsUninstall('  default  ', 'default')).toBe(true);
    expect(confirmsUninstall('Default', 'default')).toBe(false);
    expect(confirmsUninstall('', 'default')).toBe(false);
    expect(confirmsUninstall('defaul', 'default')).toBe(false);
  });

  test('uninstallComposeArgs tears down containers, networks, AND named volumes', () => {
    expect(uninstallComposeArgs()).toEqual(['down', '--volumes', '--remove-orphans']);
  });
});

describe('kortix self-host uninstall (CLI arg gating — no Docker invoked)', () => {
  let tmp: string;
  let configRoot: string;
  const CLI_ENTRY = resolve(import.meta.dir, '..', '..', 'index.ts');

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'kortix-self-host-uninstall-'));
    configRoot = join(tmp, 'self-host');
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  async function run(args: string[]) {
    const proc = Bun.spawn({
      cmd: [process.execPath, CLI_ENTRY, 'self-host', ...args],
      cwd: tmp,
      env: {
        ...process.env,
        KORTIX_SELF_HOST_CONFIG_DIR: configRoot,
        KORTIX_CONFIG_FILE: join(tmp, 'cli-config.json'),
        KORTIX_NO_UPDATE_CHECK: '1',
        NO_COLOR: '1',
        FORCE_COLOR: '0',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [code, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { code, stdout, stderr };
  }

  test('an instance with no config at all is a 0-exit no-op', async () => {
    const { code, stdout } = await run(['uninstall', '--instance', 'never-created']);
    expect(code).toBe(0);
    expect(stdout).toContain('nothing to uninstall');
  });

  test('refuses to run non-interactively without --yes, and never touches the instance directory', async () => {
    await run(['init', '--yes']);
    const { code, stderr } = await run(['uninstall']);
    expect(code).toBe(2);
    expect(stderr).toContain('--yes');
    // Confirm nothing was torn down: a plain `env ls` still finds the config.
    const after = await run(['env', 'ls']);
    expect(after.code).toBe(0);
  });

  test('unknown subcommand is still rejected the same way it was before uninstall existed', async () => {
    const { code, stderr } = await run(['bogus-subcommand']);
    expect(code).toBe(2);
    expect(stderr).toContain('unknown subcommand');
  });
});
