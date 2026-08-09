import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
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
              deviceSecret: 'device-secret',
              verificationUrl: 'not-a-browser-url',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              pollIntervalMs: 1,
            },
            { status: 201 },
          );
        }
        if (request.method === 'GET' && url.pathname.endsWith('/TEST-0001/status')) {
          expect(request.headers.get('authorization')).toBe('Bearer device-secret');
          return Response.json({
            status: 'approved',
            tunnelId: '00000000-0000-4000-8000-000000000001',
            token: 'kortix_tnl_device-token',
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
        env: { ...process.env, HOME: temporaryHome },
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
});
