// Kortix Capture in the desktop app: the kortix:invoke capture_* commands and
// the engine's processes. Rules and parsing live in capture.js (unit-tested);
// this file is the Electron side effects. The tray is computer-tray.js: it
// asks this module for its Capture items.

const { app, shell } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const capture = require('./capture');

/** How often a running device asks its issuer whether it may still record (revoked, project flag off). */
const PROBE_EVERY_MS = 10 * 60_000;
const REFRESH_EVERY_MS = 30_000;
/** The page polls capture_status; within this age the cached answer is reused. */
const FRESH_MS = 2_000;

/**
 * @param {{
 *   backend: () => Promise<{ backendUrl: string }>,
 *   onChange: () => void,
 *   openSettings: () => void,
 * }} deps
 */
function setupCapture(deps) {
  const userData = app.getPath('userData');
  const dir = capture.engineDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const paths = capture.enginePaths(dir);

  /* ─── Engine and library ─────────────────────────────────────────────── */

  /** @type {Promise<{ ok: boolean, version?: string, error?: string }> | null} */
  let availability = null;
  function engineAvailable() {
    availability ??= fs.existsSync(paths.capture)
      ? capture.runEngine(paths.capture, ['version'], { timeoutMs: 10_000 }).then((r) =>
          r.code === 0
            ? { ok: true, version: r.stdout.trim() }
            : { ok: false, error: `The Capture engine does not run on this computer: ${capture.lastError(r.stderr, `exit ${r.code}`)}` },
        )
      : Promise.resolve({ ok: false, error: 'Kortix Capture is not part of this build.' });
    return availability;
  }

  /** @type {{ backendUrl: string, library: string, issuer: string, env: NodeJS.ProcessEnv } | null} */
  let ctx = null;

  async function context() {
    const { backendUrl } = await deps.backend();
    if (ctx?.backendUrl === backendUrl) return ctx;
    // Another instance: its library, its sign-in, its children.
    if (ctx) stopChildren();
    const library = capture.libraryDir(userData, new URL(backendUrl).origin);
    fs.mkdirSync(path.join(library, 'logs'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(library, 'engine-config.yaml'), capture.engineConfigYaml(library));
    ctx = { backendUrl, library, issuer: capture.issuerFromBackend(backendUrl), env: capture.engineEnv({ library, paths }) };
    return ctx;
  }

  const engine = async (args, timeoutMs) => capture.runEngine(paths.capture, args, { env: (await context()).env, timeoutMs });
  const engineJson = async (args) => capture.engineJson(paths.capture, args, { env: (await context()).env });

  /* ─── Children ───────────────────────────────────────────────────────── */

  function logFd(name) {
    return fs.openSync(path.join(ctx.library, 'logs', `${name}.log`), 'a', 0o600);
  }

  function spawnLogged(name, file, args, env = ctx.env) {
    const fd = logFd(name);
    try {
      // stdin is a pipe this app holds and never writes: it closes when the app ends.
      return spawn(file, args, { env, stdio: ['pipe', fd, fd], windowsHide: true });
    } finally {
      fs.closeSync(fd);
    }
  }

  // The recorder holds stdin (`--supervised`): it ends when this app ends.
  const recorder = capture.supervise({
    name: 'recorder',
    start: () => spawnLogged('recorder', paths.capture, ['record', '--supervised']),
    onChange: () => deps.onChange(),
  });
  // The action service under the stdin guard (capture.GUARD), run by this
  // app's own binary as Node.
  const actions = capture.supervise({
    name: 'actions',
    start: () =>
      spawnLogged('actions', process.execPath, ['-e', capture.GUARD, paths.backend, '--service'], {
        ...ctx.env,
        ELECTRON_RUN_AS_NODE: '1',
      }),
    onChange: () => deps.onChange(),
  });

  function stopChildren() {
    recorder.stop();
    actions.stop();
  }

  /* ─── Status ─────────────────────────────────────────────────────────── */

  /** @type {string[] | null} */
  let lastGranted = null;
  let view = capture.captureStatusFrom({ available: false, error: 'Kortix Capture is starting.' });
  let viewAt = 0;
  let refreshing = null;

  async function readView() {
    const engineState = await engineAvailable();
    if (!engineState.ok) return capture.captureStatusFrom({ available: false, error: engineState.error });
    const { library } = await context();
    const desktop = capture.readDesktop(library);
    const [status, sync, permissions] = await Promise.all([
      engineJson(['status']).catch(() => null),
      engineJson(['sync', 'status']).catch(() => null),
      process.platform === 'darwin' ? engineJson(['permissions']).catch(() => null) : null,
    ]);
    const signedIn = sync?.kortix?.signed_in === true;
    const signInRequired = sync?.kortix?.sign_in_required === true;
    const want = capture.desiredChildren({ available: true, desktop, signedIn, signInRequired, policy: capture.policyOf(sync) });
    // macOS applies a new grant only to a process started after it: restart
    // the recorder once when the person allows another permission.
    const granted = capture.grantedPermissions(permissions);
    if (lastGranted !== null && granted.some((key) => !lastGranted.includes(key)) && recorder.state().running) recorder.stop();
    lastGranted = granted;
    if (want.recorder) recorder.run();
    else recorder.stop();
    if (want.actions) actions.run();
    else actions.stop();
    return {
      ...capture.captureStatusFrom({
        available: true,
        desktop,
        status,
        sync,
        permissions,
        children: { recorder: recorder.state(), actions: actions.state() },
      }),
      version: engineState.version,
    };
  }

  function refresh() {
    refreshing ??= readView()
      .catch((error) => capture.captureStatusFrom({ available: false, error: error instanceof Error ? error.message : String(error) }))
      .then((next) => {
        view = next;
        viewAt = Date.now();
        deps.onChange();
        return next;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  const current = () => (Date.now() - viewAt < FRESH_MS ? view : refresh());

  /* ─── Commands ───────────────────────────────────────────────────────── */

  function setLoginItem() {
    // The app's one login item: Capture records only while Kortix runs.
    if (process.platform === 'darwin' || process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: true });
  }

  /** @type {{ controller: AbortController, challenge: Promise<object | null>, done: Promise<object> } | null} */
  let pending = null;

  /**
   * Starts the engine's device sign-in and resolves with its code as soon as
   * the issuer gave one: `{ ok, userCode, verificationUrl }`. The page then
   * approves the code with the person's own session (SDK
   * `approveCaptureDeviceGrant`) and calls `capture_sign_in_finish`.
   */
  async function signInStart() {
    const engineState = await engineAvailable();
    if (!engineState.ok) return { ok: false, error: engineState.error };
    if (!pending) {
      const { env, issuer } = await context();
      stopChildren();
      const controller = new AbortController();
      let resolveChallenge;
      const challenge = new Promise((resolve) => {
        resolveChallenge = resolve;
      });
      const done = capture
        .signIn({ paths, env, issuer, signal: controller.signal, onChallenge: resolveChallenge })
        .then(async (result) => {
          resolveChallenge(null);
          if (result.ok) {
            capture.writeDesktop(ctx.library, { ...capture.readDesktop(ctx.library), on: true });
            setLoginItem();
          }
          await refresh();
          return { ...result, status: view };
        })
        .finally(() => {
          pending = null;
        });
      pending = { controller, challenge, done };
    }
    const challenge = await pending.challenge;
    return challenge ? { ok: true, ...challenge } : pending ? pending.done : { ok: false, error: 'The sign-in ended.' };
  }

  async function set(args) {
    const { library } = await context();
    const desktop = capture.readDesktop(library);
    if (typeof args.on === 'boolean') {
      desktop.on = args.on;
      if (args.on) setLoginItem();
    }
    if (typeof args.actions === 'boolean') desktop.actions = args.actions;
    capture.writeDesktop(library, desktop);
    for (const [key, setting] of [['screen', 'recording_enabled'], ['audio', 'audio.enabled']]) {
      if (typeof args[key] !== 'boolean') continue;
      const result = await engine(['settings', setting, String(args[key])]);
      if (result.code !== 0) throw new Error(capture.lastError(result.stderr, `Could not change ${key}.`));
    }
    return refresh();
  }

  async function verb(args, what) {
    const result = await engine(args);
    if (result.code !== 0) throw new Error(capture.lastError(result.stderr, `Could not ${what}.`));
    return refresh();
  }

  async function signOut() {
    const { library } = await context();
    stopChildren();
    capture.writeDesktop(library, { ...capture.readDesktop(library), on: false });
    return verb(['sync', 'sign-out'], 'sign out of Capture');
  }

  async function openTimeline() {
    const { env } = await context();
    // Its own window, outside this app; it closes on its own.
    spawn(paths.capture, ['ui'], { env, detached: true, stdio: 'ignore' }).unref();
    return null;
  }

  async function invoke(cmd, args = {}) {
    switch (cmd) {
      case 'capture_status':
        return current();
      case 'capture_sign_in_start':
        return signInStart();
      case 'capture_sign_in_finish':
        return pending ? pending.done : { ok: false, error: 'No Capture sign-in is running.', status: await current() };
      case 'capture_sign_in_cancel':
        pending?.controller.abort();
        return null;
      case 'capture_set':
        return set(args);
      case 'capture_pause':
        return verb(['pause', '--for', `${Math.max(1, Math.min(24 * 60, Number(args.minutes) || 60))}m`], 'pause Capture');
      case 'capture_resume':
        return verb(['resume'], 'resume Capture');
      case 'capture_sign_out':
        return signOut();
      case 'capture_open_timeline':
        return openTimeline();
      case 'capture_open_permission': {
        const pane = capture.PERMISSION_PANES[args.permission];
        if (process.platform !== 'darwin' || !pane) throw new Error(`No settings pane for ${args.permission}`);
        await shell.openExternal(pane);
        return null;
      }
      case 'capture_open_logs': {
        const error = await shell.openPath(path.join((await context()).library, 'logs'));
        if (error) throw new Error(`Could not open the logs: ${error}`);
        return null;
      }
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  }

  const trayActions = {
    pause: () => void invoke('capture_pause', { minutes: 60 }).catch((e) => console.warn(`[kortix] capture pause: ${e}`)),
    resume: () => void invoke('capture_resume').catch((e) => console.warn(`[kortix] capture resume: ${e}`)),
    timeline: () => void openTimeline().catch((e) => console.warn(`[kortix] capture timeline: ${e}`)),
    settings: () => deps.openSettings(),
  };

  function start() {
    void refresh();
    setInterval(() => void refresh(), REFRESH_EVERY_MS);
    // The engine learns of a revoked device or a project with Capture off only
    // when it fetches credentials (up to an hour). A probe fetches them now.
    setInterval(() => {
      if (!recorder.state().running) return;
      void engine(['sync', 'test'], 60_000).then(() => refresh());
    }, PROBE_EVERY_MS);
  }

  return {
    start,
    invoke,
    trayItems: () => capture.captureTrayItems(view, trayActions),
    /** Keep the app in the tray while Capture records. */
    keepRunning: () => view.available === true && view.on && view.signedIn,
  };
}

module.exports = { setupCapture };
