import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Regression (KRTX-1262): `hosts --help` documented the built-in dev host as
// http://dev-api.kortix.com while `hosts ls` registers
// https://dev-api.kortix.com (DEFAULT_INTERNAL_DEV_API_BASE in
// @kortix/shared/host-config). Plain http only 308-redirects to https, so the
// help named a URL different from the stored one. The help must name the same
// URL the host registry reports.

const CLI_ENTRY = resolve(import.meta.dir, '..', 'index.ts');

let tmp: string;

async function runCli(args: string[]): Promise<{ code: number; stdout: string }> {
  tmp = mkdtempSync(join(tmpdir(), 'kortix-hosts-help-'));
  const env: Record<string, string | undefined> = {
    ...process.env,
    HOME: tmp,
    KORTIX_CONFIG_FILE: join(tmp, 'config.json'),
    KORTIX_NO_UPDATE_CHECK: '1',
    KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
  };
  for (const key of [
    'KORTIX_API_URL',
    'KORTIX_TOKEN',
    'KORTIX_FRONTEND_URL',
    'KORTIX_PROJECT_ID',
    'BASH_ENV',
  ]) {
    delete env[key];
  }
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: tmp,
    env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const timeout = setTimeout(() => proc.kill(), 30_000);
  try {
    const [code, stdout] = await Promise.all([proc.exited, new Response(proc.stdout).text()]);
    return { code, stdout };
  } finally {
    clearTimeout(timeout);
  }
}

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/** The URL in a built-in host's help line (`name  description (url)`). */
function helpUrlFor(help: string, name: string): string | null {
  const line = help.split('\n').find((l) => l.trimStart().startsWith(`${name} `));
  return line?.match(/\((\S+)\)/)?.[1] ?? null;
}

describe('hosts --help documents built-in hosts with the URL hosts ls registers', () => {
  test('kortix-internal-dev', async () => {
    const [help, ls] = await Promise.all([
      runCli(['hosts', '--help']),
      runCli(['hosts', 'ls', '--json']),
    ]);
    expect(help.code).toBe(0);
    expect(ls.code).toBe(0);
    const helpUrl = helpUrlFor(help.stdout, 'kortix-internal-dev');
    const registered = (JSON.parse(ls.stdout) as Array<{ name: string; url: string }>).find(
      (h) => h.name === 'kortix-internal-dev',
    );
    if (!registered) throw new Error('hosts ls did not report the kortix-internal-dev host');
    expect(helpUrl).toBe(registered.url);
  });
});
