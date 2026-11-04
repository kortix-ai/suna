import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ACCESS_HOLD_MS,
  accessAfterPairing,
  accessCommand,
  accessFilePath,
  accessView,
  accessWidens,
  applyAccess,
  nextAccess,
  parseAccessChange,
  readAccessRequest,
  type AccessChange,
  type AccessState,
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

describe('the access rules (one copy: the CLI, the agent, and the desktop app all use these)', () => {
  const now = Date.parse('2030-01-01T12:00:00.000Z');
  const ask = { mode: 'ask' as const, grantedUntil: null, deniedUntil: null, keepAwake: false };

  test('grants (max 24 h), revokes, denies for 10 minutes, switches mode and keep awake', () => {
    expect(nextAccess(ask, { grantMinutes: 60 }, now)).toMatchObject({ grantedUntil: '2030-01-01T13:00:00.000Z', deniedUntil: null });
    expect(nextAccess(ask, { grantMinutes: 10_000 }, now).grantedUntil).toBe('2030-01-02T12:00:00.000Z');
    expect(nextAccess({ ...ask, grantedUntil: 'x' }, { revoke: true }, now).grantedUntil).toBeNull();
    expect(nextAccess(ask, { deny: true }, now)).toMatchObject({ grantedUntil: null, deniedUntil: '2030-01-01T12:10:00.000Z' });
    expect(nextAccess(ask, { mode: 'off', keepAwake: true }, now)).toMatchObject({ mode: 'off', keepAwake: true });
    expect(() => nextAccess(ask, { mode: 'sometimes' as never }, now)).toThrow(/mode/);
    expect(() => nextAccess(ask, { grantMinutes: 0 }, now)).toThrow(/grantMinutes/);
    // A mode change drops the old grant and denial: back to "Ask each time" asks again.
    const granted = { mode: 'off' as const, grantedUntil: '2030-01-01T20:00:00.000Z', deniedUntil: '2030-01-01T12:05:00.000Z', keepAwake: false };
    expect(nextAccess(granted, { mode: 'ask' }, now)).toMatchObject({ mode: 'ask', grantedUntil: null, deniedUntil: null });
  });

  test('only `always` and a longer grant widen access; everything else narrows', () => {
    const widens = (current: typeof ask | AccessState, change: AccessChange) => accessWidens(current, nextAccess(current, change, now), now);
    expect(widens(ask, { mode: 'always' })).toBe(true);
    expect(widens(ask, { grantMinutes: 1440 })).toBe(true);
    expect(widens({ ...ask, grantedUntil: '2030-01-01T18:00:00.000Z' }, { grantMinutes: 60 })).toBe(false);
    expect(widens({ ...ask, mode: 'off' }, { mode: 'ask' })).toBe(false);
    expect(widens({ ...ask, mode: 'always' }, { mode: 'ask' })).toBe(false);
    expect(widens(ask, { mode: 'off' })).toBe(false);
    expect(widens({ ...ask, grantedUntil: '2030-01-01T13:00:00.000Z' }, { revoke: true })).toBe(false);
    expect(widens(ask, { keepAwake: true })).toBe(false);
    expect(widens(ask, { deny: true })).toBe(false);
  });

  test('a relayed change keeps only known fields with their types', () => {
    expect(parseAccessChange({ mode: 'off', keepAwake: false, extra: 1 })).toEqual({ mode: 'off', keepAwake: false });
    expect(() => parseAccessChange({ mode: 'sometimes' })).toThrow(/mode/);
    expect(() => parseAccessChange({ grantMinutes: '60' })).toThrow(/grantMinutes/);
    expect(() => parseAccessChange({ revoke: 'yes' })).toThrow(/revoke/);
    expect(() => parseAccessChange({})).toThrow(/No access change/);
    expect(() => parseAccessChange(null)).toThrow(/No access change/);
  });

  test('names the terminal command for a change', () => {
    expect(accessCommand({ mode: 'always' })).toBe('npx @kortix/agent-tunnel@latest access always');
    expect(accessCommand({ grantMinutes: 60 })).toBe('npx @kortix/agent-tunnel@latest access --allow-for 60');
    expect(accessCommand({ keepAwake: true })).toBe('npx @kortix/agent-tunnel@latest keep-awake on');
  });

  test('the view shows a pending request while it is fresh, and no lapsed grant or denial', () => {
    const home = tempHome();
    writeAccess({ ...ask, grantedUntil: '2030-01-01T11:00:00.000Z', deniedUntil: '2030-01-01T11:30:00.000Z' }, home);
    const fresh = { id: 'r1', capability: 'filesystem', method: 'fs.list', requestedAt: new Date(now - 5_000).toISOString() };
    writeFileSync(accessRequestPath(home), JSON.stringify(fresh));
    expect(accessView(home, 'darwin', now)).toEqual({
      ...ask,
      keepAwakeSupported: true,
      pendingRequest: { id: 'r1', capability: 'filesystem', requestedAt: fresh.requestedAt },
    });
    expect(accessView(home, 'darwin', now + 120_000).pendingRequest).toBeNull();
    expect(accessView(home, 'win32', now).keepAwakeSupported).toBe(false);
  });

  test('applying a change answers the request asked before it; deny on a relayed change only declines it', () => {
    const home = tempHome();
    writeAccess(ask, home);
    writeAccessRequest({ capability: 'filesystem', method: 'fs.list' }, home);
    expect(applyAccess({ keepAwake: true }, home).pendingRequest).not.toBeNull();
    expect(applyAccess({ grantMinutes: 60 }, home)).toMatchObject({ pendingRequest: null, keepAwake: true });
    expect(readAccess(home).grantedUntil).not.toBeNull();

    writeAccessRequest({ capability: 'access', method: 'tunnel.access.set', change: { mode: 'always' } }, home);
    const declined = applyAccess({ deny: true }, home);
    expect(declined.pendingRequest).toBeNull();
    // Declining a change is not a denial of calls: the grant stays.
    expect(declined.deniedUntil).toBeNull();
    expect(declined.grantedUntil).not.toBeNull();

    writeAccessRequest({ capability: 'shell', method: 'shell.exec' }, home);
    expect(applyAccess({ deny: true }, home)).toMatchObject({ pendingRequest: null, grantedUntil: null });
    expect(readAccess(home).deniedUntil).not.toBeNull();
  });
});

describe('access after pairing', () => {
  test('a re-pair keeps the owner mode and keep awake, and drops the old grant or denial', () => {
    const home = tempHome();
    writeFileSync(
      accessFilePath(home),
      JSON.stringify({ mode: 'always', grantedUntil: null, deniedUntil: '2099-01-01T00:00:00.000Z', keepAwake: true }),
    );
    expect(accessAfterPairing(home, true)).toEqual({ mode: 'always', grantedUntil: null, deniedUntil: null, keepAwake: true });
    writeFileSync(accessFilePath(home), JSON.stringify({ mode: 'off', grantedUntil: null, deniedUntil: null, keepAwake: false }));
    expect(accessAfterPairing(home, false).mode).toBe('off');
    writeFileSync(accessFilePath(home), JSON.stringify({ mode: 'ask', grantedUntil: '2099-01-01T00:00:00.000Z', deniedUntil: null, keepAwake: false }));
    expect(accessAfterPairing(home, false)).toEqual({ mode: 'ask', grantedUntil: null, deniedUntil: null, keepAwake: false });
  });

  test('a first pairing asks when the desktop app can answer, else always', () => {
    expect(accessAfterPairing(tempHome(), true).mode).toBe('ask');
    expect(accessAfterPairing(tempHome(), false).mode).toBe('always');
  });
});

// Characterize the PID probe through the desktop observer, without launching an app.
describe('desktop PID liveness', () => {
  test.each([null, '1', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])('rejects invalid PID %p without probing', (pid) => {
    const home = tempHome();
    writeFileSync(join(home, 'desktop-app.json'), JSON.stringify({ pid }));
    const kill = spyOn(process, 'kill');
    try {
      expect(wakeDesktopApp(home)).toBe('no-app');
      expect(kill).not.toHaveBeenCalled();
    } finally { kill.mockRestore(); }
  });

  test.each(['live', 'ESRCH', 'EPERM'])('handles %s', (result) => {
    const home = tempHome();
    writeFileSync(join(home, 'desktop-app.json'), JSON.stringify({ pid: process.pid }));
    const kill = spyOn(process, 'kill').mockImplementation(() => {
      if (result !== 'live') throw Object.assign(new Error(result), { code: result });
      return true;
    });
    try {
      expect(wakeDesktopApp(home)).toBe(result === 'ESRCH' ? 'no-app' : 'running');
      expect(kill).toHaveBeenCalledWith(process.pid, 0);
    } finally { kill.mockRestore(); }
  });
});
