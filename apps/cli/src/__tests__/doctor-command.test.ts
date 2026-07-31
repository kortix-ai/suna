import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';

const CLI_ENTRY = join(import.meta.dir, '..', 'index.ts');

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(['bun', 'run', CLI_ENTRY, ...args], {
    env: {
      ...process.env,
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      KORTIX_CONFIG_FILE: join(import.meta.dir, 'no-such-config.json'),
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe('kortix doctor is a reachable command', () => {
  test('is not reported as an unknown command', async () => {
    const { stdout, stderr } = await runCli(['doctor', '--help']);
    expect(`${stdout}${stderr}`).not.toContain('unknown command');
  });

  test('prints its own help', async () => {
    const { code, stdout } = await runCli(['doctor', '--help']);
    expect(code).toBe(0);
    expect(stdout).toContain('kortix doctor');
    expect(stdout).toContain('--no-session');
  });

  test('is advertised in the top-level help', async () => {
    const { stdout } = await runCli(['--help']);
    expect(stdout).toContain('doctor');
  });
});
