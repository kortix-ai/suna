import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MAX_SERVICE_LOG_BYTES,
    getServicePaths,
  renderLaunchdPlist,
  renderSystemdUnit,
  renderWindowsPowerShellScript,
  rotateServiceLogs,
} from './service';
import { collapseRepeatedLines } from './log-format';
import { probeCredentials } from './credential-probe';

const CLI_PATH = resolve(import.meta.dir, 'cli.ts');
const children = new Set<ChildProcess>();
const temporaryHomes = new Set<string>();

afterEach(async () => {
  for (const child of children) child.kill('SIGTERM');
  children.clear();
  await Promise.all([...temporaryHomes].map((p) => rm(p, { recursive: true, force: true })));
  temporaryHomes.clear();
});

describe('supervisor restart policy (R3)', () => {
  test('launchd restarts on every exit, throttled to 10 s', () => {
    const plist = renderLaunchdPlist('exec /bin/echo tunnel');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('<key>ThrottleInterval</key>');
    expect(plist).not.toContain('SuccessfulExit');
  });

  test('systemd restarts on every exit', () => {
    const unit = renderSystemdUnit('exec /bin/echo tunnel');
    expect(unit).toContain('Restart=always');
    expect(unit).not.toContain('Restart=on-failure');
  });

  test('the windows loop never breaks', () => {
    const script = renderWindowsPowerShellScript({
      command: 'node',
      args: ['agent-tunnel.js', 'run', '--service'],
    });
    expect(script).not.toContain('break');
    expect(script).toContain('while ($true)');
  });

  test('run --service without a credential stays alive and waits for one (R2)', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-tunnel-nocred-'));
    temporaryHomes.add(home);

    const child = spawn(process.execPath, ['run', CLI_PATH, 'run', '--service'], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    const exited = await Promise.race([
      new Promise<boolean>((r) => child.once('exit', () => r(true))),
      Bun.sleep(2_500).then(() => false),
    ]);

    // Exiting here would only make the always-restarting supervisor spin.
    expect(exited).toBe(false);
    expect(stdout).toContain('waiting for a credential');
  }, 30_000);
});

describe('service log hygiene', () => {
  test('collapses repeated lines and keeps the count', () => {
    expect(collapseRepeatedLines(['a', 'a', 'a', 'b', 'a'])).toEqual(['a  (x3)', 'b', 'a']);
    expect(collapseRepeatedLines([])).toEqual([]);
    expect(collapseRepeatedLines(['only'])).toEqual(['only']);
  });

  test('trims a log that grew past the cap', () => {
    const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-rotate-'));
    try {
      const logDir = join(home, 'logs');
      mkdirSync(logDir, { recursive: true });
      const paths = { ...getServicePaths(), logDir };
      const outLog = join(logDir, 'agent-tunnel.out.log');

      const oversized = `${'noise line\n'.repeat(60_000)}final line\n`;
      writeFileSync(outLog, oversized);
      expect(oversized.length).toBeGreaterThan(MAX_SERVICE_LOG_BYTES / 10);

      const rotated = rotateServiceLogs(paths, 1024);
      expect(rotated).toContain(outLog);

      const body = readFileSync(outLog, 'utf8');
      expect(body).toStartWith('[agent-tunnel] earlier entries trimmed');
      expect(body).toContain('final line');
      expect(body.length).toBeLessThan(64 * 1024);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('credential probe and the single-agent rule', () => {
  test('treats being replaced as proof the credential is valid', async () => {
    // The relay only replaces a socket it already registered, and registration
    // happens after a successful handshake.
    const server = Bun.serve({
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
      },
      websocket: {
        message(ws) {
          ws.close(4004, 'replaced by another agent process');
        },
      },
    });

    try {
      const result = await probeCredentials(
        {
          apiUrl: `http://127.0.0.1:${server.port}/v1/tunnel`,
          tunnelId: '00000000-0000-4000-8000-000000000001',
          token: 'kortix_tnl_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          wsPath: '/ws',
        } as never,
        { timeoutMs: 5_000 },
      );
      expect(result).toBe('valid');
    } finally {
      server.stop(true);
    }
  }, 30_000);
});

describe('capability approval', () => {
  test('refuses to save a pairing that approved nothing', async () => {
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (request.method === 'POST' && url.pathname === '/v1/tunnel/device-auth') {
          return Response.json(
            {
              deviceCode: 'ZERO-0001',
              deviceSecret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456',
              verificationUrl: 'https://dev.kortix.com/tunnel/authorize/ZERO-0001',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              pollIntervalMs: 250,
            },
            { status: 201 },
          );
        }
        if (request.method === 'GET' && url.pathname.endsWith('/ZERO-0001/status')) {
          return Response.json({
            status: 'approved',
            tunnelId: '00000000-0000-4000-8000-000000000042',
            token: 'kortix_tnl_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
            capabilities: [],
          });
        }
        return new Response('not found', { status: 404 });
      },
    });

    const home = await mkdtemp(join(tmpdir(), 'agent-tunnel-zerocap-'));
    temporaryHomes.add(home);
    await mkdir(join(home, '.agent-tunnel'), { recursive: true, mode: 0o700 });

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
        env: { ...process.env, HOME: home, KORTIX_AGENT_TUNNEL_NO_BROWSER: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    children.add(child);
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });

    try {
      const exitCode = await new Promise<number | null>((r) => child.once('exit', r));
      expect(exitCode).toBe(1);
      expect(stdout).toContain('No capabilities were approved');
      // An empty ceiling can only be widened by pairing again, so it must
      // never reach disk in the first place.
      await expect(readFile(join(home, '.agent-tunnel', 'config.json'), 'utf8')).rejects.toThrow();
    } finally {
      child.kill('SIGTERM');
      server.stop(true);
    }
  }, 30_000);
});

describe('status output', () => {
  test('reports an unpaired machine without inventing a connection', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-tunnel-status-'));
    temporaryHomes.add(home);

    const child = spawn(process.execPath, ['run', CLI_PATH, 'status', '--json'], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    await new Promise((r) => child.once('exit', r));

    const status = JSON.parse(stdout) as { paired: boolean; tunnelId: string | null };
    expect(status.paired).toBe(false);
    expect(status.tunnelId).toBeNull();
  }, 30_000);

  test('reports the approved capability ceiling for a paired machine', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-tunnel-status-paired-'));
    temporaryHomes.add(home);
    await mkdir(join(home, '.agent-tunnel'), { recursive: true, mode: 0o700 });
    await writeFile(
      join(home, '.agent-tunnel', 'config.json'),
      JSON.stringify({
        tunnelId: '00000000-0000-4000-8000-000000000042',
        token: 'kortix_tnl_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        apiUrl: 'https://api.kortix.com/v1/tunnel',
        enabledCapabilities: ['filesystem', 'shell'],
      }),
      { mode: 0o600 },
    );

    const child = spawn(process.execPath, ['run', CLI_PATH, 'status', '--json'], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    child.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    await new Promise((r) => child.once('exit', r));

    const status = JSON.parse(stdout) as {
      paired: boolean;
      capabilities: string[];
      access: { mode: string };
      service: { upToDate?: boolean; enabled?: boolean };
    };
    expect(status.paired).toBe(true);
    expect(status.capabilities).toEqual(['filesystem', 'shell']);
    // A machine paired before access control existed stays always-allowed.
    expect(status.access.mode).toBe('always');
    // Not installed, so it cannot match what an install would write now.
    expect(status.service.upToDate).toBe(false);
  }, 30_000);
});
