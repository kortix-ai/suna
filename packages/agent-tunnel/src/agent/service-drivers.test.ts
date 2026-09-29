import { afterEach, describe, expect, test } from 'bun:test';

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pause, renderWindowsTaskXml, serviceDriverFor, supervisor } from './service-drivers';
import { getServicePaths } from './service-paths';

const realRun = supervisor.run;
const realPause = pause.ms;
afterEach(() => {
  supervisor.run = realRun;
  pause.ms = realPause;
});

/** Records every supervisor command; `answers` fakes the ones a test cares about. */
function recordCommands(answers: Record<string, { ok: boolean; detail?: string }> = {}) {
  const calls: string[] = [];
  supervisor.run = (command, args) => {
    const line = [command, ...args].join(' ');
    calls.push(line);
    const hit = Object.entries(answers).find(([prefix]) => line.startsWith(prefix));
    return { ok: hit ? hit[1].ok : true, detail: hit?.[1].detail ?? '' };
  };
  return calls;
}

const paths = getServicePaths('/tmp/agent-tunnel-drivers-test');

describe('durable pause (R3)', () => {
  test('launchd: pause disables the job before unloading it, so login does not start it again', () => {
    const calls = recordCommands();
    serviceDriverFor('darwin')!.pause(paths, true);
    const uid = process.getuid!();
    expect(calls).toEqual([
      `launchctl disable gui/${uid}/${paths.label}`,
      `launchctl bootout gui/${uid} ${paths.launchdPlist}`,
    ]);
  });

  test('launchd: resume enables, loads and starts the job', () => {
    const calls = recordCommands();
    const outcome = serviceDriverFor('darwin')!.resume(paths, true);
    const uid = process.getuid!();
    expect(calls).toEqual([
      `launchctl enable gui/${uid}/${paths.label}`,
      `launchctl bootstrap gui/${uid} ${paths.launchdPlist}`,
      `launchctl kickstart gui/${uid}/${paths.label}`,
    ]);
    expect(outcome.active).toBe(true);
  });

  test('launchd: status reports a disabled job as paused', () => {
    const uid = process.getuid!();
    recordCommands({
      'launchctl print-disabled': { ok: true, detail: `disabled services = {\n\t"${paths.label}" => disabled\n}` },
      'launchctl print ': { ok: false },
    });
    expect(serviceDriverFor('darwin')!.status(paths, false)).toMatchObject({ active: false, enabled: false });
    recordCommands({
      'launchctl print-disabled': { ok: true, detail: `disabled services = {\n\t"${paths.label}" => enabled\n}` },
    });
    expect(serviceDriverFor('darwin')!.status(paths, false)).toMatchObject({ active: true, enabled: true });
    expect(uid).toBeGreaterThanOrEqual(0);
  });

  test('systemd: pause is disable --now; resume is enable --now', () => {
    const calls = recordCommands();
    serviceDriverFor('linux')!.pause(paths, true);
    serviceDriverFor('linux')!.resume(paths, true);
    expect(calls).toEqual([
      `systemctl --user disable --now ${paths.label}.service`,
      `systemctl --user enable --now ${paths.label}.service`,
    ]);
  });

  test('windows: pause disables and ends the task; resume enables and runs it', () => {
    const calls = recordCommands();
    serviceDriverFor('win32')!.pause(paths, true);
    serviceDriverFor('win32')!.resume(paths, true);
    expect(calls).toEqual([
      `schtasks.exe /Change /TN ${paths.label} /DISABLE`,
      `schtasks.exe /End /TN ${paths.label}`,
      `schtasks.exe /Change /TN ${paths.label} /ENABLE`,
      `schtasks.exe /Run /TN ${paths.label}`,
    ]);
  });
});

describe('install really starts the service', () => {
  const runner = { command: '/usr/bin/node', args: ['/opt/kortix/agent-cli.js', 'run', '--service'] };
  function tempPaths() {
    const dir = mkdtempSync(join(tmpdir(), 'agent-tunnel-install-'));
    const base = getServicePaths(dir);
    return {
      dir,
      paths: {
        ...base,
        launchdPlist: join(dir, 'job.plist'),
        systemdUnit: join(dir, 'job.service'),
        windowsScript: join(dir, 'job.ps1'),
      },
    };
  }

  test('launchd: a bootstrap launchd did not load is retried, and never reported active', () => {
    const { dir, paths } = tempPaths();
    pause.ms = () => {};
    try {
      const calls = recordCommands({ 'launchctl print': { ok: false }, 'launchctl bootstrap': { ok: false, detail: 'Bootstrap failed: 5: Input/output error' } });
      const outcome = serviceDriverFor('darwin')!.install(paths, runner);
      expect(outcome.active).toBeNull();
      expect(calls.filter((c) => c.startsWith('launchctl bootstrap'))).toHaveLength(3);

      recordCommands();
      expect(serviceDriverFor('darwin')!.install(paths, runner).active).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('systemd: install restarts a running unit so an update rolls the agent, and keeps it past logout', () => {
    const { dir, paths } = tempPaths();
    try {
      const calls = recordCommands({ 'loginctl show-user': { ok: true, detail: 'Linger=no' } });
      const outcome = serviceDriverFor('linux')!.install(paths, runner);
      expect(calls).toContain(`systemctl --user restart ${paths.label}.service`);
      expect(calls.some((c) => c.startsWith('loginctl enable-linger'))).toBe(true);
      expect(outcome.active).toBe(true);

      recordCommands({ 'loginctl': { ok: false, detail: 'Linger=no' } });
      expect(serviceDriverFor('linux')!.install(paths, runner).detail).toContain('stops when you log out');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('windows: the task is registered from XML without battery or 72 h limits, hidden, and restarted on install', () => {
    const { dir, paths } = tempPaths();
    try {
      const calls = recordCommands();
      serviceDriverFor('win32')!.install(paths, runner);
      expect(calls[0]).toBe(`schtasks.exe /Create /TN ${paths.label} /XML ${join(dir, 'job.xml')} /F`);
      expect(calls.slice(1)).toEqual([`schtasks.exe /End /TN ${paths.label}`, `schtasks.exe /Run /TN ${paths.label}`]);
      const xml = readFileSync(join(dir, 'job.xml')).toString('utf16le');
      expect(xml.charCodeAt(0)).toBe(0xfeff);
      expect(xml).toContain('<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>');
      expect(xml).toContain('<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>');
      expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
      expect(xml).toContain('-WindowStyle Hidden');
      expect(renderWindowsTaskXml(paths, 'DOMAIN\\a&b')).toContain('<UserId>DOMAIN\\a&amp;b</UserId>');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('windows: status reads the non-localized task state', () => {
    recordCommands({ 'powershell.exe': { ok: true, detail: 'Running\r\n' } });
    expect(serviceDriverFor('win32')!.status(paths, false)).toMatchObject({ active: true, enabled: true });
    recordCommands({ 'powershell.exe': { ok: true, detail: 'Disabled' } });
    expect(serviceDriverFor('win32')!.status(paths, false)).toMatchObject({ active: false, enabled: false });
  });
});
