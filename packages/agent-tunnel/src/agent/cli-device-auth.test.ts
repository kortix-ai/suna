import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { access, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_PATH = resolve(import.meta.dir, 'cli.ts');
const children = new Set<ChildProcess>();
const temporaryHomes = new Set<string>();

afterEach(async () => {
  for (const child of children) child.kill('SIGTERM');
  children.clear();
  await Promise.all(
    [...temporaryHomes].map((path) => rm(path, { recursive: true, force: true })),
  );
  temporaryHomes.clear();
});

async function waitForFile(path: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await stat(path);
      return;
    } catch {
      await Bun.sleep(20);
    }
  }
  throw new Error(`Timed out waiting for ${path}`);
}

describe('agent tunnel device authorization CLI', () => {
  test('persists the exact browser-approved capability list as the local ceiling', async () => {
    const approvedCapabilities = ['desktop', 'filesystem'];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/v1/tunnel/device-auth') {
          return Response.json(
            {
              deviceCode: 'TEST-0001',
              deviceSecret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
              verificationUrl: 'https://dev.kortix.com/tunnel/authorize/TEST-0001',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              pollIntervalMs: 250,
            },
            { status: 201 },
          );
        }
        if (request.method === 'GET' && url.pathname.endsWith('/TEST-0001/status')) {
          expect(request.headers.get('authorization')).toBe(
            'Bearer ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
          );
          return Response.json({
            status: 'approved',
            tunnelId: '00000000-0000-4000-8000-000000000001',
            token: 'kortix_tnl_ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
            capabilities: approvedCapabilities,
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const temporaryHome = await mkdtemp(join(tmpdir(), 'agent-tunnel-cli-home-'));
    temporaryHomes.add(temporaryHome);
    const child = spawn(
      process.execPath,
      [
        'run',
        CLI_PATH,
        'connect',
        '--foreground',
        '--api-url',
        `http://127.0.0.1:${server.port}/v1/tunnel`,
      ],
      {
        env: {
          ...process.env,
          HOME: temporaryHome,
          KORTIX_AGENT_TUNNEL_NO_BROWSER: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child);

    try {
      const configPath = join(temporaryHome, '.agent-tunnel', 'config.json');
      await waitForFile(configPath);
      const config = JSON.parse(await readFile(configPath, 'utf8')) as {
        enabledCapabilities?: string[];
      };
      expect(config.enabledCapabilities).toEqual(approvedCapabilities);
      expect((await stat(configPath)).mode & 0o077).toBe(0);
    } finally {
      child.kill('SIGTERM');
      children.delete(child);
      server.stop(true);
    }
  });

  test('rejects malformed credentials returned by the authorization server', async () => {
    let approvedResponseSent!: () => void;
    const responseSent = new Promise<void>((resolve) => {
      approvedResponseSent = resolve;
    });
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/v1/tunnel/device-auth') {
          return Response.json(
            {
              deviceCode: 'TEST-0002',
              deviceSecret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
              verificationUrl: 'https://dev.kortix.com/tunnel/authorize/TEST-0002',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              pollIntervalMs: 250,
            },
            { status: 201 },
          );
        }
        if (request.method === 'GET' && url.pathname.endsWith('/TEST-0002/status')) {
          approvedResponseSent();
          return Response.json({
            status: 'approved',
            tunnelId: 'not-a-uuid',
            token: 'kortix_tnl_invalid\ncredential',
            capabilities: ['desktop'],
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const temporaryHome = await mkdtemp(join(tmpdir(), 'agent-tunnel-cli-home-'));
    temporaryHomes.add(temporaryHome);
    const configPath = join(temporaryHome, '.agent-tunnel', 'config.json');
    const child = spawn(
      process.execPath,
      [
        'run',
        CLI_PATH,
        'connect',
        '--foreground',
        '--api-url',
        `http://127.0.0.1:${server.port}/v1/tunnel`,
      ],
      {
        env: {
          ...process.env,
          HOME: temporaryHome,
          KORTIX_AGENT_TUNNEL_NO_BROWSER: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child);
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    const exitCode = new Promise<number | null>((resolve) => child.once('exit', resolve));

    try {
      await responseSent;
      expect(await Promise.race([exitCode, Bun.sleep(2_000).then(() => -1)])).toBe(1);
      await expect(access(configPath)).rejects.toThrow();
      expect(stderr).toContain('invalid tunnel ID');
    } finally {
      child.kill('SIGTERM');
      children.delete(child);
      server.stop(true);
    }
  });
});
