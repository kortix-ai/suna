// "This computer" in the desktop app: the kortix:invoke computer_* commands,
// the in-app approval window, and the tray / menu-bar item. Rules and parsing
// live in computer.js (unit-tested); this file is the Electron side effects.

const { app, BrowserWindow, Menu, Tray, dialog, nativeImage, shell } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const computer = require('./computer');

const FULL_REFRESH_MS = 60_000;
const STATE_POLL_MS = 5_000;

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
  const home = computer.agentHome({
    isPackaged: app.isPackaged,
    channel: deps.channel,
    userData: app.getPath('userData'),
  });
  const agentDir = computer.effectiveHome(home);

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
  const run = (args) => computer.runAgent(args, { cli: cli(), home });

  /* ─── Status ─────────────────────────────────────────────────────────── */

  let status = null;
  let refreshing = null;

  async function readStatus() {
    try {
      return await computer.computerStatus({ cli: cli(), home });
    } catch (error) {
      return computer.unavailable(error instanceof Error ? error.message : String(error));
    }
  }

  function refresh() {
    refreshing ??= readStatus()
      .then((next) => {
        status = next;
        try {
          renderTray();
        } catch (error) {
          console.warn(`[kortix] tray update failed: ${error}`);
        }
        return next;
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }

  // state.json changes on every connect / auth / disconnect. fs.watch gives the
  // change at once where the platform supports it; the mtime poll covers the
  // rest, including a directory that does not exist yet.
  let stateMtime = 0;
  function checkStateFile() {
    let mtime = 0;
    try {
      mtime = fs.statSync(path.join(agentDir, 'state.json')).mtimeMs;
    } catch {
      /* not written yet */
    }
    if (mtime !== stateMtime) {
      stateMtime = mtime;
      void refresh();
    }
  }
  function watchStateFile() {
    try {
      fs.watch(agentDir, { persistent: false }, (_event, file) => {
        if (!file || String(file) === 'state.json') checkStateFile();
      });
    } catch {
      /* directory missing: the poll covers it */
    }
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

  function openFile(file, fallbackDir) {
    if (fs.existsSync(file)) void shell.openPath(file);
    else void shell.openPath(fs.existsSync(fallbackDir) ? fallbackDir : agentDir);
  }

  const actions = {
    open: () => deps.openMainWindow(),
    pause: () => void run(['stop']).then(refresh),
    resume: () => void run(['start']).then(refresh),
    // ponytail: reveals config.json; a local permission editor replaces this.
    permissions: () => {
      const config = path.join(agentDir, 'config.json');
      if (fs.existsSync(config)) shell.showItemInFolder(config);
      else void shell.openPath(agentDir);
    },
    logs: () => openLogs(),
    toggleLogin: () => {
      app.setLoginItemSettings({ openAtLogin: !app.getLoginItemSettings().openAtLogin });
      renderTray();
    },
    disconnect: async () => {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: ['Disconnect', 'Cancel'],
        defaultId: 1,
        cancelId: 1,
        message: 'Disconnect this computer?',
        detail: 'Kortix agents lose access to this computer. Connect it again from a project at any time.',
      });
      if (response === 0) await disconnect();
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

  /* ─── Commands ───────────────────────────────────────────────────────── */

  function openLogs() {
    openFile(path.join(agentDir, 'logs', 'agent-tunnel.out.log'), path.join(agentDir, 'logs'));
  }

  async function disconnect() {
    const result = await run(['logout']);
    const next = await refresh();
    return { ok: result.code === 0 && !next?.paired, status: next };
  }

  /** @type {BrowserWindow | null} */
  let approvalWindow = null;
  /** @type {Promise<object> | null} */
  let pendingConnect = null;

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
    const inApp =
      deps.isConfiguredAppUrl(url, deps.appUrl()) && target.pathname.startsWith('/tunnel/');
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
    const wc = approvalWindow.webContents;
    wc.on('will-navigate', (event, next) => {
      if (deps.shouldLoadInApp(next)) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(next)) void shell.openExternal(next);
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
    const projectId = String(args.projectId || '');
    if (!computer.isProjectId(projectId)) return { ok: false, error: 'projectId must be a project UUID' };
    const api = computer.tunnelApiUrl(args.apiUrl, deps.appUrl());
    if (!api.ok) return { ok: false, error: api.error };
    // A translocated or disk-image copy has a path that disappears; the
    // service would point at it and never start again.
    if (process.platform === 'darwin' && app.isPackaged && !app.isInApplicationsFolder()) {
      return { ok: false, error: 'Move Kortix to the Applications folder, then connect again.' };
    }
    if (pendingConnect) {
      approvalWindow?.focus();
      return pendingConnect;
    }

    const controller = new AbortController();
    let approved = false;
    pendingConnect = computer
      .connectComputer({
        cli: cli(),
        home,
        apiUrl: api.url,
        projectId,
        signal: controller.signal,
        onChallenge: (url) =>
          showApproval(url, () => {
            if (!approved) controller.abort();
          }),
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
      });
    return pendingConnect;
  }

  async function invoke(cmd, args = {}) {
    switch (cmd) {
      case 'computer_status':
        return refresh();
      case 'computer_connect':
        try {
          return await connect(args);
        } catch (error) {
          return { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
      case 'computer_pause':
        await run(['stop']);
        return refresh();
      case 'computer_resume':
        await run(['start']);
        return refresh();
      case 'computer_disconnect':
        return disconnect();
      case 'computer_open_logs':
        openLogs();
        return null;
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  }

  function start() {
    watchStateFile();
    checkStateFile();
    void refresh();
    setInterval(checkStateFile, STATE_POLL_MS);
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
