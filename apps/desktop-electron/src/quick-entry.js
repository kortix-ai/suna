// Quick Entry: a prompt bar over any app, opened by a global shortcut
// (Command+Shift+Space by default). Enter hands the text to the app window,
// which starts a session with it in the project it has open, or opened last.
//
// The bar is a local page (assets/quick-entry.html), so it opens with no
// network round trip. It never calls Kortix itself. The web app takes the
// prompt with the `quick_entry_take` command and sends it through its own
// project-home composer: the same billing gate, agent, model and warm session
// as a typed message (apps/web/src/components/desktop/desktop-quick-entry.tsx).
// Rules (shortcuts, placement, expiry) are in quick-entry-rules.js.

const { app, BrowserWindow, globalShortcut, ipcMain, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { freshPrompt, normalizeTarget, quickEntryBounds, resolveShortcut } = require('./quick-entry-rules');

// The bar is 680 px wide. The window adds a 32 px margin on each side for the
// bar's CSS shadow: a native shadow would trace the transparent window.
const WIDTH = 744;
const CHANNEL = {
  show: 'kortix:quick-entry:show',
  submit: 'kortix:quick-entry:submit',
  dismiss: 'kortix:quick-entry:dismiss',
  resize: 'kortix:quick-entry:resize',
};

/**
 * @param {{
 *   dir: string,
 *   openMainWindow: () => void,
 *   getMainWindow: () => BrowserWindow | null,
 * }} deps `dir` is userData, which holds quick_entry.json.
 */
function setupQuickEntry({ dir, openMainWindow, getMainWindow }) {
  const settingsPath = path.join(dir, 'quick_entry.json');
  /** @type {BrowserWindow | null} */
  let win = null;
  let height = 120;
  /** @type {{ text: string, at: number } | null} */
  let pending = null;
  /** @type {{ projectId: string, name: string | null } | null} */
  let target = null;
  /** macOS: Kortix was hidden (Command+H) when the bar opened. Showing the bar unhides the app. */
  let appWasHidden = false;
  let shortcut = resolveShortcut(readSavedShortcut());
  /** null until start(): the menu must not call a key "in use" before registering it. */
  let registered = null;

  function readSavedShortcut() {
    try {
      return JSON.parse(fs.readFileSync(settingsPath, 'utf8')).shortcut;
    } catch {
      return undefined;
    }
  }

  function createWindow() {
    const bar = new BrowserWindow({
      width: WIDTH,
      height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      // macOS: a non-activating panel. It takes keys over a full-screen app,
      // on every Space, and does not bring the Kortix window forward.
      ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
      title: 'Quick Entry',
      webPreferences: {
        preload: path.join(__dirname, 'quick-entry-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    // Clicking anywhere else dismisses the bar. The typed text stays for the next open.
    bar.on('blur', () => bar.hide());
    bar.on('closed', () => {
      if (win === bar) win = null;
    });
    bar.loadFile(path.join(__dirname, '..', 'assets', 'quick-entry.html'));
    return bar;
  }

  function show() {
    if (!win || win.isDestroyed()) {
      // Created on first use, then kept hidden, so later opens are instant.
      // Not show() again: isLoading() still reads true inside did-finish-load.
      const bar = (win = createWindow());
      bar.webContents.once('did-finish-load', () => {
        if (win === bar) reveal();
      });
      return;
    }
    if (!win.webContents.isLoading()) reveal(); // else the first load reveals it
  }

  function reveal() {
    if (!win.isVisible()) appWasHidden = process.platform === 'darwin' && app.isHidden();
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    win.setBounds(quickEntryBounds(display.workArea, WIDTH, height));
    win.webContents.send(CHANNEL.show, { target: target?.name ?? null });
    win.show();
    win.focus();
  }

  function hide() {
    if (win && !win.isDestroyed() && win.isVisible()) win.hide();
  }

  /** Esc or the shortcut again: close the bar and leave Kortix hidden if it was. */
  function dismiss() {
    hide();
    if (appWasHidden) app.hide();
    appWasHidden = false;
  }

  function toggle() {
    if (win && !win.isDestroyed() && win.isVisible()) dismiss();
    else show();
  }

  const fromBar = (event) => Boolean(win && !win.isDestroyed() && event.sender === win.webContents);

  ipcMain.on(CHANNEL.submit, (event, text) => {
    if (!fromBar(event)) return;
    const prompt = String(text ?? '').trim();
    if (!prompt) return;
    pending = { text: prompt, at: Date.now() };
    appWasHidden = false;
    hide();
    openMainWindow();
    // The panel never activated the app, so focusing its window alone leaves
    // it behind the app the person typed over.
    app.focus({ steal: true });
    // A loaded app takes the prompt now. A window still loading takes it when
    // the web app mounts (`quick_entry_take`), so a lost message loses nothing.
    getMainWindow()?.webContents.send('kortix:quick-entry');
  });
  ipcMain.on(CHANNEL.dismiss, (event) => {
    if (fromBar(event)) dismiss();
  });
  // The page reports its height as the text grows; the window fits it.
  ipcMain.on(CHANNEL.resize, (event, next) => {
    if (!fromBar(event)) return;
    height = Math.min(480, Math.max(80, Math.round(Number(next) || 0)));
    win.setSize(WIDTH, height);
  });

  function register() {
    registered = false;
    if (!shortcut) return;
    try {
      registered = globalShortcut.register(shortcut, toggle);
    } catch (e) {
      console.warn(`[kortix] Quick Entry: could not register ${shortcut}: ${e}`);
    }
    if (!registered) console.warn(`[kortix] Quick Entry: ${shortcut} is in use by another app.`);
  }

  return {
    /** Register the saved shortcut. Call once the app window exists. */
    start: register,
    show,
    /** The prompt typed in the bar, once, while it is fresh. */
    take() {
      const text = freshPrompt(pending, Date.now());
      pending = null;
      return text ? { text } : null;
    },
    /** The project the web app will start the session in, for the bar's label. */
    setTarget(value) {
      target = normalizeTarget(value);
    },
    /** `{ accelerator, registered }`. `accelerator` null: Quick Entry is off. `registered` null: not started. */
    shortcut: () => ({ accelerator: shortcut, registered }),
    /** Save and register a menu choice (null = off). Returns whether it registered. */
    setShortcut(next) {
      if (shortcut && registered) globalShortcut.unregister(shortcut);
      shortcut = next;
      try {
        fs.writeFileSync(settingsPath, JSON.stringify({ shortcut }), 'utf8');
      } catch {
        /* best-effort: the choice still applies until quit */
      }
      register();
      return registered || !shortcut;
    },
    /**
     * Destroy the hidden bar. A hidden window still counts as open, so without
     * this closing the app window would never quit the app on Windows or Linux.
     */
    close() {
      if (win && !win.isDestroyed()) win.destroy();
      win = null;
    },
  };
}

module.exports = { setupQuickEntry };
