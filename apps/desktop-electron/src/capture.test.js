const { describe, expect, test } = require('bun:test');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const capture = require('./capture');

const UUID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

describe('sign-in', () => {
  const challenge = { event: 'challenge', user_code: 'ABCD-1234', verification_uri_complete: 'http://localhost:3000/capture/authorize?user_code=ABCD-1234' };

  function fakeSpawn(script) {
    const calls = [];
    const spawnFn = (file, args, options) => {
      calls.push({ file, args, options });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      queueMicrotask(() => script(child));
      return child;
    };
    return { spawnFn, calls };
  }

  test('runs `login --json` against the issuer, hands over the code from its challenge line, then resolves with the device', async () => {
    const lines = `${JSON.stringify(challenge)}\n${JSON.stringify({ event: 'signed_in', ok: true, device_id: 'dev1', prefix: `orgs/${UUID}` })}\n`;
    const { spawnFn, calls } = fakeSpawn((child) => {
      child.stdout.emit('data', lines.slice(0, 30));
      child.stdout.emit('data', lines.slice(30));
      child.emit('close', 0);
    });
    const challenges = [];
    const result = await capture.signIn({
      paths: { capture: '/engine/kortix-capture' },
      env: { KORTIX_CAPTURE_DIR: '/lib' },
      issuer: 'http://localhost:8008',
      onChallenge: (c) => challenges.push(c),
      spawnFn,
    });
    expect(calls[0].file).toBe('/engine/kortix-capture');
    expect(calls[0].args).toEqual(['--json', 'login', '--issuer', 'http://localhost:8008', '--no-browser']);
    expect(calls[0].options.env.KORTIX_CAPTURE_DIR).toBe('/lib');
    expect(challenges).toEqual([{ userCode: 'ABCD-1234', verificationUrl: 'http://localhost:3000/capture/authorize?user_code=ABCD-1234' }]);
    expect(result).toEqual({ ok: true, deviceId: 'dev1', prefix: `orgs/${UUID}` });
  });

  test('a denied or expired sign-in resolves with the engine error line', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      child.stdout.emit('data', `${JSON.stringify(challenge)}\n`);
      child.stderr.emit('data', 'Error: the sign-in was denied\n');
      child.emit('close', 1);
    });
    const result = await capture.signIn({ paths: { capture: 'x' }, env: {}, issuer: 'i', spawnFn });
    expect(result).toEqual({ ok: false, error: 'the sign-in was denied' });
  });

  test('an engine that dies after printing the code reports its exit', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      child.stdout.emit('data', `${JSON.stringify(challenge)}\n`);
      child.emit('close', null);
    });
    expect(await capture.signIn({ paths: { capture: 'x' }, env: {}, issuer: 'i', spawnFn })).toEqual({ ok: false, error: 'sign-in exited with code null' });
  });

  test('an aborted sign-in resolves cancelled', async () => {
    const controller = new AbortController();
    const { spawnFn } = fakeSpawn((child) => {
      controller.abort();
      child.emit('close', null);
    });
    expect(await capture.signIn({ paths: { capture: 'x' }, env: {}, issuer: 'i', signal: controller.signal, spawnFn })).toEqual({
      ok: false,
      error: 'cancelled',
    });
  });
});

describe('the CLI-owned service', () => {
  test('the app is the host: the OS starts this binary as Node with the shim, which runs the engine', () => {
    const args = capture.serviceHostArgs({ host: '/Applications/Kortix.app/Contents/MacOS/Kortix', env: { KORTIX_CONFIG: '/lib/engine-config.yaml', LOCAL_PORT: '0', PATH: '/usr/bin', KORTIX_CAPTURE_DIR: '/lib' } });
    expect(args).toEqual([
      '--host', '/Applications/Kortix.app/Contents/MacOS/Kortix',
      '--host-arg', '-e',
      '--host-arg', capture.SERVICE_SHIM,
      '--host-env', 'ELECTRON_RUN_AS_NODE=1',
      '--host-env', 'KORTIX_CONFIG=/lib/engine-config.yaml',
      '--host-env', 'LOCAL_PORT=0',
    ]);
    const named = capture.serviceHostArgs({ host: '/Applications/Kortix.app/Contents/MacOS/Kortix', bundleId: 'com.kortix.app', env: {} });
    expect(named.slice(-2)).toEqual(['--host-bundle-id', 'com.kortix.app']);
  });

  test('the bundle id comes from the Info.plist next to the app binary, so Login Items names the app', () => {
    const read = (plist) => (plist === '/Applications/Kortix.app/Contents/Info.plist' ? 'com.kortix.app\n' : '');
    expect(capture.bundleIdOf('/Applications/Kortix.app/Contents/MacOS/Kortix', read)).toBe('com.kortix.app');
    expect(capture.bundleIdOf('/usr/local/bin/node', read)).toBe(null);
    expect(capture.bundleIdOf('/Applications/Kortix.app/Contents/MacOS/Kortix', () => { throw new Error('no plist'); })).toBe(null);
  });

  test('the service the app installed before the CLI owned it is removed once', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-legacy-home-'));
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-legacy-lib-'));
    const label = `ai.kortix.desktop.capture.${capture.sha8(path.resolve(lib))}`;
    const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>');
    const calls = [];
    const run = (program, args) => calls.push([program, ...args].join(' '));
    expect(capture.removeLegacyService({ library: lib, platform: 'darwin', home, uid: 501, run })).toBe(true);
    expect(calls).toEqual([`launchctl bootout gui/501/${label}`]);
    expect(fs.existsSync(plist)).toBe(false);
    expect(capture.removeLegacyService({ library: lib, platform: 'darwin', home, uid: 501, run })).toBe(false);
    expect(calls).toHaveLength(1);
  });

  test('the shim runs the engine as its child, passes its exit code on, and forwards SIGTERM', async () => {
    const run = (args) =>
      new Promise((resolve) => {
        const shim = spawn(process.execPath, ['-e', capture.SERVICE_SHIM, ...args], { stdio: 'ignore' });
        shim.on('exit', (code, signal) => resolve({ code, signal, pid: shim.pid }));
        if (args[0] === '/bin/sleep') setTimeout(() => shim.kill('SIGTERM'), 300);
      });
    expect((await run(['/bin/sh', '-c', 'exit 7'])).code).toBe(7);
    const stopped = await run(['/bin/sleep', '30']);
    expect(stopped.code === 1 || stopped.signal === 'SIGTERM' || stopped.code === 143).toBe(true);
  });

  test('`service status --json` maps to the page\'s service view; the heartbeat to its children', () => {
    const cli = { installed: true, active: true, enabled: false, up_to_date: false, heartbeat: { running: true, recorder: { running: true, pid: 9, crashes: 5, last_exit: 'exit status: 1' }, actions: { running: false, crashes: 0, last_exit: null } } };
    expect(capture.serviceFromCli(cli)).toEqual({ installed: true, active: true, enabled: false, upToDate: false, heartbeat: cli.heartbeat });
    expect(capture.childrenFromHeartbeat(cli.heartbeat)).toEqual({
      recorder: { running: true, crashLoop: true, lastExit: { error: 'exit status: 1' } },
      actions: { running: false, crashLoop: false, lastExit: null },
    });
    expect(capture.childrenFromHeartbeat({ running: false })).toEqual({ recorder: { running: false, crashLoop: false, lastExit: null }, actions: { running: false, crashLoop: false, lastExit: null } });
  });
});

describe('paths and environment', () => {
  test('the issuer is the backend without /v1', () => {
    expect(capture.issuerFromBackend('https://api.kortix.com/v1')).toBe('https://api.kortix.com');
    expect(capture.issuerFromBackend('http://localhost:8008/v1/')).toBe('http://localhost:8008');
    expect(capture.issuerFromBackend('https://example.com/kortix/v1')).toBe('https://example.com/kortix');
  });

  test('the account (the Capture tenant) comes from the prefix the issuer returned', () => {
    expect(capture.accountFromPrefix(`orgs/${UUID}`)).toBe(UUID);
    expect(capture.accountFromPrefix(`orgs/${UUID}/`)).toBe(UUID);
    // The retired project layout is not an account prefix.
    expect(capture.accountFromPrefix(`orgs/${UUID}/projects/${UUID}`)).toBeNull();
    expect(capture.accountFromPrefix('kortix-capture')).toBeNull();
    expect(capture.accountFromPrefix(null)).toBeNull();
  });

  test('one library per backend; the engine env points every part at it and never at the engine tray', () => {
    const a = capture.libraryDir('/ud', 'https://api.kortix.com');
    expect(a).toMatch(/^\/ud\/capture\/[0-9a-f]{8}$/);
    expect(capture.libraryDir('/ud', 'http://localhost:8008')).not.toBe(a);
    const env = capture.engineEnv({ library: a, paths: capture.enginePaths('/e', 'darwin'), base: { PATH: '/bin' } });
    expect(env).toMatchObject({
      PATH: '/bin',
      KORTIX_CAPTURE_DIR: a,
      KORTIX_CAPTURE_ENGINE: '/e/kortix-capture-engine',
      KORTIX_CONFIG: path.join(a, 'engine-config.yaml'),
      KORTIX_TRAY_AUTO_LAUNCH: '0',
      LOCAL_PORT: '0',
      KORTIX_CAPTURE_KEY_STORE: 'file',
    });
  });

  test('the engine config turns the engine self-update off', () => {
    const yaml = capture.engineConfigYaml('/lib');
    expect(yaml).toContain('updates:\n  public_key: ""');
    expect(yaml).toContain('directory: "/lib/recordings"');
  });

  test('engine dir: the override, Resources/capture when packaged, the staged vendor dir in dev', () => {
    expect(capture.engineDir({ isPackaged: true, resourcesPath: '/R', env: { KORTIX_CAPTURE_ENGINE_DIR: '/local' } })).toBe('/local');
    expect(capture.engineDir({ isPackaged: true, resourcesPath: '/R', env: {} })).toBe('/R/capture');
    expect(capture.engineDir({ isPackaged: false, env: {}, platform: 'darwin' })).toMatch(/vendor\/capture\/darwin$/);
    expect(capture.enginePaths('/R/capture', 'win32').backend).toBe(path.join('/R/capture', 'kortix-backend.exe'));
  });

  test('the shipped files never include the engine tray', () => {
    for (const platform of ['darwin', 'win32', 'linux']) {
      expect(capture.engineFiles(platform).some((f) => f.startsWith('kortix-tray'))).toBe(false);
    }
  });

  test('desktop.json: defaults, round trip, mode 0600; Actions is the account policy, not a switch here', () => {
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-desktop-'));
    expect(capture.readDesktop(lib)).toEqual({ on: false });
    capture.writeDesktop(lib, { on: true, actions: false });
    expect(capture.readDesktop(lib)).toEqual({ on: true });
    expect((fs.statSync(path.join(lib, 'desktop.json')).mode & 0o777).toString(8)).toBe('600');
  });
});

describe('status and tray', () => {
  const sync = {
    kortix: { signed_in: true, sign_in_required: false, prefix: `orgs/${UUID}`, device_id: 'dev1', member_email: null },
    policy: { source: `orgs/${UUID}/policy.json`, fetched_at_ms: 1, policy: { layers: { audio: false }, notice: 'Recorded for the support team', recording: { paused: false } } },
    state: { state: 'ok', pending: 2, last_upload_ms: 5, last_error: null },
  };
  const status = { effective_state: 'recording', recorder_running: true, inactive_reason: null, recording_enabled: true, audio_enabled: false };
  const running = { recorder: { running: true, crashLoop: false }, actions: { running: true } };

  test('a recording device: state, project from the prefix, layers, policy, sync, permissions', () => {
    const view = capture.captureStatusFrom({
      available: true,
      desktop: { on: true, actions: true },
      status,
      sync,
      permissions: { screen: true, accessibility: false, microphone: 'granted' },
      children: running,
    });
    expect(view).toMatchObject({
      available: true,
      on: true,
      signedIn: true,
      state: 'recording',
      accountId: UUID,
      deviceId: 'dev1',
      layers: { screen: true, actions: true, audio: false },
      policy: { layers: { screen: true, actions: true, audio: false }, notice: 'Recorded for the support team', paused: false },
      permissions: { screen: true, accessibility: false, microphone: true },
      sync: { state: 'ok', pending: 2, lastUploadMs: 5, error: null },
    });
    expect(capture.captureLabel(view)).toBe('Recording · Screen, Actions');
    const noActions = { ...sync, policy: { ...sync.policy, policy: { ...sync.policy.policy, layers: { actions: false } } } };
    expect(capture.captureStatusFrom({ available: true, desktop: { on: true }, status, sync: noActions, children: running }).layers.actions).toBe(false);
  });

  test('refused, signed out, off, crashed: the state says which', () => {
    const at = (over) => capture.captureStatusFrom({ available: true, desktop: { on: true, actions: true }, status, sync, children: running, ...over }).state;
    expect(at({ sync: { ...sync, kortix: { ...sync.kortix, signed_in: false, sign_in_required: true } } })).toBe('signInRequired');
    expect(at({ sync: { ...sync, kortix: {} } })).toBe('signedOut');
    expect(at({ desktop: { on: false, actions: true } })).toBe('off');
    expect(at({ children: { recorder: { running: false, crashLoop: true } } })).toBe('crashed');
    expect(at({ children: { recorder: { running: false, crashLoop: false } } })).toBe('starting');
    expect(at({ status: { ...status, recorder_running: false, effective_state: 'not_running' } })).toBe('starting');
    // On, but the service was stopped outside the app (launchctl disable, unit removed): it says so and waits for a person.
    expect(at({ children: { recorder: { running: false } }, serviceStopped: true })).toBe('stopped');
    expect(at({ desktop: { on: false, actions: true }, serviceStopped: true })).toBe('off');
  });

  test('Input Monitoring reaches the page only from an engine that reports it', () => {
    const at = (permissions) => capture.captureStatusFrom({ available: true, desktop: { on: true, actions: true }, status, sync, permissions, children: running }).permissions;
    expect(at({ screen: true, accessibility: true, microphone: 'not_determined' })).toEqual({ screen: true, accessibility: true, microphone: false });
    expect(at({ screen: true, accessibility: true, microphone: 'granted', input_monitoring: false })).toEqual({
      screen: true,
      accessibility: true,
      microphone: true,
      inputMonitoring: false,
    });
    expect(capture.grantedPermissions({ input_monitoring: true, screen: false })).toEqual(['input_monitoring']);
  });

  test('no engine in this build: available false with the reason', () => {
    expect(capture.captureStatusFrom({ available: false, error: 'no engine' })).toEqual({ available: false, error: 'no engine' });
  });

  test('Capture\'s own tray: nothing until set up; status, notice, pause, Open Capture, logs', () => {
    const actions = { pause() {}, resume() {}, open() {}, logs() {} };
    expect(capture.captureTrayItems({ available: true, signedIn: false, signInRequired: false }, actions)).toEqual([]);
    expect(capture.captureTrayItems({ available: false }, actions)).toEqual([]);
    const view = capture.captureStatusFrom({ available: true, desktop: { on: true, actions: true }, status, sync, children: running });
    const labels = (v) => capture.captureTrayItems(v, actions).filter((i) => i.type !== 'separator').map((i) => i.label);
    expect(labels(view)).toEqual(['Recording · Screen, Actions', 'Notice: Recorded for the support team', 'Pause for 1 hour', 'Open Kortix Capture…', 'Show logs']);
    expect(capture.captureTrayItems(view, actions).find((i) => i.id === 'capture-open').click).toBe(actions.open);
    expect(capture.captureKeepsRunning(view)).toBe(true);
    expect(labels({ ...view, state: 'paused' })).toContain('Resume recording');
    const refused = { ...view, signedIn: false, signInRequired: true, state: 'signInRequired' };
    expect(labels(refused)).toEqual(['Signed out', 'Notice: Recorded for the support team', 'Sign in again…', 'Show logs']);
    expect(capture.captureKeepsRunning(refused)).toBe(false);
    // Switched off, or stopped outside the app: nothing keeps recording after Quit, no pause.
    expect(capture.captureKeepsRunning({ ...view, on: false, state: 'off' })).toBe(false);
    expect(capture.captureKeepsRunning({ ...view, state: 'stopped' })).toBe(false);
    expect(labels({ ...view, state: 'stopped' })).toEqual(['Stopped', 'Notice: Recorded for the support team', 'Open Kortix Capture…', 'Show logs']);
  });

  test('backendFromRuntimeConfig: the instance publishes its backend; https, or http on localhost only', () => {
    const script = (url) => `window.__KORTIX_RUNTIME_CONFIG=${JSON.stringify({ BACKEND_URL: url })};`;
    expect(capture.backendFromRuntimeConfig(script('https://api.example.test/v1/'), 'https://app.example.test')).toEqual({ ok: true, url: 'https://api.example.test/v1' });
    expect(capture.backendFromRuntimeConfig(script('/v1'), 'http://localhost:3000')).toEqual({ ok: true, url: 'http://localhost:3000/v1' });
    expect(capture.backendFromRuntimeConfig(script('http://api.example.test/v1'), 'https://app.example.test').ok).toBe(false);
    expect(capture.backendFromRuntimeConfig(script('https://u:p@api.example.test/v1'), 'https://app.example.test').ok).toBe(false);
    expect(capture.backendFromRuntimeConfig('', 'https://app.example.test').ok).toBe(false);
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

test('Capture shares no module with the computer agent', () => {
  for (const file of ['capture.js', 'capture-host.js', 'capture-tray.js']) {
    const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
    expect(source).not.toMatch(/require\(['"]\.\/computer(-tray)?['"]\)|agent-tunnel\/src/);
  }
});
