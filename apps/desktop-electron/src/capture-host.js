// Kortix Capture in the desktop app: the kortix:invoke capture_* commands. The
// engine's CLI does the work: `login`, `start` / `stop` (its own OS service:
// launchd, systemd, Task Scheduler, so Capture keeps recording while the app
// is quit and across reboots), `logout`, `status`. This app passes itself as
// the service's host (macOS grants belong to Kortix), asks for the grants, and
// renders the CLI's JSON. Rules live in capture.js; Capture's tray is
// capture-tray.js. Capture is its own product: no computer-agent module here.

const { app, desktopCapturer, dialog, net, shell, systemPreferences } = require('electron');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const capture = require('./capture');

const REFRESH_EVERY_MS = 30_000;
/** The page polls capture_status; within this age the cached answer is reused. */
const FRESH_MS = 2_000;

/**
 * @param {{
 *   appUrl: () => string,
 *   onChange: () => void,
 *   openCapture: (section?: 'exclusions') => void,
 * }} deps
 */
function setupCapture(deps) {
  const userData = app.getPath('userData');
  const engineDir = capture.engineDir({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
  const paths = capture.enginePaths(engineDir);

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

  const backendCacheFile = 'capture-backend.json';

  /**
   * The instance's backend, read from its own `/api/runtime-config` (never from
   * the page). The last answer is kept on disk, so status works offline.
   */
  async function backendFor(appOrigin) {
    try {
      const response = await net.fetch(`${appOrigin}/api/runtime-config`, { cache: 'no-store' });
      const parsed = capture.backendFromRuntimeConfig(response.ok ? await response.text() : '', appOrigin);
      if (!parsed.ok) throw new Error(parsed.error);
      capture.writePrivateJson(userData, backendCacheFile, { appOrigin, backendUrl: parsed.url });
      return parsed.url;
    } catch (error) {
      try {
        const cached = JSON.parse(fs.readFileSync(path.join(userData, backendCacheFile), 'utf8'));
        if (cached.appOrigin === appOrigin && typeof cached.backendUrl === 'string') return cached.backendUrl;
      } catch {
        /* no cache */
      }
      throw error instanceof Error ? error : new Error(String(error));
    }
  }

  /** @type {{ appOrigin: string, backendUrl: string, library: string, issuer: string, env: NodeJS.ProcessEnv } | null} */
  let ctx = null;

  async function context() {
    const appOrigin = new URL(deps.appUrl()).origin;
    if (ctx?.appOrigin === appOrigin) return ctx;
    const backendUrl = await backendFor(appOrigin);
    // Another instance: its own library, sign-in and service. The other
    // instance's service keeps running; it does not belong to this window.
    const library = capture.libraryDir(userData, new URL(backendUrl).origin);
    fs.mkdirSync(path.join(library, 'logs'), { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(library, 'engine-config.yaml'), capture.engineConfigYaml(library));
    const legacy = capture.removeLegacyService({ library, run: (program, args) => spawnSync(program, args, { stdio: 'ignore' }) });
    if (legacy) console.log('[kortix] capture: removed the service an older Kortix installed');
    ctx = { appOrigin, backendUrl, library, issuer: capture.issuerFromBackend(backendUrl), env: capture.engineEnv({ library, paths }) };
    return ctx;
  }

  const engine = async (args, timeoutMs) => capture.runEngine(paths.capture, args, { env: (await context()).env, timeoutMs });
  const engineJson = async (args) => capture.engineJson(paths.capture, args, { env: (await context()).env });

  /** One service verb, run by the engine's CLI: `status`, `install` (also resume and repair: `start`), `pause` (`stop`), `uninstall`. */
  async function service(verb) {
    const { env } = await context();
    const host = process.env.APPIMAGE || process.execPath;
    const bundleId = process.platform === 'darwin' ? capture.bundleIdOf(host) : null;
    const args =
      verb === 'status'
        ? ['service', 'status']
        : verb === 'pause'
          ? ['stop']
          : verb === 'uninstall'
            ? ['service', 'uninstall']
            : ['start', ...capture.serviceHostArgs({ host, env, bundleId })];
    const result = await capture.runEngine(paths.capture, ['--json', ...args], { env, timeoutMs: 60_000 });
    if (result.code !== 0) throw new Error(capture.lastError(result.stderr, `kortix-capture ${args[0]} failed`));
    const out = JSON.parse(result.stdout);
    return capture.serviceFromCli(verb === 'status' || verb === 'uninstall' ? out : out.service);
  }

  /* ─── Status and the service ─────────────────────────────────────────── */

  let view = capture.captureStatusFrom({ available: false, error: 'Kortix Capture is starting.' });
  let viewAt = 0;
  let refreshing = null;

  /**
   * Brings the service in line with the person's switch and the sign-in.
   * `explicit`: a person just acted (switch, sign-in, Record, Resume). A
   * launch or a poll is passive and never starts a stopped service.
   */
  async function reconcile(desktop, sync, current, { explicit = false } = {}) {
    const action = capture.serviceAction({
      desktopOn: desktop.on,
      signedIn: sync?.kortix?.signed_in === true,
      signInRequired: sync?.kortix?.sign_in_required === true,
      service: current,
      explicit,
    });
    if (!action) return current;
    if ((action === 'install' || action === 'repair') && runsFromTemporaryLocation()) {
      console.log('[kortix] not installing the Capture service: Kortix is not running from the Applications folder');
      return current;
    }
    console.log(`[kortix] capture service: ${action}`);
    return service(action === 'repair' || action === 'resume' ? 'install' : action);
  }

  async function readView({ explicit = false } = {}) {
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
    const after = pending ? current : await reconcile(desktop, sync, current, { explicit }).catch((error) => ({ ...current, error: error.message }));
    const heartbeat = after.heartbeat?.running ? after.heartbeat : null;
    const children = capture.childrenFromHeartbeat(heartbeat);
    return {
      ...capture.captureStatusFrom({
        available: true,
        desktop,
        status,
        sync,
        permissions,
        children,
        // Removed or disabled outside the app, and not running: it waits for a person.
        serviceStopped: !heartbeat && !pending && (after.installed !== true || after.enabled === false),
      }),
      // A failed service install stays visible on the page.
      ...(after.error ? { error: after.error } : {}),
    };
  }

  function refresh(options) {
    // A person's action must reconcile: it waits for a passive read in flight, then runs its own.
    if (refreshing && options?.explicit) return refreshing.then(() => refresh(options));
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
   * runs, the CLI keeps the service's engine stopped (its sign-in marker).
   */
  async function signInStart() {
    const engineState = await engineAvailable();
    if (!engineState.ok) return { ok: false, error: engineState.error };
    if (!pending) {
      const { env, issuer, library } = await context();
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
          pending = null;
        })
        .then(async (result) => ({ ...result, status: await refresh({ explicit: true }) }));
      pending = { controller, challenge, done };
    }
    const challenge = await pending.challenge;
    return challenge ? { ok: true, ...challenge } : pending ? pending.done : { ok: false, error: 'The sign-in ended.' };
  }

  async function set(args) {
    const { library } = await context();
    const desktop = capture.readDesktop(library);
    // The account policy decides the layers; a person only turns recording on or off.
    if (typeof args.on === 'boolean') desktop.on = args.on;
    capture.writeDesktop(library, desktop);
    return refresh({ explicit: true });
  }

  async function verb(args, what) {
    const result = await engine(args);
    if (result.code !== 0) throw new Error(capture.lastError(result.stderr, `Could not ${what}.`));
    return refresh({ explicit: true });
  }

  /** `logout`: the CLI removes its service (the engine stops), then forgets the device token. */
  async function signOut() {
    const { library } = await context();
    capture.writeDesktop(library, { ...capture.readDesktop(library), on: false });
    const result = await engine(['logout']);
    if (result.code !== 0) throw new Error(capture.lastError(result.stderr, 'Could not sign out of Capture.'));
    return refresh();
  }

  /**
   * The Capture dialog's "Allow access", the one place Capture asks macOS:
   * each missing grant once per click, for Kortix (the service runs this
   * app's binary, so the grants hold for it). Screen Recording,
   * Accessibility, Input Monitoring while Actions is on (through the engine:
   * Electron has no API for it), and the Microphone while Audio is on.
   * Nothing at start or in the service ever asks. Answers the fresh status.
   */
  async function requestGrants({ audio = false, actions = false } = {}) {
    if (process.platform !== 'darwin') return refresh();
    if (!systemPreferences.isTrustedAccessibilityClient(false)) systemPreferences.isTrustedAccessibilityClient(true);
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      // A capture attempt is what adds Kortix to the Screen Recording list (and
      // shows the prompt the first time); macOS 11+ reports a never-asked app as
      // denied, so always try it, then open System Settings if still not granted.
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') void shell.openExternal(capture.PERMISSION_PANES.screen);
    }
    if (actions && (await engineJson(['permissions']).catch(() => null))?.input_monitoring === false) {
      // macOS shows this prompt once; after a "Deny" only System Settings grants it.
      await engine(['permissions', '--request', '--only', 'input_monitoring'], 60_000);
      if ((await engineJson(['permissions']).catch(() => null))?.input_monitoring === false) {
        void shell.openExternal(capture.PERMISSION_PANES.inputMonitoring);
      }
    }
    if (audio && systemPreferences.getMediaAccessStatus('microphone') !== 'granted') {
      await systemPreferences.askForMediaAccess('microphone').catch(() => false);
    }
    return refresh();
  }

  /* ─── Exclusions ─────────────────────────────────────────────────────── */

  /** The engine's exclusions: categories, excluded apps and sites, private browsing, recently recorded, the front app. */
  const exclusions = () => engineJson(['exclusions']);

  /** One exclusion on or off; answers the fresh exclusions. Org-enforced items refuse with the engine's message. */
  async function exclude(args) {
    const result = await engine(capture.excludeArgs(args));
    if (result.code !== 0) throw new Error(capture.lastError(result.stderr, 'Could not change the exclusion.'));
    return exclusions();
  }

  const selfBundleId = process.platform === 'darwin' ? capture.bundleIdOf(process.execPath) : null;

  /** The app in front when the menu bar item opens (macOS); null elsewhere or on failure. */
  function frontmost() {
    if (process.platform !== 'darwin') return null;
    const front = spawnSync('lsappinfo', ['front'], { encoding: 'utf8', timeout: 1_000 }).stdout?.trim();
    if (!front) return null;
    const info = spawnSync('lsappinfo', ['info', '-only', 'bundleid', '-only', 'name', front], { encoding: 'utf8', timeout: 1_000 });
    return capture.frontmostFrom(info.stdout ?? '', selfBundleId);
  }

  /** @type {Map<string, string | null>} One icon per bundle id, kept for the app's lifetime. */
  const icons = new Map();

  /** An installed app's icon as a PNG data URL, found by bundle id (macOS); null when it is not installed here. */
  async function appIcon({ bundle_id: bundleId } = {}) {
    if (process.platform !== 'darwin' || typeof bundleId !== 'string' || !/^[A-Za-z0-9][\w.-]{0,199}$/.test(bundleId)) return null;
    if (icons.has(bundleId)) return icons.get(bundleId);
    const found = spawnSync('mdfind', [`kMDItemCFBundleIdentifier == "${bundleId}"`], { encoding: 'utf8', timeout: 3_000 });
    const appPath = (found.stdout ?? '').split('\n').find((line) => line.endsWith('.app'));
    const icon = appPath ? (await app.getFileIcon(appPath, { size: 'normal' }).catch(() => null))?.toDataURL() ?? null : null;
    icons.set(bundleId, icon);
    return icon;
  }

  /** The tray's "Stop recording…": a native confirm, then the same switch as More ▸ Stop recording. */
  async function confirmStop() {
    const { response } = await dialog.showMessageBox({
      type: 'question',
      buttons: ['Stop recording', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      message: 'Stop recording this computer?',
      detail: 'Kortix Capture stops now and does not start again at login. Start it again from This computer.',
    });
    if (response === 0) await set({ on: false });
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
        return verb(['pause', '--for', '60m'], 'pause Capture');
      case 'capture_resume':
        return verb(['resume'], 'resume Capture');
      case 'capture_sign_out':
        return signOut();
      case 'capture_grants_request':
        return requestGrants(args);
      case 'capture_exclusions':
        return exclusions();
      case 'capture_exclude':
        return exclude(args);
      case 'capture_app_icon':
        return appIcon(args);
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
    pause: () => void invoke('capture_pause').catch((e) => console.warn(`[kortix] capture pause: ${e}`)),
    resume: () => void invoke('capture_resume').catch((e) => console.warn(`[kortix] capture resume: ${e}`)),
    open: () => deps.openCapture(),
    settings: () => deps.openCapture('exclusions'),
    exclude: (front) =>
      void exclude({ kind: 'app', id: front.bundleId, on: true })
        .then(() => refresh())
        .catch((e) => console.warn(`[kortix] capture exclude: ${e}`)),
    stop: () => void confirmStop().catch((e) => console.warn(`[kortix] capture stop: ${e}`)),
    logs: () => void invoke('capture_open_logs').catch((e) => console.warn(`[kortix] capture logs: ${e}`)),
  };

  function start() {
    // At launch: only a unit that points at the previous app version is
    // rewritten (updates, moves). A stopped or removed service stays stopped.
    void refresh();
    setInterval(() => void refresh(), REFRESH_EVERY_MS);
  }

  return {
    start,
    invoke,
    /** This build ships the engine (the app menu shows Capture only then). */
    /** Capture's tray items (capture-tray.js); empty until Capture is set up here. */
    trayItems: (front = null) => capture.captureTrayItems(view, trayActions, front),
    /** The app in front, read when the menu bar item opens. */
    frontmost,
    /** Whether the service keeps recording after the app quits. */
    keepsRunning: () => capture.captureKeepsRunning(view),
  };
}

module.exports = { setupCapture };
