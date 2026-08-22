import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';

/**
 * Guards the contract between the sandbox daemon and this CLI.
 *
 * The daemon registers an OpenCode MCP server whose command is an argv array
 * pointing at this binary. Nothing type-checks that pairing: the daemon is a
 * standalone bun package with no workspace dependency on the CLI, and its own
 * unit tests only assert the argv *literal* it just produced.
 *
 * That gap shipped a real outage. Commit e868be1d6c (2026-08-06) renamed the
 * CLI command `executor` -> `connectors` but pointed the daemon at `connector`,
 * singular. The CLI router rejects it with "unknown command", so OpenCode's
 * launcher got exit 2 and the `kortix-connectors` MCP server never started —
 * for six days, with every daemon unit test green, because they were updated
 * to match the typo.
 *
 * So this file asserts behaviour, not spelling: take the argv the daemon
 * actually registers, run it, and require a clean JSON-RPC handshake.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');
const DAEMON_OPENCODE = resolve(
  CLI_ROOT,
  '..',
  'kortix-sandbox-agent-server',
  'src',
  'opencode.ts',
);

/**
 * Read the argv the daemon registers straight out of its source.
 *
 * Deliberately not an import: the daemon is a separate package (hono + zod,
 * no workspace deps) and pulling its module graph into a CLI test would couple
 * their installs. A tolerant regex over one literal is the cheap half of the
 * guard; running the result is the half that matters.
 */
function daemonMcpArgv(): string[] {
  const source = readFileSync(DAEMON_OPENCODE, 'utf8');
  const match = source.match(/command:\s*\[([^\]]*)\]/);
  if (!match) {
    throw new Error(
      `Could not find the MCP \`command:\` array in ${DAEMON_OPENCODE}. ` +
        'If the daemon changed shape, update this guard — do not delete it.',
    );
  }
  return [...match[1].matchAll(/'([^']*)'/g)].map((entry) => entry[1]);
}

async function runMcp(argv: string[], stdin: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, ...argv],
    cwd: CLI_ROOT,
    env: {
      ...process.env,
      // `initialize` and `tools/list` are answered locally, but the server
      // builds its gateway client before the read loop, so it needs a token.
      KORTIX_TOKEN: 'test-token-not-used-offline',
      KORTIX_API_URL: 'https://api.kortix.invalid/v1',
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
      NO_COLOR: '1',
      FORCE_COLOR: '0',
    },
    stdin: new TextEncoder().encode(stdin),
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

const INITIALIZE = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {},
})}\n`;

describe('sandbox daemon -> CLI MCP contract', () => {
  test('the argv the daemon registers names a real command', () => {
    const argv = daemonMcpArgv();
    expect(argv[0]).toBe('/usr/local/bin/kortix');
    // The regression was here: `connector` instead of `connectors`.
    expect(argv.slice(1)).toEqual(['connectors', 'mcp']);
  });

  test('that argv completes an MCP handshake', async () => {
    const argv = daemonMcpArgv().slice(1);
    const result = await runMcp(argv, INITIALIZE);

    expect(result.stderr).not.toContain('unknown command');
    expect(result.code).toBe(0);

    const response = JSON.parse(result.stdout.trim());
    expect(response.result.serverInfo.name).toBe('kortix-connectors');
  });

  test('stdout carries only JSON-RPC — no host banner, no update notice', async () => {
    const result = await runMcp(daemonMcpArgv().slice(1), INITIALIZE);
    const lines = result.stdout.split('\n').filter((entry) => entry.trim());
    // Assert we actually got output first — an empty stdout (a crashed server)
    // would satisfy the per-line check below without proving anything.
    expect(lines).toHaveLength(1);
    // A single stray line of human output corrupts the stream and the MCP
    // client drops the server, so assert the whole channel, not just a prefix.
    for (const line of lines) {
      expect(() => JSON.parse(line) as unknown).not.toThrow();
    }
  });

  test('the singular spelling still fails loudly', async () => {
    // Pinned so a future daemon typo cannot fail silently: if someone points
    // the daemon back at `connector`, the first test catches the string and
    // this one shows what the launcher would have seen.
    const result = await runMcp(['connector', 'mcp'], INITIALIZE);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('unknown command `connector`');
  });
});
