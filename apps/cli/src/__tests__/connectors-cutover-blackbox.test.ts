import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');

async function runCli(args: string[]) {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...args],
    cwd: CLI_ROOT,
    env: {
      ...process.env,
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
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

describe('connector and connection terminology cutover', () => {
  test('top-level help exposes one connector command tree and no connector product command', async () => {
    const result = await runCli(['--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('connectors <subcommand>');
    expect(result.stdout).not.toMatch(/^\s*connector\s/m);
  });

  test('the removed connector command is rejected without an active compatibility alias', async () => {
    const result = await runCli(['connector', '--help']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command `connector`');
  });

  test('connectors help owns connector, connection, call, and MCP behavior', async () => {
    const result = await runCli(['connectors', '--help']);
    expect(result.code).toBe(0);
    for (const command of ['ls', 'show', 'discover', 'call', 'connections', 'mcp']) {
      expect(result.stdout).toMatch(new RegExp(`^\\s*${command}(?:\\s|$)`, 'm'));
    }
    expect(result.stdout).not.toMatch(/^\s*(?:link|finalize|describe)\s/m);
  });

  test('connections help exposes the complete connection lifecycle', async () => {
    const result = await runCli(['connectors', 'connections', '--help']);
    expect(result.code).toBe(0);
    for (const command of ['ls', 'add', 'credential', 'revoke', 'activate', 'default']) {
      expect(result.stdout).toMatch(new RegExp(`^\\s*${command}(?:\\s|$)`, 'm'));
    }
    expect(result.stdout).not.toMatch(/\bprofile\b/i);
  });

  test('files help does not expose the removed compare command', async () => {
    const result = await runCli(['files', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).not.toMatch(/^\s*compare\s/m);
  });

  test('agent model help documents a plain model id', async () => {
    const result = await runCli(['agents', '--help']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('model <agent> <model-id>');
    expect(result.stdout).toContain('glm-5.3-flash');
    expect(result.stdout).not.toContain('<provider/model>');
  });
});
