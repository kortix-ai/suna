import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACCESS_HOLD_MS,
  accessFilePath,
  accessRequestPath,
  decideAccess,
  keepAwakeCommand,
  readAccess,
  wakeDesktopApp,
  writeAccess,
  writeAccessRequest,
} from './access';

const homes: string[] = [];
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});
function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'agent-tunnel-access-'));
  homes.push(home);
  return home;
}

describe('access.json', () => {
  test('a machine without the file keeps working: it reads as always allowed', () => {
    expect(readAccess(tempHome())).toEqual({ mode: 'always', grantedUntil: null, deniedUntil: null, keepAwake: false });
  });

  test('a damaged file fails closed to ask, never to always', () => {
    const home = tempHome();
    writeFileSync(accessFilePath(home), '{not json');
    expect(readAccess(home).mode).toBe('ask');
    writeFileSync(accessFilePath(home), JSON.stringify({ mode: 'sometimes' }));
    expect(readAccess(home).mode).toBe('ask');
  });

  test('writes atomically and privately, and reads back', () => {
    const home = join(tempHome(), 'nested');
    const state = { mode: 'ask' as const, grantedUntil: '2030-01-01T00:00:00.000Z', deniedUntil: null, keepAwake: true };
    writeAccess(state, home);
    expect(readAccess(home)).toEqual(state);
    expect(statSync(accessFilePath(home)).mode & 0o077).toBe(0);
  });
});

describe('decideAccess', () => {
  const now = Date.parse('2030-01-01T12:00:00.000Z');
  const base = { grantedUntil: null, deniedUntil: null, keepAwake: false };

  test('always runs, off refuses', () => {
    expect(decideAccess({ ...base, mode: 'always' }, now)).toBe('run');
    expect(decideAccess({ ...base, mode: 'off' }, now)).toBe('off');
  });

  test('ask runs inside a grant, fails fast while denied, otherwise asks', () => {
    expect(decideAccess({ ...base, mode: 'ask', grantedUntil: '2030-01-01T12:30:00.000Z' }, now)).toBe('run');
    expect(decideAccess({ ...base, mode: 'ask', grantedUntil: '2030-01-01T11:59:59.000Z' }, now)).toBe('ask');
    expect(decideAccess({ ...base, mode: 'ask', deniedUntil: '2030-01-01T12:05:00.000Z' }, now)).toBe('denied');
    expect(decideAccess({ ...base, mode: 'ask', deniedUntil: '2030-01-01T11:00:00.000Z' }, now)).toBe('ask');
    expect(decideAccess({ ...base, mode: 'ask' }, now)).toBe('ask');
  });

  test('a grant that reaches more than 24 hours ahead is not honoured', () => {
    const tooLong = new Date(now + 48 * 3_600_000).toISOString();
    expect(decideAccess({ ...base, mode: 'ask', grantedUntil: tooLong }, now)).toBe('ask');
    const day = new Date(now + 24 * 3_600_000).toISOString();
    expect(decideAccess({ ...base, mode: 'ask', grantedUntil: day }, now)).toBe('run');
  });

  test('the hold is 20 seconds', () => {
    expect(ACCESS_HOLD_MS).toBe(20_000);
  });
});

describe('access request and desktop wake', () => {
  test('the request file names the capability and method', () => {
    const home = tempHome();
    const request = writeAccessRequest({ capability: 'filesystem', method: 'fs.list' }, home);
    const saved = JSON.parse(readFileSync(accessRequestPath(home), 'utf8'));
    expect(saved).toEqual(request);
    expect(saved).toMatchObject({ capability: 'filesystem', method: 'fs.list' });
    expect(typeof saved.id).toBe('string');
    expect(Date.parse(saved.requestedAt)).toBeGreaterThan(Date.now() - 5_000);
  });

  test('launches the recorded desktop command when the app is not running, as a GUI app, not as Node', async () => {
    const home = tempHome();
    const marker = join(home, 'launched.json');
    const script = join(home, 'fake-app.js');
    writeFileSync(
      script,
      `require('fs').writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ args: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null, home: process.env.AGENT_TUNNEL_HOME ?? null, url: process.env.KORTIX_DESKTOP_URL ?? null }));`,
    );
    writeFileSync(
      join(home, 'desktop-app.json'),
      JSON.stringify({ command: process.execPath, args: [script, '--from-agent'], pid: 2 ** 22 + 4321, env: { KORTIX_DESKTOP_URL: 'http://localhost:3000' } }),
    );
    const previous = { run: process.env.ELECTRON_RUN_AS_NODE, home: process.env.AGENT_TUNNEL_HOME };
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.AGENT_TUNNEL_HOME = home;
    try {
      expect(wakeDesktopApp(home)).toBe('launched');
    } finally {
      if (previous.run === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = previous.run;
      if (previous.home === undefined) delete process.env.AGENT_TUNNEL_HOME;
      else process.env.AGENT_TUNNEL_HOME = previous.home;
    }
    const deadline = Date.now() + 5_000;
    while (!existsSync(marker) && Date.now() < deadline) await Bun.sleep(20);
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      args: ['--from-agent'],
      runAsNode: null,
      home: null,
      url: 'http://localhost:3000',
    });
  });

  test('does not launch a second copy of a running app, and ignores a missing or relative command', () => {
    const home = tempHome();
    expect(wakeDesktopApp(home)).toBe('no-app');
    writeFileSync(join(home, 'desktop-app.json'), JSON.stringify({ command: process.execPath, args: [], pid: process.pid }));
    expect(wakeDesktopApp(home)).toBe('running');
    writeFileSync(join(home, 'desktop-app.json'), JSON.stringify({ command: 'kortix', args: [], pid: 0 }));
    expect(wakeDesktopApp(home)).toBe('no-app');
  });

  test('a recorded app that no longer exists is no-app, and a spawn failure never crashes the agent', async () => {
    const home = tempHome();
    writeFileSync(join(home, 'desktop-app.json'), JSON.stringify({ command: '/tmp/.mount_gone/kortix', args: [], pid: 0 }));
    expect(wakeDesktopApp(home)).toBe('no-app');
    // Exists but cannot execute: ENOENT/EACCES arrives later as an 'error' event.
    const notExecutable = join(home, 'Kortix');
    writeFileSync(notExecutable, 'not a program', { mode: 0o600 });
    writeFileSync(join(home, 'desktop-app.json'), JSON.stringify({ command: notExecutable, args: [], pid: 0 }));
    expect(wakeDesktopApp(home)).toBe('launched');
    await Bun.sleep(200);
  });

  test('a live pid with a stale heartbeat is not the app (pid reuse after a reboot)', () => {
    const home = tempHome();
    const file = join(home, 'desktop-app.json');
    writeFileSync(file, JSON.stringify({ command: process.execPath, args: ['-e', '0'], pid: process.pid }));
    expect(wakeDesktopApp(home)).toBe('running');
    const old = new Date(Date.now() - 120_000);
    utimesSync(file, old, old);
    expect(wakeDesktopApp(home)).toBe('launched');
  });
});

describe('keep awake', () => {
  test('macOS uses caffeinate tied to the agent pid; Linux uses systemd-inhibit; Windows is unsupported', () => {
    expect(keepAwakeCommand('darwin', 42)).toEqual({ command: 'caffeinate', args: ['-s', '-w', '42'] });
    expect(keepAwakeCommand('linux', 42)).toEqual({
      command: 'systemd-inhibit',
      args: ['--what=sleep', '--who=Kortix', '--why=Keep this computer reachable', '--mode=block', 'tail', '--pid=42', '-f', '/dev/null'],
    });
    expect(keepAwakeCommand('win32', 42)).toBeNull();
  });
});
