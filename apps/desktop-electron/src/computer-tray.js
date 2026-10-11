// "This computer" in the desktop app: the kortix:invoke computer_* commands,
// the in-app approval window, the access prompt, and the tray / menu-bar item.
// Rules and parsing live in computer.js (unit-tested); this file is the
// Electron side effects. Every change to the agent goes through its CLI.

const {
  app,
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  desktopCapturer,
  dialog,
  nativeImage,
  net,
  shell,
  systemPreferences,
} = require('electron');
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
/** Agent files whose change means "read `status --json` again". This app never parses them. */
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

  const run = async (args) => {
    const { home } = await context();
    return computer.runAgent(args, { cli: cli(), home });
  };

  /* ─── Status ─────────────────────────────────────────────────────────── */

  let status = null;
  let refreshing = null;

  async function readStatus() {
    try {
      const { home } = await context();
      return await computer.computerStatus({ cli: cli(), home });
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
        followPrompt(next);
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

  // fs.watch reports a change at once where the platform supports it; the
  // mtime poll covers the rest, including a directory that does not exist yet.
  function checkFiles() {
    if (!ctx) return;
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
  }

  /* ─── Access prompt (A4) ─────────────────────────────────────────────── */

  /** @type {{ id: string, controller: AbortController } | null} */
  let prompting = null;

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

  /**
   * After every status read: close a prompt whose request was answered
   * elsewhere (the terminal, Kortix, another prompt) or expired, and open one
   * for a new request.
   */
  function followPrompt(next) {
    const request = computer.requestToPrompt(next?.access);
    if (prompting && prompting.id !== request?.id) prompting.controller.abort();
    if (request && !prompting) void prompt(request);
  }

  async function prompt(request) {
    const controller = new AbortController();
    prompting = { id: request.id, controller };
    // Read the files often while the owner decides, and the status every 5 s,
    // so an answer from elsewhere or an expired request closes this prompt.
    const watch = setInterval(checkFiles, 500);
    const reread = setInterval(() => void refresh(), 5_000);
    try {
      const options = request.change
        ? computer.widenPrompt(request.change, machineName())
        : computer.accessPrompt(request, machineName());
      if (!BrowserWindow.getFocusedWindow() && Notification.isSupported()) {
        new Notification({ title: options.title, body: options.detail }).show();
      }
      const { response } = await showOnTop({ ...options, signal: controller.signal });
      // Answered elsewhere: this prompt's cancel is not a Deny.
      if (controller.signal.aborted) return;
      const result = await run(computer.answerArgs(request, response));
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim().slice(-500));
    } catch (error) {
      console.warn(`[kortix] access prompt failed: ${error}`);
    } finally {
      clearInterval(watch);
      clearInterval(reread);
      prompting = null;
      void refresh();
    }
  }

  /** Tray clicks: the owner's own hand, applied by the CLI as given. */
  async function setAccess(change) {
    const result = await run(computer.accessArgs(change));
    void refresh();
    if (result.code !== 0) throw new Error((result.stderr || result.stdout || 'The access change failed.').trim().slice(-500));
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
    toggleKeepAwake: () => void setAccess({ keepAwake: !status?.access?.keepAwake }).catch((e) => dialog.showErrorBox('Kortix', String(e))),
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
          {
            openAtLogin: app.getLoginItemSettings().openAtLogin,
            loginItemSupported: process.platform === 'darwin' || process.platform === 'win32',
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

  /* ─── Computer setup: macOS grants (Kortix holds them) ───────────────── */

  const grantsFile = path.join(userData, 'computer-grants.json');
  /** macOS asks for these folders separately from the rest of the home folder. */
  const PROTECTED_FOLDERS = ['Desktop', 'Documents', 'Downloads'];

  /** Folder access as last answered; macOS has no way to read it without asking. */
  function filesGrant() {
    try {
      const files = JSON.parse(fs.readFileSync(grantsFile, 'utf8')).files;
      return typeof files === 'boolean' ? files : null;
    } catch {
      return null;
    }
  }

  /**
   * The grants this machine's approved access needs, as macOS answers them for
   * Kortix. The agent runs as this app's binary and starts the bundled driver
   * as its own child, so they hold for the agent too. `null` off macOS.
   */
  async function grants() {
    if (process.platform !== 'darwin') return null;
    const { capabilities } = status ?? (await refresh());
    const current = {
      accessibility: systemPreferences.isTrustedAccessibilityClient(false),
      screenRecording: systemPreferences.getMediaAccessStatus('screen') === 'granted',
      files: filesGrant(),
    };
    return { ...current, missing: computer.computerSetupMissing(capabilities, current) };
  }

  let grantWatch = null;
  /**
   * Setup's "Allow all": asks macOS for every missing grant, one prompt at a
   * time, while the person is looking at the setup screen. Each prompt names
   * Kortix. Once Accessibility and Screen Recording hold, the agent restarts:
   * macOS applies them only to a process launched after the grant.
   * `restartAgent`: the agent reports a grant missing that macOS gives this
   * app, so the agent process predates the grant; it restarts now.
   */
  async function requestGrants({ restartAgent = false } = {}) {
    const before = await grants();
    if (!before) return null;
    if (before.missing.includes('files')) {
      // Each read of a protected folder raises its prompt once and waits for the answer.
      let all = true;
      for (const folder of PROTECTED_FOLDERS) {
        all = (await fs.promises.readdir(path.join(os.homedir(), folder)).then(() => true, () => false)) && all;
      }
      if (!all) void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders');
      fs.writeFileSync(grantsFile, JSON.stringify({ files: all }));
    }
    if (before.missing.includes('accessibility')) systemPreferences.isTrustedAccessibilityClient(true);
    if (before.missing.includes('screenRecording')) {
      // A capture attempt is what adds Kortix to the Screen Recording list (and
      // shows the prompt the first time). Always try it: macOS 11+ reports a
      // never-asked app as denied, never as undetermined, so skipping the
      // attempt opened System Settings on a list without Kortix in it.
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
      if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
        void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
      }
    }
    const needsRestart = before.missing.includes('accessibility') || before.missing.includes('screenRecording');
    if (restartAgent === true && !needsRestart) await serviceVerb('restart', (next) => next.serviceActive === true);
    if (needsRestart && !grantWatch) {
      const until = Date.now() + 10 * 60_000;
      grantWatch = setInterval(async () => {
        const now = await grants();
        const ready = now && now.accessibility && now.screenRecording;
        if (ready) void serviceVerb('restart', (next) => next.serviceActive === true);
        if (ready || Date.now() > until) {
          clearInterval(grantWatch);
          grantWatch = null;
        }
      }, 2_000);
    }
    return grants();
  }

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
      case 'computer_grants':
        return grants();
      case 'computer_grants_request':
        return requestGrants({ restartAgent: args?.restartAgent === true });
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
