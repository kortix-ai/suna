import { describe, expect, test } from 'bun:test';

/**
 * Characterization of the `connectors mcp` stdio surface, captured BEFORE the
 * KRTX-1341 module split (mcp.ts → catalog + execution + transport).
 *
 * These tests pin the current wire behavior so the split cannot change it:
 * the complete tools/list payload (every record, in order), the initialize
 * handshake, unknown-tool handling, the notifications silence rule and the
 * two transport-level failure codes. After the refactor every assertion must
 * still pass byte for byte.
 */
const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');

import { join, resolve } from 'node:path';

/** Drive the real stdio server: every stdin line, every response line. */
async function runMcp(stdin: string) {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, 'connectors', 'mcp'],
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
  const lines = stdout.split('\n').filter((line) => line.trim());
  return {
    code,
    stderr,
    responses: lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

const rpc = (id: unknown, method: string, params: unknown = {}) =>
  `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;

describe('connectors mcp — tools/list characterization (KRTX-1341)', () => {
  test('initialize answers the fixed protocol version + server identity', async () => {
    const { code, responses } = await runMcp(rpc(1, 'initialize'));
    expect(code).toBe(0);
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        serverInfo: { name: 'kortix-connectors', version: '0.3.0' },
        capabilities: { tools: {} },
      },
    });
  });

  test('a params protocolVersion passes through unchanged', async () => {
    const { responses } = await runMcp(rpc(1, 'initialize', { protocolVersion: '1999-01-01' }));
    const initialize = responses[0]?.result as Record<string, unknown>;
    expect(initialize?.protocolVersion).toBe('1999-01-01');
  });

  test('notifications/initialized answers NOTHING (one line in, zero out)', async () => {
    const { code, responses } = await runMcp(
      rpc(1, 'initialize') + rpc(null, 'notifications/initialized'),
    );
    expect(code).toBe(0);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.id).toBe(1);
  });

  test('tools/list carries every meta-tool, in order, with schemas and readOnly hints', async () => {
    const { responses } = await runMcp(rpc(1, 'initialize') + rpc(2, 'tools/list'));
    expect(responses).toHaveLength(2);
    const result = responses[1]?.result as Record<string, unknown>;
    // Snapshotted from the pre-split implementation. Any intentional catalog
    // change updates this snapshot deliberately; the module split must not.
    expect(result).toMatchSnapshot('tools-list');
  });

  test('an unknown tool call is a tool-level error, not a JSON-RPC error', async () => {
    const { responses } = await runMcp(
      rpc(1, 'initialize') + rpc(2, 'tools/call', { name: 'no_such_tool', arguments: {} }),
    );
    expect(responses).toHaveLength(2);
    const result = responses[1]?.result as {
      isError?: boolean;
      content?: Array<{ text?: string }>;
    };
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content?.[0]?.text ?? 'missing')).toEqual({
      ok: false,
      error: 'unknown tool no_such_tool',
    });
  });

  test('a transport-level parse error is answered NOTHING (writeResponse drops the null id)', async () => {
    const { responses } = await runMcp(`not-json\n${rpc(1, 'initialize')}`);
    // The parse-error branch builds a -32700 payload with id null, but
    // writeResponse() returns early for a null id — so nothing reaches stdout.
    // Captured as-is from the pre-split implementation.
    expect(responses).toHaveLength(1);
    expect(responses[0]?.id).toBe(1);
  });

  test('an unsupported method answers -32000 naming the method', async () => {
    const { responses } = await runMcp(rpc(1, 'resources/list'));
    expect(responses).toHaveLength(1);
    expect(responses[0]).toEqual({
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32000, message: 'unsupported MCP method: resources/list' },
    });
  });
});
