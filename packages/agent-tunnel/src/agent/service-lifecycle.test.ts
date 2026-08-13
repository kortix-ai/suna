import { afterEach, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  MAX_SERVICE_LOG_BYTES,
  TERMINAL_SERVICE_EXIT_CODE,
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

describe('supervisor restart policy', () => {
  test('launchd restarts only on a failure exit', () => {
    const plist = renderLaunchdPlist('exec /bin/echo tunnel');
    expect(plist).toContain('<key>SuccessfulExit</key>');
    expect(plist).toContain('<false/>');
    // The old unconditional form is what produced the endless respawn loop.
    expect(plist).not.toContain('<key>KeepAlive</key>\n  <true/>');
  });

  test('systemd restarts only on a failure exit', () => {
    const unit = renderSystemdUnit('exec /bin/echo tunnel');
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toContain('Restart=always');
  });

  test('windows loop breaks on the terminal exit code', () => {
    const script = renderWindowsPowerShellScript({
      command: 'node',
      args: ['agent-tunnel.js', 'run', '--service'],
    });
    expect(script).toContain(`if ($LASTEXITCODE -eq ${TERMINAL_SERVICE_EXIT_CODE}) { break }`);
  });

  test('run --service exits terminally when no credential is saved', async () => {
    const home = await mkdtemp(join(tmpdir(), 'agent-tunnel-nocred-'));
    temporaryHomes.add(home);

    const child = spawn(process.execPath, ['run', CLI_PATH, 'run', '--service'], {
      env: { ...process.env, HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    const exitCode = await new Promise<number | null>((r) => child.once('exit', r));

    // A non-zero exit here would make the supervisor respawn it forever.
    expect(exitCode).toBe(TERMINAL_SERVICE_EXIT_CODE);
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

      writeFileSync(outLog, `${'noise line\n'.repeat(60_000)}final line\n`);
      expect(statSync(outLog).size).toBeGreaterThan(MAX_SERVICE_LOG_BYTES / 10);

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

    const status = JSON.parse(stdout) as { paired: boolean; capabilities: string[] };
    expect(status.paired).toBe(true);
    expect(status.capabilities).toEqual(['filesystem', 'shell']);
  }, 30_000);
});
