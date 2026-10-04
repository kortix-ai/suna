// Kortix Capture in the desktop app: the kortix:invoke capture_* commands and
// the controller of the Capture service. The engine does not run inside this
// app: capture-service.js runs as an OS service (launchd, systemd, Task
// Scheduler) with this app's binary as Node and supervises it, so Capture
// keeps recording while the app is quit and across reboots. This file
// installs, pauses and removes that service, and reads the engine's and the
// service's status. Rules live in capture.js; the tray is computer-tray.js.

const { app, desktopCapturer, shell, systemPreferences } = require('electron');
const { execFileSync, spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const capture = require('./capture');
const { machineId } = require('./computer');

const REFRESH_EVERY_MS = 30_000;
/** The page polls capture_status; within this age the cached answer is reused. */
const FRESH_MS = 2_000;
/** A service that is installed but not running is reinstalled at most this often. */
const REPAIR_EVERY_MS = 5 * 60_000;
const SIGN_IN_MARKER = 'sign-in.pending';

/** Dev only: the service bundle from src (bun), like the computer agent's. */
function devServiceScript() {
  const root = path.join(__dirname, '..');
  const out = path.join(root, 'vendor', 'capture-service.js');
  execFileSync('bun', ['build', 'src/capture-service.js', '--target=node', '--format=cjs', '--outfile', out], { cwd: root, stdio: 'ignore' });
  return out;
}

/**
 * @param {{
 *   backend: () => Promise<{ backendUrl: string }>,
 *   onChange: () => void,
 *   openSettings: () => void,
 * }} deps
 */
function setupCapture(deps) {
  const userData = app.getPath('userData');
  const engineDir = capture.engineDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const paths = capture.enginePaths(engineDir);

  /** @type {string | null} */
  let script = null;
  function serviceScript() {
    script ??= app.isPackaged ? path.join(process.resourcesPath, 'capture-service', 'capture-service.js') : devServiceScript();
    return script;
  }

  /** A copy opened from a disk image or ~/Downloads would point the service at a path that disappears. */
  const runsFromTemporaryLocation = () => process.platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder();

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
    // Another instance: its own library, sign-in and service. The other
    // instance's service keeps running; it does not belong to this window.
    const library = capture.libraryDir(userData, new URL(backendUrl).origin);
    fs.mkdirSync(path.join(library, 'logs'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(library, 'engine-config.yaml'), capture.engineConfigYaml(library));
    ctx = { backendUrl, library, issuer: capture.issuerFromBackend(backendUrl), env: capture.engineEnv({ library, paths }) };
    return ctx;
  }

  const engine = async (args, timeoutMs) => capture.runEngine(paths.capture, args, { env: (await context()).env, timeoutMs });
  const engineJson = async (args) => capture.engineJson(paths.capture, args, { env: (await context()).env });

  /** One capture-service.js verb, run by this app's binary as Node. */
  async function service(verb) {
    const { library } = await context();
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1', KORTIX_CAPTURE_DIR: library, KORTIX_CAPTURE_ENGINE_DIR: engineDir };
    const result = await capture.runEngine(process.execPath, [serviceScript(), verb, '--json'], { env, timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(capture.lastError(result.stderr, `capture service ${verb} failed`));
    return JSON.parse(result.stdout);
  }

  /* ─── Status and the service ─────────────────────────────────────────── */

  let view = capture.captureStatusFrom({ available: false, error: 'Kortix Capture is starting.' });
  let viewAt = 0;
  let refreshing = null;
  let lastRepairAt = 0;
  /** @type {string | null | undefined} */
  let thisMachine;

  /** Brings the service in line with the person's switch and the sign-in. */
  async function reconcile(desktop, sync, current, { force = false } = {}) {
    const action = capture.serviceAction({
      desktopOn: desktop.on,
      signedIn: sync?.kortix?.signed_in === true,
      signInRequired: sync?.kortix?.sign_in_required === true,
      service: current,
    });
    if (!action) return current;
    if ((action === 'install' || action === 'repair') && runsFromTemporaryLocation()) {
      console.log('[kortix] not installing the Capture service: Kortix is not running from the Applications folder');
      return current;
    }
    if (action === 'repair' && !force && Date.now() - lastRepairAt < REPAIR_EVERY_MS) return current;
    if (action === 'repair') lastRepairAt = Date.now();
    console.log(`[kortix] capture service: ${action}`);
    return service(action === 'repair' ? 'install' : action);
  }

  async function readView({ force = false } = {}) {
    const engineState = await engineAvailable();
    if (!engineState.ok) return capture.captureStatusFrom({ available: false, error: engineState.error });
    const { library } = await context();
    const desktop = capture.readDesktop(library);
    const [status, sync, permissions, current] = await Promise.all([
      engineJson(['status']).catch(() => null),
      engineJson(['sync', 'status']).catch(() => null),
      process.platform === 'darwin' ? engineJson(['permissions']).catch(() => null) : null,
      service('status').catch((error) => ({ installed: false, error: error.message })),
    ]);
    const after = pending ? current : await reconcile(desktop, sync, current, { force }).catch((error) => ({ ...current, error: error.message }));
    const heartbeat = after.heartbeat?.running ? after.heartbeat : null;
    return {
      ...capture.captureStatusFrom({
        available: true,
        desktop,
        status,
        sync,
        permissions,
        children: { recorder: heartbeat?.recorder ?? { running: false }, actions: heartbeat?.actions ?? { running: false } },
      }),
      version: engineState.version,
      // The computer agent's id for this machine: the page sends it on approval.
      machineId: (thisMachine ??= machineId()),
      service: {
        installed: after.installed === true,
        enabled: after.enabled !== false,
        running: Boolean(heartbeat),
        upToDate: after.upToDate !== false,
        ...(after.error ? { error: after.error } : {}),
      },
    };
  }

  function refresh(options) {
    refreshing ??= readView(options)
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

  /** @type {{ controller: AbortController, challenge: Promise<object | null>, done: Promise<object> } | null} */
  let pending = null;

  /**
   * Starts the engine's device sign-in and resolves with its code as soon as
   * the issuer gave one: `{ ok, userCode, verificationUrl }`. The page then
   * approves the code with the person's own session (SDK
   * `approveCaptureDeviceGrant`) and calls `capture_sign_in_finish`. While it
   * runs, the service keeps the engine stopped (the sign-in marker).
   */
  async function signInStart() {
    const engineState = await engineAvailable();
    if (!engineState.ok) return { ok: false, error: engineState.error };
    if (!pending) {
      const { env, issuer, library } = await context();
      const marker = path.join(library, SIGN_IN_MARKER);
      fs.writeFileSync(marker, String(Date.now()));
      const controller = new AbortController();
      let resolveChallenge;
      const challenge = new Promise((resolve) => {
        resolveChallenge = resolve;
      });
      const done = capture
        .signIn({ paths, env, issuer, signal: controller.signal, onChallenge: resolveChallenge })
        .then(async (result) => {
          resolveChallenge(null);
          if (result.ok) capture.writeDesktop(library, { ...capture.readDesktop(library), on: true });
          return result;
        })
        .finally(() => {
          fs.rmSync(marker, { force: true });
          pending = null;
        })
        .then(async (result) => ({ ...result, status: await refresh({ force: true }) }));
      pending = { controller, challenge, done };
    }
    const challenge = await pending.challenge;
    return challenge ? { ok: true, ...challenge } : pending ? pending.done : { ok: false, error: 'The sign-in ended.' };
  }

  async function set(args) {
    const { library } = await context();
    const desktop = capture.readDesktop(library);
    if (typeof args.on === 'boolean') desktop.on = args.on;
    if (typeof args.actions === 'boolean') desktop.actions = args.actions;
    capture.writeDesktop(library, desktop);
    for (const [key, setting] of [['screen', 'recording_enabled'], ['audio', 'audio.enabled']]) {
      if (typeof args[key] !== 'boolean') continue;
      const result = await engine(['settings', setting, String(args[key])]);
      if (result.code !== 0) throw new Error(capture.lastError(result.stderr, `Could not change ${key}.`));
    }
    return refresh({ force: true });
  }

  async function verb(args, what) {
    const result = await engine(args);
    if (result.code !== 0) throw new Error(capture.lastError(result.stderr, `Could not ${what}.`));
    return refresh();
  }

  /** The service goes first (its engine stops), then the device token. */
  async function signOut() {
    const { library } = await context();
    capture.writeDesktop(library, { ...capture.readDesktop(library), on: false });
    await service('uninstall');
    const result = await engine(['sync', 'sign-out']);
    if (result.code !== 0) throw new Error(capture.lastError(result.stderr, 'Could not sign out of Capture.'));
    return refresh();
  }

  /**
   * "Allow all" in the Your-computer setup: asks macOS for each missing grant
   * Capture needs, for Kortix (the service runs this app's binary, so the
   * grants hold for it): Screen Recording, Accessibility, and the Microphone
   * only when Audio is on. Answers the fresh status.
   */
  async function requestGrants({ audio = false } = {}) {
    if (process.platform !== 'darwin') return refresh();
    if (!systemPreferences.isTrustedAccessibilityClient(false)) systemPreferences.isTrustedAccessibilityClient(true);
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      // A capture attempt is what adds Kortix to the Screen Recording list (and
      // shows the prompt the first time); macOS 11+ reports a never-asked app as
      // denied, so always try it, then open System Settings if still not granted.
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') void shell.openExternal(capture.PERMISSION_PANES.screen);
    }
    if (audio && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      await systemPreferences.askForMediaAccess('microphone').catch(() => false);
    }
    return refresh();
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
      case 'capture_grants_request':
        return requestGrants(args);
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
    // At launch: a service missing, disabled by mistake, or pointing at the
    // previous app version is installed again (app updates and moves).
    void refresh({ force: true });
    setInterval(() => void refresh(), REFRESH_EVERY_MS);
  }

  return {
    start,
    invoke,
    trayItems: () => capture.captureTrayItems(view, trayActions),
  };
}

module.exports = { setupCapture };
