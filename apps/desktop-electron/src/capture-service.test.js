// The Capture service: unit files per OS (the tunnel's drivers), the
// desktop app's reconcile policy, and the service process itself, run as a
// real child process against a fake engine (shell scripts).

const { afterEach, describe, expect, test } = require('bun:test');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const service = require('./capture-service');
const capture = require('./capture');
const drivers = require('../../../packages/agent-tunnel/src/agent/service-drivers');

const tmp = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `capture-service-${name}-`));
const opts = (home, platform) => ({
  library: path.join(home, 'lib'),
  engineDir: '/Applications/Kortix.app/Contents/Resources/capture',
  script: '/Applications/Kortix.app/Contents/Resources/capture-service/capture-service.js',
  execPath: '/Applications/Kortix.app/Contents/MacOS/Kortix',
  appImage: undefined,
  platform,
  home,
});

describe('unit files (the agent tunnel drivers, Capture label and logs)', () => {
  test('macOS: a valid LaunchAgent with its own label that runs the Kortix binary as Node', () => {
    const home = tmp('mac');
    const plist = service.control('render', opts(home, 'darwin'));
    const file = path.join(home, 'unit.plist');
    fs.writeFileSync(file, plist);
    expect(execFileSync('plutil', ['-lint', file]).toString()).toContain('OK');
    const label = service.servicePaths(path.join(home, 'lib'), home).label;
    expect(label).toMatch(/^ai\.kortix\.desktop\.capture\.[0-9a-f]{8}$/);
    expect(label).not.toContain('agent-tunnel');
    expect(plist).toContain(`<string>${label}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('ELECTRON_RUN_AS_NODE=&apos;1&apos;');
    expect(plist).toContain('/Applications/Kortix.app/Contents/MacOS/Kortix');
    expect(plist).toContain('capture-service.js&apos; &apos;run&apos;');
    expect(plist).toContain('logs/capture-service.out.log');
  });

  test('Linux: a systemd user unit that restarts the service', () => {
    const home = tmp('linux');
    const unit = service.control('render', opts(home, 'linux'));
    expect(unit).toContain('Description=Kortix Capture');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
    expect(unit).toContain('capture-service.out.log');
    expect(unit).toContain("KORTIX_CAPTURE_DIR=");
  });

  test('Windows: a PowerShell loop the Scheduled Task runs, and a task named for Capture', () => {
    const home = tmp('win');
    const ps1 = service.control('render', opts(home, 'win32'));
    expect(ps1).toContain("$env:ELECTRON_RUN_AS_NODE = '1'");
    expect(ps1).toContain("'run'");
    expect(ps1).toContain('while ($true)');
    const xml = drivers.renderWindowsTaskXml(service.servicePaths(path.join(home, 'lib'), home), 'user');
    expect(xml).toContain('<Description>Kortix Capture</Description>');
    expect(xml).toContain('<LogonTrigger>');
  });

  test('one service per library; the tunnel keeps its own label', () => {
    expect(service.servicePaths('/a').label).not.toBe(service.servicePaths('/b').label);
    expect(service.servicePaths('/a').label).toBe(service.servicePaths('/a/').label);
  });

  test('install writes the unit through the driver; status reports upToDate, and a moved app is out of date', () => {
    const home = tmp('install');
    const calls = [];
    const original = drivers.supervisor.run;
    drivers.supervisor.run = (command, args) => {
      calls.push([command, ...args].join(' '));
      return { ok: true, detail: '' };
    };
    try {
      const installed = service.control('install', opts(home, 'darwin'));
      expect(installed).toMatchObject({ installed: true, upToDate: true });
      expect(fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${installed.label}.plist`))).toBe(true);
      expect(calls.some((c) => c.startsWith('launchctl bootstrap'))).toBe(true);
      const moved = service.control('status', { ...opts(home, 'darwin'), execPath: '/Users/x/Downloads/Kortix.app/Contents/MacOS/Kortix' });
      expect(moved.upToDate).toBe(false);
      expect(service.control('uninstall', opts(home, 'darwin')).installed).toBe(false);
    } finally {
      drivers.supervisor.run = original;
    }
  });
});

describe('serviceAction (the desktop app as controller)', () => {
  const ok = { installed: true, enabled: true, upToDate: true, active: true, heartbeat: { running: true } };
  const on = { desktopOn: true, signedIn: true, signInRequired: false };
  test('an explicit action with Capture on: install when missing or out of date, resume when disabled, repair when not running', () => {
    const user = { ...on, explicit: true };
    expect(capture.serviceAction({ ...user, service: { installed: false } })).toBe('install');
    expect(capture.serviceAction({ ...user, service: { ...ok, upToDate: false } })).toBe('install');
    expect(capture.serviceAction({ ...user, service: { ...ok, enabled: false } })).toBe('resume');
    expect(capture.serviceAction({ ...user, service: { ...ok, active: false, heartbeat: { running: false } } })).toBe('repair');
    expect(capture.serviceAction({ ...user, service: ok })).toBeNull();
  });
  test('Capture off: the service is disabled (paused), not removed', () => {
    expect(capture.serviceAction({ ...on, desktopOn: false, service: ok })).toBe('pause');
    expect(capture.serviceAction({ ...on, desktopOn: false, service: { ...ok, enabled: false } })).toBeNull();
  });
  test('a passive check (launch, poll) never starts, resumes or reinstalls a service someone stopped', () => {
    const passive = { ...on, explicit: false };
    // Removed, disabled (launchctl disable / Pause), or not running: left alone.
    expect(capture.serviceAction({ ...passive, service: { installed: false } })).toBeNull();
    expect(capture.serviceAction({ ...passive, service: { ...ok, enabled: false } })).toBeNull();
    expect(capture.serviceAction({ ...passive, service: { ...ok, enabled: false, upToDate: false } })).toBeNull();
    expect(capture.serviceAction({ ...passive, service: { ...ok, active: false, heartbeat: { running: false } } })).toBeNull();
    // An app update or move rewrites an enabled service's unit.
    expect(capture.serviceAction({ ...passive, service: { ...ok, upToDate: false } })).toBe('install');
    // Stopping is always safe.
    expect(capture.serviceAction({ ...passive, desktopOn: false, service: ok })).toBe('pause');
    expect(capture.serviceAction({ ...passive, signedIn: false, service: ok })).toBe('uninstall');
  });
  test('the default is passive: only an explicit action resumes or repairs', () => {
    expect(capture.serviceAction({ ...on, service: { ...ok, enabled: false } })).toBeNull();
    expect(capture.serviceAction({ ...on, explicit: true, service: { ...ok, enabled: false } })).toBe('resume');
  });
  test('signed out: removed; refused (revoked, flag off): kept, so a new sign-in resumes', () => {
    expect(capture.serviceAction({ desktopOn: true, signedIn: false, signInRequired: false, service: ok })).toBe('uninstall');
    expect(capture.serviceAction({ desktopOn: true, signedIn: false, signInRequired: true, service: ok })).toBeNull();
  });
});

/* ─── The service process against a fake engine ───────────────────────── */

const FAKE_CAPTURE = `#!/bin/sh
# A fake kortix-capture. State comes from files the test writes.
case "$*" in
  *"sync status"*) cat "$KORTIX_CAPTURE_DIR/fake-sync.json"; exit 0 ;;
  *permissions*) echo '{"screen":true,"accessibility":true,"microphone":"granted"}'; exit 0 ;;
  *"sync test"*) exit 1 ;;
  *record*) echo $$ >> "$KORTIX_CAPTURE_DIR/recorder-pids"; while read line; do :; done; exit 0 ;;
esac
exit 0
`;
const FAKE_BACKEND = `#!/bin/sh
echo $$ >> "$KORTIX_CAPTURE_DIR/backend-pids"
exec sleep 600
`;

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const pids = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);
async function until(what, fn, ms = 30_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

let running = [];
afterEach(() => {
  for (const child of running) child.kill('SIGKILL');
  running = [];
});

function startService(library, engineDir) {
  const child = spawn(process.execPath, [path.join(__dirname, 'capture-service.js'), 'run'], {
    env: { ...process.env, KORTIX_CAPTURE_DIR: library, KORTIX_CAPTURE_ENGINE_DIR: engineDir, KORTIX_CAPTURE_SERVICE_TICK_MS: '300' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  running.push(child);
  return child;
}

test(
  'the service runs the recorder and the action service, restarts a killed recorder, stops on refusal and on Capture off, and ends its children on SIGTERM',
  async () => {
    const root = tmp('run');
    const library = path.join(root, 'lib');
    const engineDir = path.join(root, 'engine');
    fs.mkdirSync(library);
    fs.mkdirSync(engineDir);
    for (const [name, body] of [['kortix-capture', FAKE_CAPTURE], ['kortix-backend', FAKE_BACKEND], ['kortix-capture-engine', '#!/bin/sh\n']]) {
      fs.writeFileSync(path.join(engineDir, name), body, { mode: 0o755 });
    }
    const signedIn = { kortix: { signed_in: true, sign_in_required: false }, policy: null, state: { state: 'ok' } };
    fs.writeFileSync(path.join(library, 'fake-sync.json'), JSON.stringify(signedIn));
    capture.writeDesktop(library, { on: true, actions: true });

    const svc = startService(library, engineDir);
    const recorders = path.join(library, 'recorder-pids');
    const backends = path.join(library, 'backend-pids');
    const first = await until('recorder started', () => pids(recorders)[0]);
    await until('action service started', () => pids(backends)[0]);
    await until('heartbeat', () => service.readHeartbeat(library).running && service.readHeartbeat(library).recorder.running);

    // A crashed recorder comes back (2 s backoff).
    process.kill(first, 'SIGKILL');
    const second = await until('recorder restarted', () => pids(recorders).find((p) => p !== first && alive(p)), 30_000);
    expect(second).not.toBe(first);

    // A second service for the same library exits at once (the service manager runs one).
    const twin = startService(library, engineDir);
    expect(await new Promise((resolve) => twin.on('exit', resolve))).toBe(0);

    // The issuer refused the device (revoked, or Capture off for the project): nothing runs.
    fs.writeFileSync(path.join(library, 'fake-sync.json'), JSON.stringify({ ...signedIn, kortix: { signed_in: false, sign_in_required: true } }));
    await until('recorder stopped on refusal', () => !alive(second) && pids(backends).every((p) => !alive(p)));

    // Signed in again, then Capture off in the app: nothing runs, the service stays.
    fs.writeFileSync(path.join(library, 'fake-sync.json'), JSON.stringify(signedIn));
    const third = await until('recorder back after sign-in', () => pids(recorders).find((p) => alive(p)));
    capture.writeDesktop(library, { on: false, actions: true });
    await until('recorder stopped on Capture off', () => !alive(third));
    expect(alive(svc.pid)).toBe(true);

    // SIGTERM (launchctl bootout, systemctl stop): children end, the heartbeat goes.
    capture.writeDesktop(library, { on: true, actions: true });
    const fourth = await until('recorder running again', () => pids(recorders).find((p) => alive(p)));
    const backend = await until('backend running again', () => pids(backends).find((p) => alive(p)));
    svc.kill('SIGTERM');
    expect(await new Promise((resolve) => svc.on('exit', resolve))).toBe(0);
    await until('children gone', () => !alive(fourth) && !alive(backend), 30_000);
    expect(service.readHeartbeat(library).running).toBe(false);
  },
  120_000,
);
