import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { spawn } from 'child_process';
import { resolve, dirname } from 'path';

const TUNNEL_ID = 'test-tunnel-001';

function mockRpcResponse(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case 'fs.read':
      return { content: `mock content of ${params.path}`, size: 28, path: params.path };
    case 'fs.write':
      return { path: params.path, size: (params.content as string).length };
    case 'fs.list':
      return {
        entries: [
          { name: 'file.txt', path: `${params.path}/file.txt`, isDirectory: false, isFile: true },
          { name: 'subdir', path: `${params.path}/subdir`, isDirectory: true, isFile: false },
        ],
        count: 2,
      };
    case 'shell.exec':
      return {
        exitCode: 0,
        signal: null,
        stdout: `ran ${params.command} ${((params.args as string[]) || []).join(' ')}`,
        stderr: '',
        stdoutTruncated: false,
        stderrTruncated: false,
      };
    case 'desktop.cua.ensure':
      return { ok: true, binary: '/Users/me/.local/bin/cua-driver', version: 'cua-driver 0.5.7' };
    case 'desktop.cua.start_daemon':
      return { ok: true, status: 'ok' };
    case 'desktop.cua.status':
      return { status: 'ok' };
    case 'desktop.cua.version':
      return { version: 'cua-driver 0.5.7' };
    case 'desktop.cua.list_tools':
      return { tools: 'list_apps: List apps\nget_window_state: Get window state' };
    case 'desktop.cua.describe':
      return { description: `${params.tool}: mocked description` };
    case 'desktop.cua.call':
      return { tool: params.tool, args: params.args ?? {} };
    case 'desktop.cua.list_apps':
      return { applications: [{ name: 'TextEdit', pid: 123, bundle_id: 'com.apple.TextEdit' }] };
    case 'desktop.cua.list_windows':
      return { windows: [{ window_id: 77, pid: 123, title: 'Untitled', app: 'TextEdit' }] };
    case 'desktop.cua.get_window_state':
      return { pid: params.pid, window_id: params.window_id, accessibility_tree: '[element_index 1] text area' };
    case 'desktop.cua.click':
      return { ok: true, element_index: params.element_index };
    case 'desktop.cua.type_text':
      return { ok: true, text: params.text };
    case 'desktop.cua.hotkey':
      return { ok: true, keys: params.keys };
    default:
      return { error: `Unknown method: ${method}` };
  }
}

let mockServer: ReturnType<typeof Bun.serve>;
let mockPort = 0;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/v1/tunnel/connections' && req.method === 'GET') {
        return Response.json([
          {
            tunnelId: TUNNEL_ID,
            name: 'Test Tunnel',
            isLive: true,
            capabilities: ['filesystem', 'shell', 'desktop'],
            machineInfo: { hostname: 'test-machine', platform: 'darwin', arch: 'arm64' },
          },
        ]);
      }

      const rpcMatch = url.pathname.match(/^\/v1\/tunnel\/rpc\/(.+)$/);
      if (rpcMatch && req.method === 'POST') {
        const body = (await req.json()) as { method: string; params: Record<string, unknown> };
        return Response.json({ result: mockRpcResponse(body.method, body.params || {}) });
      }

      return new Response('Not Found', { status: 404 });
    },
  });
  mockPort = mockServer.port!;
});

afterAll(() => {
  mockServer?.stop(true);
});

const CLI_PATH = resolve(dirname(import.meta.dir), 'client/cli.ts');

interface CliResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  json: Record<string, unknown> | null;
}

function runCli(
  command: string,
  argsJson?: string,
  envOverrides?: Record<string, string>,
): Promise<CliResult> {
  return new Promise((resolve) => {
    const cliArgs = ['run', CLI_PATH];
    if (command) cliArgs.push(command);
    if (argsJson) cliArgs.push(argsJson);

    const child = spawn('bun', cliArgs, {
      env: {
        ...process.env,
        TUNNEL_API_URL: `http://localhost:${mockPort}`,
        TUNNEL_TOKEN: 'test-token',
        TUNNEL_ID: '',
        ...envOverrides,
      },
      cwd: dirname(dirname(CLI_PATH)),
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

    child.on('close', (code: number | null) => {
      let json: Record<string, unknown> | null = null;
      try {
        json = JSON.parse(stdout.trim());
      } catch {}
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 1, json });
    });
  });
}

describe('Agent Tunnel CLI', () => {
  test('no command shows usage and exits 1', async () => {
    const r = await runCli('');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Usage:');
    expect(r.stderr).toContain('Available:');
  });

  test('unknown command shows error and exits 1', async () => {
    const r = await runCli('nonexistent');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Unknown command: nonexistent');
  });

  test('invalid JSON arg exits 1 with JSON error', async () => {
    const r = await runCli('fs_read', '{invalid json}');
    expect(r.exitCode).toBe(1);
    expect(r.json!.success).toBe(false);
  });

  test('status returns connections list', async () => {
    const r = await runCli('status');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    const conns = r.json!.connections as Array<Record<string, unknown>>;
    expect(conns[0].tunnelId).toBe(TUNNEL_ID);
    expect(conns[0].capabilities).toEqual(['filesystem', 'shell', 'desktop']);
  });

  test('fs_read returns file content', async () => {
    const r = await runCli('fs_read', '{"path":"/tmp/test.txt"}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.content).toContain('mock content');
  });

  test('fs_write returns path and size', async () => {
    const r = await runCli('fs_write', '{"path":"/tmp/out.txt","content":"hello world"}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.path).toBe('/tmp/out.txt');
    expect(r.json!.size).toBe(11);
  });

  test('fs_list returns entries', async () => {
    const r = await runCli('fs_list', '{"path":"/tmp"}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.count).toBe(2);
  });

  test('shell returns command output', async () => {
    const r = await runCli('shell', '{"command":"echo","args":["hello","world"]}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect(r.json!.stdout).toContain('echo hello world');
  });

  test('cua_ensure returns binary and version', async () => {
    const r = await runCli('cua_ensure');
    expect(r.exitCode).toBe(0);
    expect(r.json!.success).toBe(true);
    expect((r.json!.result as Record<string, unknown>).version).toBe('cua-driver 0.5.7');
  });

  test('cua_start_daemon returns daemon status', async () => {
    const r = await runCli('cua_start_daemon');
    expect(r.exitCode).toBe(0);
    expect((r.json!.result as Record<string, unknown>).ok).toBe(true);
  });

  test('cua_list_tools returns CUA tool descriptions', async () => {
    const r = await runCli('cua_list_tools');
    expect(r.exitCode).toBe(0);
    expect((r.json!.result as Record<string, unknown>).tools).toContain('list_apps');
  });

  test('cua_describe requires a tool', async () => {
    const r = await runCli('cua_describe');
    expect(r.exitCode).toBe(1);
    expect(r.json!.success).toBe(false);
  });

  test('cua_describe calls desktop.cua.describe', async () => {
    const r = await runCli('cua_describe', '{"tool":"get_window_state"}');
    expect(r.exitCode).toBe(0);
    expect((r.json!.result as Record<string, unknown>).description).toContain('get_window_state');
  });

  test('cua_call calls arbitrary CUA tools', async () => {
    const r = await runCli('cua_call', '{"tool":"check_permissions","args":{"format":"json"}}');
    expect(r.exitCode).toBe(0);
    expect(r.json!.tool).toBe('check_permissions');
    expect((r.json!.result as Record<string, unknown>).tool).toBe('check_permissions');
  });

  test('cua_list_apps returns app list', async () => {
    const r = await runCli('cua_list_apps');
    expect(r.exitCode).toBe(0);
    const result = r.json!.result as Record<string, unknown>;
    expect(Array.isArray(result.applications)).toBe(true);
  });

  test('cua_list_windows returns window list', async () => {
    const r = await runCli('cua_list_windows', '{"pid":123}');
    expect(r.exitCode).toBe(0);
    const result = r.json!.result as Record<string, unknown>;
    expect((result.windows as unknown[]).length).toBe(1);
  });

  test('cua_get_window_state returns accessibility markdown', async () => {
    const r = await runCli('cua_get_window_state', '{"pid":123,"window_id":77}');
    expect(r.exitCode).toBe(0);
    expect((r.json!.result as Record<string, unknown>).accessibility_tree).toContain('element_index');
  });

  test('cua_click supports element-indexed input', async () => {
    const r = await runCli('cua_click', '{"pid":123,"window_id":77,"element_index":1}');
    expect(r.exitCode).toBe(0);
    expect((r.json!.result as Record<string, unknown>).ok).toBe(true);
  });

  test('cua_type_text sends text', async () => {
    const r = await runCli('cua_type_text', '{"pid":123,"text":"hello"}');
    expect(r.exitCode).toBe(0);
    expect((r.json!.result as Record<string, unknown>).text).toBe('hello');
  });

  test('cua_hotkey sends keys', async () => {
    const r = await runCli('cua_hotkey', '{"pid":123,"keys":["cmd","s"]}');
    expect(r.exitCode).toBe(0);
    expect((r.json!.result as Record<string, unknown>).keys).toEqual(['cmd', 's']);
  });

  describe('permission handling', () => {
    let permServer: ReturnType<typeof Bun.serve>;
    let permPort = 0;

    beforeAll(() => {
      permServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);

          if (url.pathname === '/v1/tunnel/connections') {
            return Response.json([{ tunnelId: 'perm-tunnel', isLive: true }]);
          }

          if (url.pathname.startsWith('/v1/tunnel/rpc/')) {
            return Response.json(
              { code: -32003, error: 'Permission denied', requestId: 'req-abc-123' },
              { status: 403 },
            );
          }

          return new Response('Not Found', { status: 404 });
        },
      });
      permPort = permServer.port!;
    });

    afterAll(() => {
      permServer?.stop(true);
    });

    test('permission denied returns structured response', async () => {
      const r = await runCli('cua_list_apps', undefined, {
        TUNNEL_API_URL: `http://localhost:${permPort}`,
      });
      expect(r.json!.success).toBe(false);
      expect(r.json!.permissionRequired).toBe(true);
      expect(r.json!.requestId).toBe('req-abc-123');
    });
  });

  describe('server unreachable', () => {
    test('status with dead server returns error JSON', async () => {
      const r = await runCli('status', undefined, { TUNNEL_API_URL: 'http://localhost:1' });
      expect(r.exitCode).toBe(1);
      expect(r.json!.success).toBe(false);
    });
  });

  describe('no connections', () => {
    let emptyServer: ReturnType<typeof Bun.serve>;
    let emptyPort = 0;

    beforeAll(() => {
      emptyServer = Bun.serve({
        port: 0,
        async fetch(req) {
          const url = new URL(req.url);
          if (url.pathname === '/v1/tunnel/connections') return Response.json([]);
          return new Response('Not Found', { status: 404 });
        },
      });
      emptyPort = emptyServer.port!;
    });

    afterAll(() => {
      emptyServer?.stop(true);
    });

    test('status with no connections returns empty list', async () => {
      const r = await runCli('status', undefined, { TUNNEL_API_URL: `http://localhost:${emptyPort}` });
      expect(r.exitCode).toBe(0);
      expect(r.json!.success).toBe(true);
      expect((r.json!.connections as unknown[]).length).toBe(0);
    });

    test('fs_read with no connections returns error', async () => {
      const r = await runCli('fs_read', '{"path":"/tmp/x"}', {
        TUNNEL_API_URL: `http://localhost:${emptyPort}`,
      });
      expect(r.exitCode).toBe(1);
      expect(r.json!.success).toBe(false);
      expect(r.json!.error).toContain('No tunnel connection found');
    });
  });
});
