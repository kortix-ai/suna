import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
// Relative: apps/cli does not depend on the contract package. This file is
// import-free, and kortixd bundles the same one.
import { CONNECTORS_MCP_COMMAND } from '../../../../packages/api-contract/src/sandbox-layout';

/**
 * Guards the contract between the sandbox daemon and this CLI.
 *
 * The daemon registers an OpenCode MCP server whose command is an argv array
 * pointing at this binary (`CONNECTORS_MCP_COMMAND`). Nothing type-checks that
 * the argv names a real command.
 *
 * That gap shipped a real outage. Commit e868be1d6c (2026-08-06) renamed the
 * CLI command `executor` -> `connectors` but pointed the daemon at `connector`,
 * singular. The CLI router rejects it with "unknown command", so OpenCode's
 * launcher got exit 2 and the `kortix-connectors` MCP server never started —
 * for six days, with every daemon unit test green, because they were updated
 * to match the typo.
 *
 * So this file asserts behaviour, not spelling: run the argv the daemon
 * registers and require a clean JSON-RPC handshake.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');

function daemonMcpArgv(): string[] {
  return [...CONNECTORS_MCP_COMMAND];
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
      // The hermetic suite's fresh config store — the spawned CLI inherits nothing.
      KORTIX_CONFIG_FILE: process.env.KORTIX_CONFIG_FILE,
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

const TOOLS_LIST = `${JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/list',
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

  test('managed connector tools prefer Composio and gate legacy Pipedream', async () => {
    const result = await runMcp(daemonMcpArgv().slice(1), TOOLS_LIST);
    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout.trim());
    const tools = response.result.tools as Array<any>;
    const add = tools.find((tool) => tool.name === 'add_connector');
    const connect = tools.find((tool) => tool.name === 'connect');
    const finalize = tools.find((tool) => tool.name === 'finalize_connection');
    expect(add.description).toContain('Composio is the default managed provider');
    expect(add.inputSchema.properties.provider.enum[0]).toBe('composio');
    expect(add.inputSchema.properties.provider.enum).toContain('pipedream');
    expect(add.inputSchema.properties.allow_legacy_pipedream.type).toBe('boolean');
    expect(connect.description).toContain('Composio');
    expect(connect.description).not.toContain('Pipedream Quick Connect');
    expect(finalize.description).toContain('persist its account binding');
    expect(finalize.inputSchema.properties.connection_id.type).toBe('string');
    expect(finalize.inputSchema.properties.request_id.type).toBe('string');
  });

  // An account is owned by the project (shared) or by one member (private).
  // The agent must be able to say which one a connect link creates, and must
  // be told the two selector words a call accepts.
  test('the accounts model is on the wire: connect owner + me|project selectors', async () => {
    const result = await runMcp(daemonMcpArgv().slice(1), TOOLS_LIST);
    expect(result.code).toBe(0);
    const tools = JSON.parse(result.stdout.trim()).result.tools as Array<any>;
    const connect = tools.find((tool) => tool.name === 'connect');
    const accounts = tools.find((tool) => tool.name === 'accounts');
    const call = tools.find((tool) => tool.name === 'call');

    expect(connect.inputSchema.properties.owner.enum).toEqual(['me', 'project']);
    expect(connect.inputSchema.properties.owner.description).toContain('the default');
    expect(connect.inputSchema.properties.owner.description).toContain(
      'project.connector.write',
    );
    expect(accounts.description).toContain('`me`');
    expect(accounts.description).toContain('`project`');
    expect(call.inputSchema.properties.account.description).toContain('`me`');
    expect(call.inputSchema.properties.account.description).toContain('`project`');
  });

  test('agent MCP rejects accidental Pipedream selection before any API call', async () => {
    const request = `${JSON.stringify({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'add_connector',
        arguments: { slug: 'gmail', provider: 'pipedream', app: 'gmail' },
      },
    })}\n`;
    const result = await runMcp(daemonMcpArgv().slice(1), request);
    expect(result.code).toBe(0);
    const response = JSON.parse(result.stdout.trim());
    expect(response.result.isError).toBe(true);
    const body = JSON.parse(response.result.content[0].text);
    expect(body.error).toContain('Pipedream is legacy rollback only');
    expect(body.error).toContain('provider="composio"');
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
