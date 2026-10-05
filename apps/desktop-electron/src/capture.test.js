const { describe, expect, test } = require('bun:test');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const capture = require('./capture');

const UUID = '3f1c2b4a-5d6e-4f70-8a9b-0c1d2e3f4a5b';

/** A ChildProcess stand-in: emits 'exit' when killed or when the test says so. */
function fakeChild() {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = Math.floor(Math.random() * 1e5);
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
  };
  child.exit = (code, signal = null) => {
    child.exitCode = code;
    child.signalCode = signal;
    child.emit('exit', code, signal);
  };
  return child;
}

/** Timers you advance by hand. */
function fakeTimers() {
  let clock = 0;
  const pending = [];
  return {
    now: () => clock,
    timers: {
      setTimeout: (fn, ms) => {
        const t = { at: clock + ms, fn };
        pending.push(t);
        return t;
      },
      clearTimeout: (t) => {
        const i = pending.indexOf(t);
        if (i >= 0) pending.splice(i, 1);
      },
    },
    advance(ms) {
      clock += ms;
      for (const t of pending.filter((p) => p.at <= clock)) {
        pending.splice(pending.indexOf(t), 1);
        t.fn();
      }
    },
    pending: () => pending.map((t) => t.at - clock),
  };
}

describe('supervise', () => {
  test('restarts a crashing child at 2, 4, 8 … 60 s, and a healthy run resets the backoff', () => {
    const t = fakeTimers();
    const children = [];
    const sup = capture.supervise({ name: 'recorder', start: () => children[children.push(fakeChild()) - 1], now: t.now, timers: t.timers });
    sup.run();
    expect(children).toHaveLength(1);

    const delays = [];
    for (let i = 0; i < 7; i++) {
      children.at(-1).exit(1);
      delays.push(t.pending()[0]);
      t.advance(t.pending()[0]);
    }
    expect(delays).toEqual([2000, 4000, 8000, 16000, 32000, 60000, 60000]);
    expect(sup.state().crashLoop).toBe(true);

    // Ran a minute: the next crash restarts after 2 s again.
    t.advance(60_000);
    children.at(-1).exit(1);
    expect(t.pending()[0]).toBe(2000);
    expect(sup.state().crashLoop).toBe(false);
  });

  test('stop sends SIGTERM, then SIGKILL after 5 s if the child is still there, and never restarts it', () => {
    const t = fakeTimers();
    const children = [];
    const sup = capture.supervise({ name: 'actions', start: () => children[children.push(fakeChild()) - 1], now: t.now, timers: t.timers });
    sup.run();
    sup.stop();
    expect(children[0].signals).toEqual(['SIGTERM']);
    t.advance(5_000);
    expect(children[0].signals).toEqual(['SIGTERM', 'SIGKILL']);
    children[0].exit(null, 'SIGKILL');
    t.advance(120_000);
    expect(children).toHaveLength(1);
    expect(sup.state()).toMatchObject({ wanted: false, running: false });
  });

  test('a child that exits after SIGTERM is not killed again', () => {
    const t = fakeTimers();
    const child = fakeChild();
    const sup = capture.supervise({ name: 'recorder', start: () => child, now: t.now, timers: t.timers });
    sup.run();
    sup.stop();
    child.exit(0);
    t.advance(10_000);
    expect(child.signals).toEqual(['SIGTERM']);
  });

  test('a spawn that throws is retried with backoff and reported', () => {
    const t = fakeTimers();
    let attempts = 0;
    const sup = capture.supervise({
      name: 'recorder',
      start: () => {
        attempts++;
        throw new Error('ENOENT kortix-capture');
      },
      now: t.now,
      timers: t.timers,
    });
    sup.run();
    expect(attempts).toBe(1);
    expect(sup.state().lastExit.error).toBe('ENOENT kortix-capture');
    t.advance(2_000);
    expect(attempts).toBe(2);
  });

  test('restart (a new macOS grant) replaces the child once: no crash count, no backoff, no crash log', () => {
    const t = fakeTimers();
    const children = [];
    const warnings = [];
    const warn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      const sup = capture.supervise({ name: 'recorder', start: () => children[children.push(fakeChild()) - 1], now: t.now, timers: t.timers });
      sup.run();
      sup.restart();
      sup.restart(); // a second request while the first is in flight changes nothing
      expect(children[0].signals).toEqual(['SIGTERM']);
      children[0].exit(0);
      expect(children).toHaveLength(2);
      expect(t.pending()).toEqual([]);
      expect(sup.state()).toMatchObject({ wanted: true, running: true, crashLoop: false });
      expect(warnings).toEqual([]);
      // A restart of a stopped supervisor starts nothing.
      sup.stop();
      children[1].exit(0);
      sup.restart();
      expect(children).toHaveLength(2);
    } finally {
      console.warn = warn;
    }
  });

  test('run twice starts one child', () => {
    let starts = 0;
    const sup = capture.supervise({ name: 'r', start: () => (starts++, fakeChild()) });
    sup.run();
    sup.run();
    expect(starts).toBe(1);
  });
});

describe('desiredChildren', () => {
  const base = { available: true, desktop: { on: true, actions: true }, signedIn: true, signInRequired: false, policy: null };
  test('Capture on and signed in: the recorder and the action service run', () => {
    expect(capture.desiredChildren(base)).toEqual({ recorder: true, actions: true });
  });
  test('the Actions switch off, or a policy without actions: only the recorder', () => {
    expect(capture.desiredChildren({ ...base, desktop: { on: true, actions: false } })).toEqual({ recorder: true, actions: false });
    expect(capture.desiredChildren({ ...base, policy: { layers: { actions: false } } })).toEqual({ recorder: true, actions: false });
  });
  test('off, signed out, refused (revoked / project flag off) or no engine: nothing runs', () => {
    const none = { recorder: false, actions: false };
    expect(capture.desiredChildren({ ...base, desktop: { on: false, actions: true } })).toEqual(none);
    expect(capture.desiredChildren({ ...base, signedIn: false })).toEqual(none);
    expect(capture.desiredChildren({ ...base, signInRequired: true })).toEqual(none);
    expect(capture.desiredChildren({ ...base, available: false })).toEqual(none);
  });
});

describe('sign-in', () => {
  const stderr = 'Approve this computer in your browser:\n  http://localhost:3000/capture/authorize?user_code=ABCD-1234\nCode: ABCD-1234\n';

  test('parseSignInChallenge reads the code and URL the engine prints, and nothing before both exist', () => {
    expect(capture.parseSignInChallenge(stderr)).toEqual({
      userCode: 'ABCD-1234',
      verificationUrl: 'http://localhost:3000/capture/authorize?user_code=ABCD-1234',
    });
    expect(capture.parseSignInChallenge('Approve this computer in your browser:\n')).toBeNull();
  });

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

  test('runs sync setup against the issuer without a browser, hands over the code, then resolves with the device', async () => {
    const { spawnFn, calls } = fakeSpawn((child) => {
      child.stderr.emit('data', stderr.slice(0, 40));
      child.stderr.emit('data', stderr.slice(40));
      child.stdout.emit('data', JSON.stringify({ ok: true, device_id: 'dev1', prefix: `orgs/${UUID}` }));
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
    expect(calls[0].args).toEqual(['--json', 'sync', 'setup', '--provider', 'kortix', '--issuer', 'http://localhost:8008', '--no-browser']);
    expect(calls[0].options.env.KORTIX_CAPTURE_DIR).toBe('/lib');
    expect(challenges).toEqual([{ userCode: 'ABCD-1234', verificationUrl: 'http://localhost:3000/capture/authorize?user_code=ABCD-1234' }]);
    expect(result).toEqual({ ok: true, deviceId: 'dev1', prefix: `orgs/${UUID}` });
  });

  test('a denied or expired sign-in resolves with the engine error line', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      child.stderr.emit('data', `${stderr}Error: the sign-in was denied\n`);
      child.emit('close', 1);
    });
    const result = await capture.signIn({ paths: { capture: 'x' }, env: {}, issuer: 'i', spawnFn });
    expect(result).toEqual({ ok: false, error: 'the sign-in was denied' });
  });

  test('an engine that dies after printing the code reports its exit, never the code line', async () => {
    const { spawnFn } = fakeSpawn((child) => {
      child.stderr.emit('data', stderr);
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

  test('desktop.json: defaults, round trip, mode 0600', () => {
    const lib = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-desktop-'));
    expect(capture.readDesktop(lib)).toEqual({ on: false, actions: true });
    capture.writeDesktop(lib, { on: true, actions: false });
    expect(capture.readDesktop(lib)).toEqual({ on: true, actions: false });
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
    expect(labels(view)).toEqual(['Recording · Screen, Actions', 'Notice: Recorded for the support team', 'Pause for 1 hour', 'Open Capture…', 'Show logs']);
    expect(capture.captureTrayItems(view, actions).find((i) => i.id === 'capture-open').click).toBe(actions.open);
    expect(capture.captureKeepsRunning(view)).toBe(true);
    expect(labels({ ...view, state: 'paused' })).toContain('Resume recording');
    const refused = { ...view, signedIn: false, signInRequired: true, state: 'signInRequired' };
    expect(labels(refused)).toEqual(['Sign in again', 'Notice: Recorded for the support team', 'Sign in again…', 'Show logs']);
    expect(capture.captureKeepsRunning(refused)).toBe(false);
    // Switched off, or stopped outside the app: nothing keeps recording after Quit, no pause.
    expect(capture.captureKeepsRunning({ ...view, on: false, state: 'off' })).toBe(false);
    expect(capture.captureKeepsRunning({ ...view, state: 'stopped' })).toBe(false);
    expect(labels({ ...view, state: 'stopped' })).toEqual(['Stopped', 'Notice: Recorded for the support team', 'Open Capture…', 'Show logs']);
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

test('GUARD ends its child when the app side closes stdin (no orphaned action recorder)', async () => {
  const guard = spawn(process.execPath, ['-e', capture.GUARD, '/bin/sleep', '30'], { stdio: ['pipe', 'ignore', 'inherit'] });
  await new Promise((resolve) => setTimeout(resolve, 300));
  const sleeper = (await new Promise((resolve) => {
    const ps = spawn('pgrep', ['-P', String(guard.pid)]);
    let out = '';
    ps.stdout.on('data', (d) => (out += d));
    ps.on('close', () => resolve(out.trim()));
  }));
  expect(sleeper).toMatch(/^\d+$/);
  const exited = new Promise((resolve) => guard.on('exit', resolve));
  guard.stdin.end();
  await exited;
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(() => process.kill(Number(sleeper), 0)).toThrow();
});
