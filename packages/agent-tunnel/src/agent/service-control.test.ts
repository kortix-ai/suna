import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';

import { type ServiceDriver, serviceDriverFor, supervisor } from './service-drivers';
import { getServicePaths, getServiceStatus, installService, runnerPartsFor, type ServicePaths } from './service';
import { acquireTunnelLease } from './service-control';

const realRun = supervisor.run;

let calls: string[] = [];
let home = '';
let paths: ServicePaths | undefined;
let driver: ServiceDriver | undefined;
let savedHomeEnv: string | undefined;

/** The supervisor verb that (re)starts the service, per platform. */
const startVerb = (): RegExp =>
  platform() === 'win32'
    ? /schtasks\.exe \/Run/
    : platform() === 'darwin'
      ? /launchctl (bootstrap|kickstart)/
      : /systemctl --user (restart|enable --now|start) /;

describe('tunnel lease', () => {
  beforeEach(() => {
    savedHomeEnv = process.env.AGENT_TUNNEL_HOME;
    home = mkdtempSync(join(tmpdir(), 'agent-tunnel-lease-'));
    // A non-default home derives a unique service label, so the unit file the
    // test writes under the real home directory never touches a real service.
    process.env.AGENT_TUNNEL_HOME = home;
    paths = getServicePaths();
    driver = serviceDriverFor(platform())!;
    calls = [];
    // ponytail: every supervisor command succeeds — the drivers' failure and
    // retry paths are service-drivers.test.ts's job.
    supervisor.run = (command, args) => {
      calls.push([command, ...args].join(' '));
      return { ok: true, detail: command === 'powershell.exe' ? 'Running' : '' };
    };
  });

  afterEach(() => {
    supervisor.run = realRun;
    if (driver && paths) rmSync(driver.unitPath(paths), { force: true });
    if (home) rmSync(home, { recursive: true, force: true });
    if (savedHomeEnv === undefined) delete process.env.AGENT_TUNNEL_HOME;
    else process.env.AGENT_TUNNEL_HOME = savedHomeEnv;
  });

  /** Installs a real unit for the temp home, then rewrites it with a stale runner. */
  function driftUnit() {
    installService();
    if (!driver || !paths) throw new Error('beforeEach did not initialise the fixture');
    // The same home, an old runner: what an app update that moved the bundle
    // leaves on disk.
    const staleRunner = runnerPartsFor('/defunct/agent-cli.js', { execPath: '/bin/sh' }, paths);
    writeFileSync(driver.unitPath(paths), driver.render(paths, staleRunner), { mode: 0o600 });
    calls.length = 0;
  }

  test('resume reinstalls a drifted unit before starting it', () => {
    driftUnit();
    expect(getServiceStatus().upToDate).toBe(false);

    const lease = acquireTunnelLease();
    expect(lease.serviceWasActive).toBe(true);
    lease.resumeService();

    // The resume went through the drift-safe path: the unit on disk is what an
    // install would write now, and the supervisor was asked to run the service.
    expect(getServiceStatus().upToDate).toBe(true);
    expect(calls.some((line) => startVerb().test(line))).toBe(true);
  });

  test('resume starts a fresh unit and acts at most once', () => {
    installService();
    calls.length = 0;
    expect(getServiceStatus().upToDate).toBe(true);

    const lease = acquireTunnelLease();
    lease.resumeService();
    const callsAfterFirstResume = calls.length;

    lease.resumeService();
    expect(calls.length).toBe(callsAfterFirstResume);
    expect(getServiceStatus().upToDate).toBe(true);
    expect(calls.some((line) => startVerb().test(line))).toBe(true);
  });
});
