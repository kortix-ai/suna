import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cli = join(import.meta.dir, '../index.ts');

function validate(args: string[]) {
  const cwd = mkdtempSync(join(tmpdir(), 'validate-argv-'));
  try {
    writeFileSync(join(cwd, 'kortix.yaml'), 'invalid: true\n');
    writeFileSync(join(cwd, 'selected.yaml'), 'kortix_version: 1\nproject:\n  name: argv-test\n');
    const env: Record<string, string | undefined> = { ...process.env, NO_COLOR: '1', KORTIX_DISABLE_SANDBOX_ENV_FILE: '1', KORTIX_NO_UPDATE_CHECK: '1', KORTIX_CONFIG_FILE: join(cwd, 'config.json') };
    delete env.KORTIX_TOKEN;
    delete env.KORTIX_SESSION_ID;
    delete env.KORTIX_API_URL;
    return Bun.spawnSync([process.execPath, cli, 'validate', ...args], { cwd, env });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('validate argument grammar', () => {
  test.each(['--jons', 'stray', '--no-dockerfile-lnit'])('rejects %s with usage', (arg) => {
    const result = validate([arg]);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain(`unknown option "${arg}"`);
    expect(result.stderr.toString()).toContain('Usage: kortix validate');
    expect(result.stdout.toString()).toBe('');
  });

  test.each([[['--file']], [['--file', '--json']]])('requires a file value: %j', (args) => {
    const result = validate(args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr.toString()).toContain('--file requires a value');
    expect(result.stderr.toString()).toContain('Usage: kortix validate');
    expect(result.stdout.toString()).toBe('');
  });

  test.each([[['--file', 'selected.yaml']], [['--file=selected.yaml']]])('accepts file syntax: %j', (args) => {
    const result = validate([...args, '--json', '--no-dockerfile-lint']);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toHaveProperty('valid', true);
    expect(result.stderr.toString()).not.toContain('Usage: kortix validate');
  });

  test.each(['--help', '-h'])('prints help for %s', (arg) => {
    const result = validate([arg]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Usage: kortix validate');
    expect(result.stderr.toString()).not.toContain('Usage: kortix validate');
  });

  test('prints scopes without validating a file', () => {
    const result = validate(['--scopes']);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.toString()).toContain('Grantable kortix_permissions');
    expect(result.stderr.toString()).not.toContain('Usage: kortix validate');
  });
});
