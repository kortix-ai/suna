// "This computer" in the desktop app: the kortix:invoke computer_* commands,
// the in-app approval window, the access prompt, and the tray / menu-bar item.
// Rules and parsing live in computer.js (unit-tested); this file is the
// Electron side effects.

const { app, BrowserWindow, Menu, Notification, Tray, dialog, nativeImage, net, shell } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const computer = require('./computer');
const { isApprovalDialogPath } = require('./nav-rules');

const FULL_REFRESH_MS = 60_000;
const STATE_POLL_MS = 5_000;
/** R5: a service that stops while the app runs is repaired, at most this often. */
const REPAIR_EVERY_MS = 5 * 60_000;
/** The approval page polls every 2 s; closing it right after Approve must not cancel the pairing. */
const APPROVAL_CLOSE_GRACE_MS = 10_000;
/** Files in the agent home that change what the tray and the web show. */
const WATCHED_FILES = ['state.json', 'config.json', 'access.json', 'access-request.json'];

/**
 * @param {{
 *   channel: string,
 *   appUrl: () => string,
 *   isConfiguredAppUrl: (url: string, appUrl: string) => boolean,
 *   shouldLoadInApp: (url: string) => boolean,
 *   getMainWindow: () => import('electron').BrowserWindow | null,
 *   openMainWindow: () => void,
 *   backgroundColor: () => string,
 * }} deps
 */
function setupComputer(deps) {
  const userData = app.getPath('userData');
  const backendCacheFile = path.join(userData, 'computer-backend.json');

  /** @type {string | null} */
  let cliPath = null;
  function cli() {
    if (cliPath) return cliPath;
    cliPath = app.isPackaged
      ? computer.agentCliPath({ isPackaged: true, resourcesPath: process.resourcesPath })
      : computer.ensureDevAgentCli();
    if (!fs.existsSync(cliPath)) {
      const missing = cliPath;
      cliPath = null;
      throw new Error(`The computer agent is missing from this build (${missing}).`);
    }
    return cliPath;
  }

  /* ─── Backend and agent home (X6) ────────────────────────────────────── */

  /** @type {{ appOrigin: string, backendUrl: string, home: string | null, agentDir: string } | null} */
  let ctx = null;

  function contextFor(appOrigin, backendUrl) {
    const home = computer.agentHome({
      isPackaged: app.isPackaged,
      channel: deps.channel,
      userData,
      apiOrigin: new URL(backendUrl).origin,
    });
    return { appOrigin, backendUrl, home, agentDir: computer.effectiveHome(home) };
  }

  function cachedBackend(appOrigin) {
    try {
      const cached = JSON.parse(fs.readFileSync(backendCacheFile, 'utf8'));
      return cached.appOrigin === appOrigin && typeof cached.backendUrl === 'string' ? cached.backendUrl : null;
    } catch {
      return null;
    }
  }

  /**
   * The instance's backend, read by the main process from the instance's own
   * runtime config (never from the page). The last answer is kept on disk so
   * the tray works offline and a cold start can prompt at once.
   */
  async function resolveBackend(appOrigin) {
    let backendUrl = null;
    let error = null;
    try {
      const response = await net.fetch(`${appOrigin}/api/runtime-config`, { cache: 'no-store' });
      const parsed = computer.backendFromRuntimeConfig(response.ok ? await response.text() : '', appOrigin);
      if (parsed.ok) backendUrl = parsed.url;
      else error = parsed.error;
    } catch (e) {
      error = `Could not reach ${appOrigin}: ${e instanceof Error ? e.message : e}`;
    }
    if (backendUrl) {
      try {
        computer.writePrivateJson(userData, path.basename(backendCacheFile), { appOrigin, backendUrl });
      } catch {
        /* cache only */
      }
    } else {
      backendUrl = cachedBackend(appOrigin);
      if (!backendUrl) throw new Error(error || 'The Kortix instance did not report its backend.');
    }
    if (ctx?.appOrigin !== appOrigin || ctx.backendUrl !== backendUrl) {
      ctx = contextFor(appOrigin, backendUrl);
      adoptHome(ctx);
    }
    return ctx;
  }

  async function context() {
    const appOrigin = new URL(deps.appUrl()).origin;
    return ctx?.appOrigin === appOrigin ? ctx : resolveBackend(appOrigin);
  }

  /** The recorder the service supervises. Null when this build has none. */
  const captureBin = () => computer.captureBinPath({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });

  const run = async (args) => {
    const { home } = await context();
    return computer.runAgent(args, { cli: cli(), home, captureBin: captureBin() });
  };

  /* ─── Status ─────────────────────────────────────────────────────────── */

  let status = null;
  let access = computer.readAccess(null);
  let refreshing = null;

  async function readStatus() {
    try {
      const { home } = await context();
      access = computer.readAccess(home);
      return await computer.computerStatus({ cli: cli(), home, captureBin: captureBin() });
    } catch (error) {
      return computer.unavailable(error instanceof Error ? error.message : String(error));
    }
  }

  function refresh() {
    refreshing ??= readStatus()
      .then((next) => {
        status = next;
        renderTraySafely();
        if (next?.needsRepair) void repairService();
        return next;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  /* ─── Agent home: desktop-app.json and file watch ────────────────────── */

  const watchedDirs = new Set();
  const mtimes = new Map();

  /**
   * A translocated or disk-image copy runs from a path that disappears; a
   * service or wake command pointed at it would never start again.
   */
  const runsFromTemporaryLocation = () => process.platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder();

  /** Tells the agent how to start this app for a prompt (A3), and watches the home. */
  function adoptHome({ agentDir }) {
    try {
      if (runsFromTemporaryLocation()) throw new Error('not in the Applications folder');
      computer.writePrivateJson(
        agentDir,
        'desktop-app.json',
        computer.desktopAppRecord({
          execPath: process.execPath,
          defaultApp: Boolean(process.defaultApp),
          argv: process.argv,
          env: process.env,
          pid: process.pid,
        }),
      );
    } catch (error) {
      console.warn(`[kortix] could not record the app for access prompts: ${error}`);
    }
    if (watchedDirs.has(agentDir)) return;
    watchedDirs.add(agentDir);
    try {
      fs.watch(agentDir, { persistent: false }, (_event, file) => {
        if (!file || WATCHED_FILES.includes(String(file))) checkFiles();
      });
    } catch {
      /* directory missing: the poll covers it */
    }
  }

  /* ─── Kortix Capture ─────────────────────────────────────────────────── */

  /** @type {ReturnType<typeof computer.captureStatus> | null} */
  let capture = null;

  /** Re-reads recorder.json; the tray is rebuilt only when its line changes (a rebuild closes an open menu). */
  function refreshCapture() {
    if (!ctx) return null;
    const next = computer.captureStatus(ctx.home);
    const changed = next.label !== capture?.label || next.state !== capture?.state;
    capture = next;
    if (changed) renderTraySafely();
    return next;
  }

  function setCapturePause(untilMs) {
    if (!ctx) throw new Error('Kortix is not connected to an instance yet.');
    computer.writeCapturePause(ctx.home, untilMs);
    return refreshCapture();
  }

  const capturePause = (minutes = 60) => setCapturePause(computer.capturePauseUntil(minutes));
  const captureResume = () => setCapturePause(null);

  /** macOS: only the person can grant Screen Recording; open the pane. Other systems need no grant. */
  async function captureRequestPermission() {
    if (process.platform !== 'darwin') return { ok: true, opened: false };
    await shell.openExternal(computer.SCREEN_RECORDING_PANE);
    return { ok: true, opened: true };
  }

  // fs.watch reports a change at once where the platform supports it; the
  // mtime poll covers the rest, including a directory that does not exist yet.
  function checkFiles() {
    if (!ctx) return;
    refreshCapture();
    let changed = false;
    for (const name of WATCHED_FILES) {
      let mtime = 0;
      try {
        mtime = fs.statSync(path.join(ctx.agentDir, name)).mtimeMs;
      } catch {
        /* not written */
      }
      if (mtimes.get(name) !== mtime) {
        mtimes.set(name, mtime);
        changed = true;
      }
    }
    // Heartbeat: the agent treats a desktop-app.json older than 30 s as "app
    // not running", so a reused pid after a reboot does not block the launch.
    try {
      const now = new Date();
      fs.utimesSync(path.join(ctx.agentDir, 'desktop-app.json'), now, now);
    } catch {
      /* not recorded */
    }
    if (!changed) return;
    void refresh();
    void maybePrompt();
  }

  /* ─── Access prompt (A4) ─────────────────────────────────────────────── */

  let promptingFor = null;

  function machineName() {
    return os.hostname().replace(/\.local$/i, '');
  }

  /**
   * Shows a native dialog on top of every app, attached to the main window
   * (opened if the app sits in the tray) raised always-on-top. macOS also
   * steals focus; Windows and Linux hide an ownerless dialog behind the
   * active app.
   */
  async function showOnTop(options) {
    // Always parented: on macOS an ownerless message box runs synchronously and
    // ignores its AbortSignal, so a prompt answered elsewhere could not close.
    if (process.platform === 'darwin') app.focus({ steal: true });
    if (!deps.getMainWindow()) deps.openMainWindow();
    const parent = deps.getMainWindow();
    if (!parent) return dialog.showMessageBox(options);
    parent.show();
    parent.setAlwaysOnTop(true);
    parent.focus();
    try {
      return await dialog.showMessageBox(parent, options);
    } finally {
      if (!parent.isDestroyed()) parent.setAlwaysOnTop(false);
    }
  }

  async function maybePrompt() {
    if (!ctx || promptingFor) return;
    const { home } = ctx;
    const request = computer.freshRequest(home);
    if (!request) return;
    // Decided already (a grant, a denial, or another mode): the agent needs no
    // answer, and a second prompt could undo the first one.
    if (computer.decideAccess(computer.readAccess(home)) !== 'ask') return computer.clearAccessRequest(home, request.id);
    promptingFor = request.id;
    try {
      const prompt = computer.accessPrompt(request, machineName());
      const focused = BrowserWindow.getFocusedWindow();
      if (!focused && Notification.isSupported()) {
        new Notification({ title: prompt.title, body: prompt.detail }).show();
      }
      // Answered elsewhere (the page, the tray, another prompt) or expired:
      // close this prompt without recording its cancel as a Deny.
      const controller = new AbortController();
      const watch = setInterval(() => {
        const current = computer.freshRequest(home);
        const pending = current?.id === request.id && computer.decideAccess(computer.readAccess(home)) === 'ask';
        if (!pending) controller.abort();
      }, 500);
      let response;
      try {
        ({ response } = await showOnTop({ ...prompt, signal: controller.signal }));
      } finally {
        clearInterval(watch);
      }
      if (controller.signal.aborted) return;
      const answeredAt = Date.now();
      computer.writeAccess(home, computer.answerAccess(computer.readAccess(home), response, answeredAt));
      computer.clearAccessRequestsUntil(home, answeredAt);
    } catch (error) {
      console.warn(`[kortix] access prompt failed: ${error}`);
    } finally {
      promptingFor = null;
      void refresh();
    }
  }

  /** Tray menu clicks: the owner's own hand, applied as given. */
  async function setAccess(input) {
    const { home } = await context();
    computer.writeAccess(home, computer.nextAccess(computer.readAccess(home), input));
    void refresh();
    return computer.accessView(home);
  }

  /**
   * `computer_access_set` from the page. The page is remote content, so it may
   * narrow access at once but never widen it: `always`, or a longer grant,
   * applies only after the owner confirms in a native dialog (§A).
   */
  async function setAccessFromPage(input) {
    const { home } = await context();
    const current = computer.readAccess(home);
    const next = computer.nextAccess(current, input);
    if (computer.accessWidens(current, next)) {
      const { response } = await showOnTop(computer.widenPrompt(next, machineName()));
      if (response !== 0) return computer.accessView(home);
    }
    computer.writeAccess(home, computer.nextAccess(computer.readAccess(home), input));
    // A grant or a denial from the page answers the pending request too.
    if (input?.grantMinutes !== undefined || input?.deny === true) computer.clearAccessRequestsUntil(home);
    void refresh();
    return computer.accessView(home);
  }

  /* ─── Tray ───────────────────────────────────────────────────────────── */

  /** @type {Tray | null} */
  let tray = null;

  function trayIcon() {
    const dir = path.join(__dirname, '..', 'assets', 'tray');
    if (process.platform === 'darwin') {
      const image = nativeImage.createFromPath(path.join(dir, 'trayTemplate.png'));
      image.setTemplateImage(true);
      return image;
    }
    return nativeImage.createFromPath(path.join(dir, process.platform === 'win32' ? 'tray.ico' : 'tray.png'));
  }

  function openLogs() {
    const dir = ctx?.agentDir ?? computer.effectiveHome(null);
    const log = path.join(dir, 'logs', 'agent-tunnel.out.log');
    const target = fs.existsSync(log) ? log : fs.existsSync(path.join(dir, 'logs')) ? path.join(dir, 'logs') : dir;
    return shell.openPath(target).then((error) => {
      if (error) throw new Error(`Could not open the logs: ${error}`);
    });
  }

  /** Failures from the tray surface as a dialog, never silently. */
  const reportFailure = (what) => (result) => {
    if (result && result.ok === false) dialog.showErrorBox(`Kortix could not ${what}`, result.error || 'Unknown error');
  };

  const actions = {
    open: () => deps.openMainWindow(),
    pause: () => void pause().then(reportFailure('pause computer access')),
    resume: () => void resume().then(reportFailure('resume computer access')),
    setMode: (mode) => void setAccess({ mode }).catch((e) => dialog.showErrorBox('Kortix', String(e))),
    revoke: () => void setAccess({ revoke: true }).catch((e) => dialog.showErrorBox('Kortix', String(e))),
    toggleKeepAwake: () => void setAccess({ keepAwake: !access.keepAwake }).catch((e) => dialog.showErrorBox('Kortix', String(e))),
    capturePause: () => void Promise.resolve().then(() => capturePause(60)).catch((e) => dialog.showErrorBox('Kortix', String(e))),
    captureResume: () => void Promise.resolve().then(captureResume).catch((e) => dialog.showErrorBox('Kortix', String(e))),
    capturePermission: () => void captureRequestPermission().catch((e) => dialog.showErrorBox('Kortix', String(e))),
    logs: () => void openLogs().catch((e) => dialog.showErrorBox('Kortix', String(e))),
    toggleLogin: () => {
      app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin });
      renderTraySafely();
    },
    disconnect: async () => {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Disconnect', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Disconnect this computer?',
        detail: 'Kortix removes this computer from your account and agents lose access to it. Connect it again at any time.',
      });
      if (response !== 0) return;
      const result = await disconnect();
      reportFailure('disconnect this computer')(result);
      if (result.ok && !result.serverUnpaired) {
        dialog.showErrorBox(
          'Removed here, not yet in Kortix',
          'Kortix could not be reached, so the computer still appears in your account. Remove it from Customize → Connectors → Computer.',
        );
      }
    },
    quit: () => app.quit(),
  };

  function renderTray() {
    if (!status?.paired) {
      tray?.destroy();
      tray = null;
      return;
    }
    if (!tray) {
      tray = new Tray(trayIcon());
      // Windows and Linux: a left click opens the app; the menu is on right click.
      if (process.platform !== 'darwin') tray.on('click', actions.open);
    }
    tray.setToolTip(`Kortix — ${computer.statusLabel(status)}`);
    tray.setContextMenu(
      Menu.buildFromTemplate(
        computer.trayMenuTemplate(
          status,
          access,
          {
            openAtLogin: app.getLoginItemSettings().openAtLogin,
            loginItemSupported: process.platform === 'darwin' || process.platform === 'win32',
            keepAwakeSupported: computer.keepAwakeSupported(process.platform),
            capture,
          },
          actions,
        ),
      ),
    );
  }

  function renderTraySafely() {
    try {
      renderTray();
    } catch (error) {
      console.warn(`[kortix] tray update failed: ${error}`);
    }
  }

  /* ─── Commands ───────────────────────────────────────────────────────── */

  /** X5: `{ ok, error?, status }`, built from the agent's exit code and output. */
  async function serviceVerb(verb, succeeded) {
    try {
      const result = await run([verb]);
      const next = await refresh();
      const ok = result.code === 0 && succeeded(next);
      return ok
        ? { ok, status: next }
        : { ok, status: next, error: (result.stderr || result.stdout || `agent ${verb} failed`).trim().slice(-500) };
    } catch (error) {
      return { ok: false, status, error: error instanceof Error ? error.message : String(error) };
    }
  }

  const pause = () => serviceVerb('stop', (next) => next.paused === true || !next.serviceActive);
  const resume = () => serviceVerb('start', (next) => next.serviceActive === true);

  /**
   * X4: `logout --json` unpairs on the server with the machine's own
   * credential FIRST, then clears it and removes the service.
   */
  async function disconnect() {
    try {
      const result = await run(['logout', '--json']);
      let report = {};
      try {
        report = JSON.parse(result.stdout);
      } catch {
        /* older agent: no JSON */
      }
      const next = await refresh();
      const ok = result.code === 0 && !next?.paired;
      return {
        ok,
        serverUnpaired: report.serverUnpaired === true,
        status: next,
        ...(ok ? {} : { error: (result.stderr || 'The agent could not sign out.').trim().slice(-500) }),
      };
    } catch (error) {
      return { ok: false, serverUnpaired: false, status, error: error instanceof Error ? error.message : String(error) };
    }
  }

  let lastRepairAt = 0;

  /**
   * R5: a paired, unpaused service is reinstalled when missing, stopped,
   * stale, or older. Runs at launch and from every refresh, at most once per
   * REPAIR_EVERY_MS, so a job launchd dropped while the app runs comes back.
   */
  async function repairService() {
    if (Date.now() - lastRepairAt < REPAIR_EVERY_MS) return;
    lastRepairAt = Date.now();
    // A copy opened from a disk image or ~/Downloads would point the service
    // at a path that disappears (or downgrade it); only the installed app repairs.
    if (runsFromTemporaryLocation()) {
      console.log('[kortix] not repairing the computer service: Kortix is not running from the Applications folder');
      return;
    }
    console.log('[kortix] computer service is missing, stopped, or out of date — reinstalling it');
    const result = await run(['install-service']);
    if (result.code !== 0) console.warn(`[kortix] computer service repair failed: ${result.stderr || result.stdout}`);
    await refresh();
  }

  /** @type {BrowserWindow | null} */
  let approvalWindow = null;
  /** @type {Promise<object> | null} */
  let pendingConnect = null;
  let pendingApprovalUrl = null;
  /** The close handler of the pending pairing, reused when the page is reopened. */
  let pendingOnClosed = () => {};

  /**
   * Shows the approval page. The URL comes from the relay, so it loads in-app
   * only when it is this app's own /tunnel/ route; anything else goes to the
   * system browser, like the npm CLI does.
   */
  function showApproval(url, onClosedByUser) {
    let target;
    try {
      target = new URL(url);
    } catch {
      return;
    }
    const inApp = deps.isConfiguredAppUrl(url, deps.appUrl()) && target.pathname.startsWith('/tunnel/');
    if (!inApp) {
      if (target.protocol === 'https:' || target.protocol === 'http:') void shell.openExternal(url);
      return;
    }
    const parent = deps.getMainWindow() || undefined;
    approvalWindow = new BrowserWindow({
      width: 520,
      height: 720,
      parent,
      modal: Boolean(parent),
      minimizable: false,
      fullscreenable: false,
      title: 'Connect this computer',
      backgroundColor: deps.backgroundColor(),
      autoHideMenuBar: true,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    });
    const win = approvalWindow;
    const wc = win.webContents;
    // A dialog, not a second app window: leaving its pages (Back, a link into
    // the app) is Cancel. On macOS a modal child is a sheet with no close
    // button, so this and Esc are its way out.
    const leavesDialog = (next) => {
      try {
        return !(deps.isConfiguredAppUrl(next, deps.appUrl()) && isApprovalDialogPath(new URL(next).pathname));
      } catch {
        return true;
      }
    };
    const cancel = () => {
      if (!win.isDestroyed()) win.close();
    };
    wc.on('will-navigate', (event, next) => {
      if (!leavesDialog(next)) return;
      event.preventDefault();
      if (deps.shouldLoadInApp(next)) cancel();
      else if (/^https?:\/\//i.test(next)) void shell.openExternal(next);
    });
    // Client-side routing (the web Back's router.replace) never fires will-navigate.
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && details.isSameDocument && leavesDialog(details.url)) cancel();
    });
    wc.on('before-input-event', (event, input) => {
      if (input.key !== 'Escape' || (input.type !== 'keyDown' && input.type !== 'keyUp')) return;
      event.preventDefault();
      cancel();
    });
    wc.setWindowOpenHandler(({ url: next }) => {
      if (/^https?:\/\//i.test(next)) void shell.openExternal(next);
      return { action: 'deny' };
    });
    approvalWindow.on('closed', () => {
      approvalWindow = null;
      onClosedByUser();
    });
    void approvalWindow.loadURL(url).catch(() => {});
  }

  function closeApproval() {
    const win = approvalWindow;
    approvalWindow = null;
    if (win && !win.isDestroyed()) win.destroy();
  }

  async function connect(args) {
    const projectId = args.projectId ? String(args.projectId) : undefined;
    if (projectId !== undefined && !computer.isProjectId(projectId)) {
      return { ok: false, error: 'projectId must be a project UUID' };
    }
    if (args.share !== undefined && args.share !== 'me' && args.share !== 'project') {
      return { ok: false, error: "share must be 'me' or 'project'" };
    }
    const { backendUrl, home } = await context();
    const mismatch = computer.checkPageApiUrl(args.apiUrl, backendUrl);
    if (mismatch) return { ok: false, error: mismatch };
    // A translocated or disk-image copy has a path that disappears; the
    // service would point at it and never start again.
    if (runsFromTemporaryLocation()) {
      return { ok: false, error: 'Move Kortix to the Applications folder, then connect again.' };
    }
    if (pendingConnect) {
      if (approvalWindow) approvalWindow.focus();
      // Same close handler: closing the reopened page still cancels the pairing.
      else if (pendingApprovalUrl) showApproval(pendingApprovalUrl, pendingOnClosed);
      return pendingConnect;
    }

    const controller = new AbortController();
    let approved = false;
    // ponytail: `share` is chosen on the approval page (F3); the machine-side
    // request carries only the optional project.
    pendingConnect = computer
      .connectComputer({
        cli: cli(),
        home,
        captureBin: captureBin(),
        apiUrl: `${backendUrl}/tunnel`,
        projectId,
        reauth: args.reauth === true,
        signal: controller.signal,
        onChallenge: (url) => {
          pendingApprovalUrl = url;
          pendingOnClosed = () => {
            // Approving closes the page, and the agent learns it on its next
            // 2 s poll. Cancel only if no approval arrives within the grace.
            setTimeout(() => {
              if (!approved && !approvalWindow) controller.abort();
            }, APPROVAL_CLOSE_GRACE_MS);
          };
          showApproval(url, pendingOnClosed);
        },
        onApproved: () => {
          approved = true;
          closeApproval();
        },
      })
      .then(async (result) => {
        closeApproval();
        await refresh();
        return result;
      })
      .finally(() => {
        pendingConnect = null;
        pendingApprovalUrl = null;
        pendingOnClosed = () => {};
      });
    return pendingConnect;
  }

  async function invoke(cmd, args = {}) {
    switch (cmd) {
      case 'computer_status':
        // The tray keeps this fresh from file changes; no agent process per poll.
        return status ?? refresh();
      case 'computer_connect':
        try {
          return await connect(args);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      case 'computer_pause':
        return pause();
      case 'computer_resume':
        return resume();
      case 'computer_disconnect':
        return disconnect();
      case 'computer_open_logs':
        await context();
        await openLogs();
        return null;
      case 'computer_access_get':
        return computer.accessView((await context()).home);
      case 'computer_access_set':
        return setAccessFromPage(args);
      case 'capture_status':
        await context();
        return refreshCapture();
      case 'capture_pause':
        await context();
        return capturePause(args.minutes ?? 60);
      case 'capture_resume':
        await context();
        return captureResume();
      case 'capture_request_permission':
        return captureRequestPermission();
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  }

  function start() {
    const appOrigin = new URL(deps.appUrl()).origin;
    try {
      const cached = cachedBackend(appOrigin);
      if (cached) {
        ctx = contextFor(appOrigin, cached);
        adoptHome(ctx);
        checkFiles();
      }
    } catch {
      /* a damaged cache: the fetch below replaces it */
    }
    void resolveBackend(appOrigin)
      .then(() => {
        checkFiles();
        return refresh();
      })
      .catch((error) => {
        console.warn(`[kortix] computer setup: ${error instanceof Error ? error.message : error}`);
        void refresh();
      });
    setInterval(checkFiles, STATE_POLL_MS);
    setInterval(() => void refresh(), FULL_REFRESH_MS);
  }

  return {
    start,
    invoke,
    /** Closing the last window keeps the app in the tray while a computer is paired. */
    keepRunning: () => computer.keepRunningInTray(status),
  };
}

module.exports = { setupComputer };
