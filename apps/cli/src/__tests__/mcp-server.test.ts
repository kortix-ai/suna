import { join, resolve } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { TIERS } from '../command-table.ts';

/**
 * `kortix mcp` is the CLI over stdio JSON-RPC: one tool per top-level command,
 * each call a real child `kortix <command> <args>`. Black-box: spawn it, speak
 * MCP, assert what a client sees.
 */

const CLI_ROOT = resolve(import.meta.dir, '..', '..');
const CLI_ENTRY = join(CLI_ROOT, 'src', 'index.ts');

type Message = { id: number; result?: any; error?: { code: number; message: string } };

async function mcp(requests: object[]): Promise<Map<number, Message>> {
  const proc = Bun.spawn({
    cmd: [process.execPath, CLI_ENTRY, 'mcp'],
    cwd: CLI_ROOT,
    env: {
      ...process.env,
      KORTIX_TOKEN: 'kortix_pat_test_offline',
      KORTIX_API_URL: 'http://127.0.0.1:9/v1',
      KORTIX_NO_UPDATE_CHECK: '1',
      KORTIX_DISABLE_SANDBOX_ENV_FILE: '1',
    },
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  for (const req of requests) proc.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...req })}\n`);
  proc.stdin.flush();
  // Keep stdin open until every id answered: closing it kills in-flight calls.
  const want = requests.filter((r) => 'id' in r).length;
  const out = new Map<number, Message>();
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (out.size < want) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines.filter(Boolean)) {
      const msg = JSON.parse(line) as Message;
      out.set(msg.id, msg);
    }
  }
  proc.stdin.end();
  expect(await proc.exited).toBe(0);
  return out;
}

const call = (id: number, name: string, args?: string[]) => ({
  id,
  method: 'tools/call',
  params: { name, arguments: args ? { args } : {} },
});

describe('kortix mcp', () => {
  test('initialize names the server and tells the agent how tools map to commands', async () => {
    const res = await mcp([{ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }]);
    const result = res.get(1)!.result;
    expect(result.serverInfo.name).toBe('kortix');
    expect(result.protocolVersion).toBe('2025-06-18');
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.instructions).toContain('system-skills');
  });

  test('tools/list is the help table minus the terminal-only commands', async () => {
    const res = await mcp([{ id: 1, method: 'tools/list' }]);
    const names: string[] = res.get(1)!.result.tools.map((t: { name: string }) => t.name);
    const helpNames = TIERS.flatMap((t) => t.sections.flatMap((s) => s.commands.map((c) => c.name)));
    const terminalOnly = ['mcp', 'connect', 'tui', 'update', 'uninstall', 'help'];
    expect(names).toEqual(helpNames.filter((n) => !terminalOnly.includes(n)));
    for (const n of ['sessions', 'projects', 'secrets', 'system-skills', 'whoami']) {
      expect(names).toContain(n);
    }
  });

  test('a call runs the real command and returns its stdout', async () => {
    const res = await mcp([call(1, 'schema', ['--version', '2'])]);
    const { content, isError } = res.get(1)!.result;
    expect(isError).toBe(false);
    expect(JSON.parse(content[0].text).$id).toContain('kortix.v2.schema.json');
  });

  test('a failing command is isError with its stderr and exit code', async () => {
    const res = await mcp([call(1, 'sessions', ['no-such-subcommand'])]);
    const { content, isError } = res.get(1)!.result;
    expect(isError).toBe(true);
    const text = content.map((c: { text: string }) => c.text).join('\n');
    expect(text).toContain('unknown subcommand');
    expect(content.at(-1).text).toMatch(/^\[exit code [1-9]\d*\]$/);
  });

  test('terminal-only commands and malformed args are refused, not run', async () => {
    const res = await mcp([
      call(1, 'tui'),
      call(2, 'mcp'),
      { id: 3, method: 'tools/call', params: { name: 'whoami', arguments: { args: 'ls' } } },
      { id: 4, method: 'resources/list' },
    ]);
    expect(res.get(1)!.result).toEqual({
      content: [{ type: 'text', text: 'unknown tool tui' }],
      isError: true,
    });
    expect(res.get(2)!.result.isError).toBe(true);
    expect(res.get(3)!.result.content[0].text).toBe('args must be an array of strings');
    expect(res.get(4)!.error!.code).toBe(-32601);
  });
});
