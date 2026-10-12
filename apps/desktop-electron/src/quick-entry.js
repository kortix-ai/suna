// Quick Entry: a prompt bar over any app, opened by a global shortcut
// (Command+Shift+Space by default). Enter hands the text to the app window,
// which starts a session with it in the project it has open, or opened last.
//
// The picker on the right sends it to one of the 5 most recent sessions
// instead.
//
// The bar is a local page (assets/quick-entry.html), so it opens with no
// network round trip. It never calls Kortix itself. The web app takes the
// prompt with the `quick_entry_take` command and sends it through its own
// composer: project home for a new session, the session page for a picked
// one, with the same agent, model and billing gate as a typed message
// (apps/web/src/components/desktop/desktop-quick-entry.tsx). The web app
// also publishes the project and its recent sessions (`quick_entry_set_target`).
// Rules (shortcuts, placement, expiry, picker items) are in quick-entry-rules.js.

const { app, BrowserWindow, Menu, globalShortcut, ipcMain, nativeImage, screen } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {
  freshPrompt,
  normalizeTarget,
  pickedSession,
  pickerItems,
  quickEntryBounds,
  resolveShortcut,
} = require('./quick-entry-rules');

// The bar is 680 px wide. The window adds a 32 px margin on each side for the
// bar's CSS shadow: a native shadow would trace the transparent window.
const WIDTH = 744;
const CHANNEL = {
  show: 'kortix:quick-entry:show',
  submit: 'kortix:quick-entry:submit',
  dismiss: 'kortix:quick-entry:dismiss',
  resize: 'kortix:quick-entry:resize',
  state: 'kortix:quick-entry:state',
  pick: 'kortix:quick-entry:pick',
};

// The sidebar's status colors (kortix-brand tokens: --kortix-green, -yellow,
// -red). Every other status draws a hollow ring in the menu's text color.
const STATUS_COLOR = { running: '#199338', 'needs-you': '#199338', starting: '#cca300', failed: '#f14b4c' };
const statusIcons = new Map();

/** A 12 pt status dot for a menu item, drawn once per status. */
function statusIcon(status) {
  if (!statusIcons.has(status)) {
    const size = 24; // 12 pt at 2x
    const color = STATUS_COLOR[status];
    const [r, g, b] = color ? [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16)) : [0, 0, 0];
    const pixels = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const d = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2);
        const edge = Math.min(1, Math.max(0, 8.5 - d));
        const alpha = edge * (color ? 1 : Math.min(1, Math.max(0, d - 6)));
        const i = (y * size + x) * 4; // premultiplied BGRA
        pixels[i] = b * alpha;
        pixels[i + 1] = g * alpha;
        pixels[i + 2] = r * alpha;
        pixels[i + 3] = 255 * alpha;
      }
    }
    const image = nativeImage.createFromBitmap(pixels, { width: size, height: size, scaleFactor: 2 });
    // A hollow ring is a template image, so macOS draws it in the menu's text color.
    if (!color) image.setTemplateImage(true);
    statusIcons.set(status, image);
  }
  return statusIcons.get(status);
}

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
  /** @type {ReturnType<typeof normalizeTarget>} */
  let target = null;
  /** The session the picker points at; null = a new session. Kept with the draft, cleared on send. */
  let pickedId = null;
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
    win.webContents.send(CHANNEL.show, barState());
    win.show();
    win.focus();
  }

  /** What the bar's picker button shows. */
  function barState() {
    const session = pickedSession(target, pickedId);
    return {
      target: target?.name ?? null,
      session: session ? { title: session.title, status: session.status } : null,
    };
  }

  function sendState() {
    if (win && !win.isDestroyed() && !win.webContents.isLoading()) win.webContents.send(CHANNEL.state, barState());
  }

  /** The picker: a native menu under the button, so keys and VoiceOver work as everywhere else. */
  function openPicker(anchor) {
    const [fresh, ...recent] = pickerItems(target, pickedId);
    const choose = (sessionId) => () => {
      pickedId = sessionId;
      sendState();
    };
    const template = [
      { label: fresh.label, type: 'checkbox', checked: fresh.checked, click: choose(null) },
      ...(recent.length ? [{ type: 'separator' }, { label: 'Recent sessions', enabled: false }] : []),
      ...recent.map((item) => ({
        label: item.label,
        sublabel: item.statusText,
        icon: statusIcon(item.status),
        type: 'checkbox',
        checked: item.checked,
        click: choose(item.sessionId),
      })),
    ];
    Menu.buildFromTemplate(template).popup({
      window: win,
      x: Math.round(Number(anchor?.x) || 0),
      y: Math.round(Number(anchor?.y) || 0),
    });
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
    const session = pickedSession(target, pickedId);
    pending = {
      text: prompt,
      at: Date.now(),
      ...(session ? { projectId: target.projectId, sessionId: session.id } : {}),
    };
    pickedId = null;
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
  ipcMain.on(CHANNEL.pick, (event, anchor) => {
    if (fromBar(event)) openPicker(anchor);
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
    /**
     * The prompt typed in the bar, once, while it is fresh: `{ text }` for a
     * new session, `{ text, projectId, sessionId }` for a picked one.
     */
    take() {
      const text = freshPrompt(pending, Date.now());
      const { projectId, sessionId } = pending ?? {};
      pending = null;
      if (!text) return null;
      return sessionId ? { text, projectId, sessionId } : { text };
    },
    /** The project a new session starts in, and its recent sessions, for the picker. */
    setTarget(value) {
      target = normalizeTarget(value);
      sendState();
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
