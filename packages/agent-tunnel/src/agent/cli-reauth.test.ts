import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI_PATH = resolve(import.meta.dir, 'cli.ts');
const children = new Set<ChildProcess>();
const temporaryHomes = new Set<string>();

const STALE_TUNNEL_ID = '00000000-0000-4000-8000-0000000000ff';
const STALE_TOKEN = 'kortix_tnl_STALEAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const FRESH_TUNNEL_ID = '00000000-0000-4000-8000-000000000042';
const FRESH_TOKEN = 'kortix_tnl_FRESHBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

afterEach(async () => {
  for (const child of children) child.kill('SIGTERM');
  children.clear();
  await Promise.all(
    [...temporaryHomes].map((path) => rm(path, { recursive: true, force: true })),
  );
  temporaryHomes.clear();
});

async function seedStaleCredentials(apiUrl: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'agent-tunnel-reauth-home-'));
  temporaryHomes.add(home);
  const configDir = join(home, '.agent-tunnel');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  await writeFile(
    join(configDir, 'config.json'),
    JSON.stringify({ tunnelId: STALE_TUNNEL_ID, token: STALE_TOKEN, apiUrl }),
    { mode: 0o600 },
  );
  return home;
}

async function waitFor<T>(read: () => Promise<T>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      await Bun.sleep(50);
    }
  }
  throw lastError ?? new Error('timed out');
}

/** Relay that refuses every credential, and a device-auth endpoint that issues a fresh one. */
function startRejectingRelay(options: { serveDeviceAuth: boolean }) {
  let deviceAuthCalls = 0;
  const server = Bun.serve({
    port: 0,
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === '/v1/tunnel/ws') {
        return server.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
      }
      if (!options.serveDeviceAuth) return new Response('not found', { status: 404 });

      if (request.method === 'POST' && url.pathname === '/v1/tunnel/device-auth') {
        deviceAuthCalls++;
        return Response.json(
          {
            deviceCode: 'RAUT-0001',
            deviceSecret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
            verificationUrl: 'https://dev.kortix.com/tunnel/authorize/RAUT-0001',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            pollIntervalMs: 250,
          },
          { status: 201 },
        );
      }
      if (request.method === 'GET' && url.pathname.endsWith('/RAUT-0001/status')) {
        return Response.json({
          status: 'approved',
          tunnelId: FRESH_TUNNEL_ID,
          token: FRESH_TOKEN,
          capabilities: ['filesystem'],
        });
      }
      return new Response('not found', { status: 404 });
    },
    websocket: {
      // 4001 is the relay's "credential refused" code.
      message(ws) {
        ws.close(4001, 'auth failed');
      },
    },
  });
  return { server, deviceAuthCalls: () => deviceAuthCalls };
}

function runConnect(home: string, apiUrl: string, extraArgs: string[] = []) {
  const child = spawn(
    process.execPath,
    ['run', CLI_PATH, 'connect', '--foreground', '--api-url', apiUrl, ...extraArgs],
    {
      env: { ...process.env, HOME: home, KORTIX_AGENT_TUNNEL_NO_BROWSER: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  children.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr?.on('data', (chunk) => { stderr += String(chunk); });
  return { child, out: () => stdout, err: () => stderr };
}

describe('agent tunnel connect re-authorization', () => {
  test('re-pairs through device auth when the saved token is rejected', async () => {
    const relay = startRejectingRelay({ serveDeviceAuth: true });
    const apiUrl = `http://127.0.0.1:${relay.server.port}/v1/tunnel`;
    const home = await seedStaleCredentials(apiUrl);
    const configPath = join(home, '.agent-tunnel', 'config.json');
    const run = runConnect(home, apiUrl);

    try {
      const config = await waitFor(async () => {
        const parsed = JSON.parse(await readFile(configPath, 'utf8')) as { token?: string };
        if (parsed.token !== FRESH_TOKEN) throw new Error('still holding the stale token');
        return parsed as { token: string; tunnelId: string };
      });

      expect(config.tunnelId).toBe(FRESH_TUNNEL_ID);
      expect(run.out()).toContain('Checking saved credentials');
      expect(run.out()).toContain('Saved token rejected');
      expect(relay.deviceAuthCalls()).toBeGreaterThan(0);
    } finally {
      run.child.kill('SIGTERM');
      relay.server.stop(true);
    }
  }, 30_000);

  test('keeps the saved credential when the relay is unreachable', async () => {
    // Port 1 is reserved and refuses connections, so the probe cannot conclude
    // anything about the credential itself.
    const apiUrl = 'http://127.0.0.1:1/v1/tunnel';
    const home = await seedStaleCredentials(apiUrl);
    const configPath = join(home, '.agent-tunnel', 'config.json');
    const run = runConnect(home, apiUrl);

    const exitCode = await new Promise<number | null>((r) => run.child.once('exit', r));
    expect(exitCode).toBe(1);
    expect(run.err()).toContain('Cannot reach the relay');

    const config = JSON.parse(await readFile(configPath, 'utf8')) as { token?: string };
    expect(config.token).toBe(STALE_TOKEN);
  }, 30_000);

  test('--reauth discards a saved credential without probing it first', async () => {
    const relay = startRejectingRelay({ serveDeviceAuth: true });
    const apiUrl = `http://127.0.0.1:${relay.server.port}/v1/tunnel`;
    const home = await seedStaleCredentials(apiUrl);
    const configPath = join(home, '.agent-tunnel', 'config.json');
    const run = runConnect(home, apiUrl, ['--reauth']);

    try {
      const config = await waitFor(async () => {
        const parsed = JSON.parse(await readFile(configPath, 'utf8')) as { token?: string };
        if (parsed.token !== FRESH_TOKEN) throw new Error('not re-paired yet');
        return parsed;
      });
      expect(config.token).toBe(FRESH_TOKEN);
      expect(run.out()).not.toContain('Checking saved credentials');
    } finally {
      run.child.kill('SIGTERM');
      relay.server.stop(true);
    }
  }, 30_000);

  test('logout clears the credential but keeps unrelated settings', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-tunnel-logout-home-'));
    temporaryHomes.add(home);
    const configDir = join(home, '.agent-tunnel');
    await mkdir(configDir, { recursive: true, mode: 0o700 });
    const configPath = join(configDir, 'config.json');
    await writeFile(
      configPath,
      JSON.stringify({
        tunnelId: STALE_TUNNEL_ID,
        token: STALE_TOKEN,
        apiUrl: 'https://api.kortix.com/v1/tunnel',
        shellTimeout: 12_345,
      }),
      { mode: 0o600 },
    );

    const child = spawn(process.execPath, ['run', CLI_PATH, 'logout'], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    await new Promise<number | null>((r) => child.once('exit', r));

    const config = JSON.parse(await readFile(configPath, 'utf8')) as Record<string, unknown>;
    expect(config.token).toBeUndefined();
    expect(config.tunnelId).toBeUndefined();
    expect(config.shellTimeout).toBe(12_345);
  }, 30_000);
});
