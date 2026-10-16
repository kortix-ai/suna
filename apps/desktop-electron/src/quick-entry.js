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

const {
  app,
  BrowserWindow,
  Menu,
  clipboard,
  desktopCapturer,
  globalShortcut,
  ipcMain,
  nativeImage,
  screen,
  shell,
  systemPreferences,
} = require('electron');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { attachContextMenu } = require('./context-menu');
const {
  composerLabels,
  composerMenuItems,
  freshPrompt,
  normalizeAttachments,
  normalizeTarget,
  keptPick,
  pickedSession,
  pickerItems,
  quickEntryBounds,
  resolveShortcut,
  screenshotName,
} = require('./quick-entry-rules');

// The bar is 760 px wide. The window adds a 48 px margin on each side for the
// bar's CSS shadow (quick-entry.html): a native shadow would trace the
// transparent window.
const WIDTH = 856;
const CHANNEL = {
  show: 'kortix:quick-entry:show',
  hide: 'kortix:quick-entry:hide',
  submit: 'kortix:quick-entry:submit',
  dismiss: 'kortix:quick-entry:dismiss',
  resize: 'kortix:quick-entry:resize',
  state: 'kortix:quick-entry:state',
  menu: 'kortix:quick-entry:menu',
  screenshot: 'kortix:quick-entry:screenshot',
  attach: 'kortix:quick-entry:attach',
  notice: 'kortix:quick-entry:notice',
  noticeAction: 'kortix:quick-entry:notice-action',
};

// The light dim behind the bar: a quarter of the dialog scrim (`bg-black/65`).
const SCRIM_HTML = 'data:text/html;charset=utf-8,' + encodeURIComponent(
  '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'">' +
    '<body style="margin:0;height:100vh;background:rgb(0 0 0 / 0.25)"></body>',
);
// Open over 250 ms, close over --duration-normal (150 ms): the bar's CSS
// transition and the dim's opacity steps run together.
const OPEN_MS = 250;
const CLOSE_MS = 150;
const SCRIM_FADE_STEPS = 10;
// The macOS privacy pane a screenshot needs (System Settings ▸ Privacy & Security ▸ Screen Recording).
const SCREEN_RECORDING_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

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
  /** @type {BrowserWindow | null} The dim behind the bar, on the bar's display. */
  let scrim = null;
  let height = 188;
  /** A screenshot is being taken: the bar is hidden on purpose and comes back. */
  let capturing = false;
  /** @type {{ timer: ReturnType<typeof setTimeout>, rehide: boolean } | null} The close animation in progress. */
  let closing = null;
  /** @type {ReturnType<typeof setInterval> | undefined} */
  let scrimFade;
  /** The notice's action, if it has one. */
  let noticeAction = null;
  /** @type {{ text: string, at: number } | null} */
  let pending = null;
  /** @type {ReturnType<typeof normalizeTarget>} */
  let target = null;
  /** The session the picker points at; null = a new session. Kept across opens while that session is live (`keptPick`). */
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
    // Right-click in the prompt: paste, spelling, copy (KRTX-2555).
    attachContextMenu(bar.webContents, { Menu, shell, clipboard, getWindow: () => bar });
    // Clicking anywhere else, the dim included, dismisses the bar. The typed text stays.
    bar.on('blur', () => {
      if (!capturing) hide();
    });
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
    if (closing) {
      // Opened again while closing: it stays open, and Kortix stays as it was.
      clearTimeout(closing.timer);
      appWasHidden = closing.rehide;
      closing = null;
    } else if (!win.isVisible() && !capturing) {
      // A fresh open, not the return from a screenshot.
      appWasHidden = process.platform === 'darwin' && app.isHidden();
      pickedId = keptPick(target, pickedId);
    }
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    showScrim(display.bounds);
    win.setBounds(quickEntryBounds(display.workArea, Math.min(WIDTH, display.workArea.width), height));
    win.webContents.send(CHANNEL.show, barState());
    win.show();
    win.focus();
  }

  /** Dim the display behind the bar. A click on the dim focuses it, which dismisses the bar, as Esc does. */
  function showScrim(bounds) {
    if (!scrim || scrim.isDestroyed()) {
      scrim = new BrowserWindow({
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
        ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
        title: 'Quick Entry',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      scrim.on('focus', () => dismiss());
      scrim.loadURL(SCRIM_HTML).catch(() => {});
    }
    scrim.setBounds(bounds);
    if (!scrim.isVisible()) {
      scrim.setOpacity(0);
      scrim.showInactive();
    }
    // Above the dim (floating), below native menus (pop-up-menu).
    win.setAlwaysOnTop(true, 'modal-panel');
    fadeScrim(1, OPEN_MS);
  }

  /** Step the dim's opacity from where it is to `to` over `ms`. */
  function fadeScrim(to, ms) {
    clearInterval(scrimFade);
    if (!scrim || scrim.isDestroyed()) return;
    const from = scrim.getOpacity();
    let step = 0;
    scrimFade = setInterval(() => {
      step += 1;
      if (!scrim || scrim.isDestroyed() || step >= SCRIM_FADE_STEPS) clearInterval(scrimFade);
      if (scrim && !scrim.isDestroyed()) scrim.setOpacity(from + (to - from) * Math.min(1, step / SCRIM_FADE_STEPS));
    }, ms / SCRIM_FADE_STEPS);
  }

  function notify(text, action = null) {
    noticeAction = action?.run ?? null;
    if (win && !win.isDestroyed()) win.webContents.send(CHANNEL.notice, { text, action: action?.label ?? null });
  }

  /** What the bar shows: the target, the picked session, and the new session's agent. */
  function barState() {
    const session = pickedSession(target, pickedId);
    return {
      target: target?.name ?? null,
      session: session ? { title: session.title, status: session.status } : null,
      // The app window owns the selection; without it a pick could not apply.
      composer: getMainWindow() ? composerLabels(target?.composer ?? null) : null,
      canScreenshot: process.platform === 'darwin',
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

  /**
   * The agent menu. A pick goes to the app window, which applies it with the
   * composer's own setter (the same persistence as a pick in the composer)
   * and sends the bar the resolved selection back.
   */
  function openComposerMenu(kind, anchor) {
    const rows = composerMenuItems(target?.composer ?? null, kind);
    if (!rows.length) return;
    const template = rows.map((row) => ({
      label: row.label,
      type: 'checkbox',
      checked: row.checked,
      click: () => getMainWindow()?.webContents.send('kortix:quick-entry-select', kind, row.value),
    }));
    Menu.buildFromTemplate(template).popup({
      window: win,
      x: Math.round(Number(anchor?.x) || 0),
      y: Math.round(Number(anchor?.y) || 0),
    });
  }

  /**
   * Fade the bar and the dim out, then hide both. `animate: false` hides at
   * once (a screenshot must not catch the bar). `rehide`: hide Kortix after,
   * as it was before the bar opened.
   */
  function hide({ animate = true, rehide = false } = {}) {
    const visible = Boolean(win && !win.isDestroyed() && win.isVisible());
    if (closing && animate && visible) {
      closing.rehide ||= rehide;
      return;
    }
    if (closing) {
      clearTimeout(closing.timer);
      rehide ||= closing.rehide;
      closing = null;
    }
    const finish = () => {
      closing = null;
      clearInterval(scrimFade);
      if (scrim && !scrim.isDestroyed()) scrim.hide();
      if (win && !win.isDestroyed() && win.isVisible()) win.hide();
      if (rehide) app.hide();
    };
    if (!visible || !animate) return finish();
    win.webContents.send(CHANNEL.hide);
    fadeScrim(0, CLOSE_MS);
    const timer = setTimeout(() => {
      // A hide() during the animation merged its `rehide` into `closing`.
      rehide = closing?.rehide ?? rehide;
      finish();
    }, CLOSE_MS + 10);
    closing = { rehide, timer };
  }

  /**
   * macOS: hide the bar, run the system's interactive capture (drag a region,
   * or Space to pick a window; Esc cancels), then bring the bar back with the
   * image attached. Needs Screen Recording access, which macOS asks for on first use.
   */
  function takeScreenshot() {
    if (process.platform !== 'darwin' || capturing) return;
    if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
      // A capture attempt is what adds Kortix to the Screen Recording list and
      // shows the macOS prompt the first time. macOS 11+ reports a never-asked
      // app as denied, so a status check alone never asked (computer-tray.js).
      void desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } }).catch(() => []);
      notify('Allow Kortix under Screen Recording, then quit and reopen Kortix.', {
        label: 'Open Settings',
        run: () => shell.openExternal(SCREEN_RECORDING_SETTINGS),
      });
      return;
    }
    capturing = true;
    hide({ animate: false });
    const file = path.join(os.tmpdir(), `kortix-quick-entry-${process.pid}-${Date.now()}.png`);
    execFile('/usr/sbin/screencapture', ['-i', '-x', '-o', '-t', 'png', file], () => {
      let bytes = null;
      try {
        bytes = new Uint8Array(fs.readFileSync(file));
        fs.rmSync(file, { force: true });
      } catch {
        /* cancelled: no file */
      }
      if (win && !win.isDestroyed()) {
        reveal();
        if (bytes?.byteLength) win.webContents.send(CHANNEL.attach, { name: screenshotName(new Date()), type: 'image/png', bytes });
        else notify(null);
      }
      capturing = false;
    });
  }

  /** Esc or the shortcut again: close the bar and leave Kortix hidden if it was. */
  function dismiss() {
    hide({ rehide: appWasHidden });
    appWasHidden = false;
  }

  function toggle() {
    if (win && !win.isDestroyed() && win.isVisible() && !closing) dismiss();
    else show();
  }

  const fromBar = (event) => Boolean(win && !win.isDestroyed() && event.sender === win.webContents);

  ipcMain.on(CHANNEL.submit, (event, text, attachments) => {
    if (!fromBar(event)) return;
    const prompt = String(text ?? '').trim();
    const files = normalizeAttachments(attachments);
    if (!prompt && !files.length) return;
    const session = pickedSession(target, pickedId);
    pending = {
      text: prompt,
      files,
      at: Date.now(),
      ...(session ? { projectId: target.projectId, sessionId: session.id } : {}),
    };
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
  ipcMain.on(CHANNEL.menu, (event, kind, anchor) => {
    if (!fromBar(event)) return;
    if (kind === 'session') openPicker(anchor);
    else openComposerMenu(kind, anchor);
  });
  ipcMain.on(CHANNEL.screenshot, (event) => {
    if (fromBar(event)) takeScreenshot();
  });
  ipcMain.on(CHANNEL.noticeAction, (event) => {
    if (fromBar(event)) noticeAction?.();
  });
  // The page reports its height as it grows; the window fits it, bottom edge fixed.
  ipcMain.on(CHANNEL.resize, (event, next) => {
    if (!fromBar(event)) return;
    height = Math.min(560, Math.max(80, Math.round(Number(next) || 0)));
    const bounds = win.getBounds();
    win.setBounds({ x: bounds.x, y: bounds.y + bounds.height - height, width: bounds.width, height });
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
      const prompt = freshPrompt(pending, Date.now());
      pending = null;
      if (!prompt) return null;
      const { text, files, projectId, sessionId } = prompt;
      return { text, files, ...(sessionId ? { projectId, sessionId } : {}) };
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
      if (scrim && !scrim.isDestroyed()) scrim.destroy();
      win = null;
      scrim = null;
    },
  };
}

module.exports = { setupQuickEntry };
