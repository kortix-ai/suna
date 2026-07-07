// Kortix desktop shell — Electron main process.
//
// A thin native wrapper around the remote web app: window sizing, the kortix://
// deep-link auth flow, a navigation gate (logged-in product + auth pages in-app;
// everything else in the user's real browser), the "Frontend URL" dev menu, and
// the native bridge (zoom / open-external / window controls / frontend-url
// override).
//
// Why Electron: a prior Tauri/WKWebView shell routed EVERY navigation —
// including cross-origin IFRAME loads — through one hook, so embedded overlays
// (the Pipedream Connect iframe) got punted to the system browser and failed
// with "Must be inside iframe". Electron's will-navigate fires for the top
// frame only, so iframes "just work", and real popups (OAuth) keep a working
// window.opener. We expose the same `KortixDesktop` UA token + a
// `window.__TAURI__` bridge shape (see preload.js) so the web app's desktop
// bridge (apps/web/src/lib/desktop.ts) runs UNCHANGED.

const {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  nativeTheme,
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { setupAutoUpdates, checkForUpdatesInteractive } = require('./updater');

// Name comes from the bundle (productName): "Kortix" for prod, "Kortix Dev" for
// dev builds. Per-name data dir so dev + prod coexist without sharing a session,
// and so we never inherit another "Kortix" app's stale Chromium state (per-site
// zoom / GPU cache) — a real cause of blurry rendering. `${name} Desktop` keeps
// us off the bare "Kortix" Application Support folder.
app.setPath('userData', path.join(app.getPath('appData'), `${app.getName()} Desktop`));

/* ─── Config ──────────────────────────────────────────────────────────── */

// A packaged app has no build-time env at runtime, so CI bakes the target URL
// into package.json (electron-builder --config.extraMetadata.kortixDefaultUrl).
// Dev builds → dev.kortix.com; prod → kortix.com.
function bakedDefaultUrl() {
  try {
    return require('../package.json').kortixDefaultUrl || null;
  } catch {
    return null;
  }
}

// Default target URL precedence:
//   1. KORTIX_DESKTOP_DEFAULT_URL env (local dev convenience)
//   2. value baked into package.json at build time (CI dev vs prod)
//   3. production kortix.com
// A runtime KORTIX_DESKTOP_URL / the Frontend-URL menu still overrides this.
const DEFAULT_URL =
  process.env.KORTIX_DESKTOP_DEFAULT_URL ||
  bakedDefaultUrl() ||
  'https://kortix.com/projects';

const PRESET_PROD = 'https://kortix.com/projects';
const PRESET_DEV = 'https://dev.kortix.com/projects';
const PRESET_LOCAL = 'http://localhost:3000/projects';

const URL_SCHEME = 'kortix';
// Matches DESKTOP_UA_TOKEN in apps/web/src/lib/desktop.ts and the
// KortixDesktop check in apps/web/src/middleware.ts.
const UA_TOKEN = 'KortixDesktop/0.1.0';

// Opaque dark background so the first paint (before the remote app loads) is
// the brand surface, never a white flash. Tauri sets this on <body> via CSS;
// here it's the native window background.
const BG_COLOR = '#0a0a0a';

// Window-drag zones. Tauri drives dragging with a JS mousedown→startDragging
// shim because WKWebView ignores `-webkit-app-region`. Electron/Chromium honors
// app-region natively, so we just mark the same zones draggable and carve every
// interactive element back out (mirrors the Tauri INTERACTIVE_TAGS + role list).
// Injected on every load. Two jobs:
//   1. Mark the window-drag zones with `-webkit-app-region: drag` via an AUTHOR
//      <style> element. IMPORTANT: `webContents.insertCSS()` does NOT honor
//      -webkit-app-region — only a real <style>/<link> in the document does, so
//      we inject it here instead of via insertCSS.
//   2. Keep a full-width drag strip pinned across the very top of the window so
//      it's movable from ANYWHERE up top — not just over the sidebar/tab-bar.
//      The web app reserves a ~40px title-bar band at the top on desktop
//      (--kx-titlebar-inset), so on pages whose main panel has no tab bar that
//      band was dead space you couldn't grab. The strip fills it.
//
// The strip is the FIRST child of <body> and `pointer-events:none`, which is
// what lets it coexist with the tab bar instead of covering it (the reason the
// old strip had to be removed once the app shell mounted):
//   • Draggable regions resolve in DOM order, so the tab-bar tabs / sidebar
//     buttons — all marked `no-drag` and later in the DOM — punch holes back
//     through the strip's drag region and stay grabbable as buttons.
//   • `pointer-events:none` means clicks in those holes pass straight through to
//     the real controls; only the bare band stays a drag handle.
const IS_MAC = process.platform === 'darwin';
// Skip the macOS traffic-light gutter on the left; Win/Linux have no left
// controls (their min/max/close render on the right and are `no-drag` buttons).
const DRAG_STRIP_LEFT = IS_MAC ? 80 : 0;
// Match the reserved title-bar band (--kx-titlebar-inset: 40px macOS / 28px
// else); 32px on Win/Linux leaves the strip comfortably grabbable.
const DRAG_STRIP_HEIGHT = IS_MAC ? 40 : 32;
const DESKTOP_CHROME_JS = `
(function () {
  if (window.__kortixChrome) return;
  window.__kortixChrome = true;

  var style = document.createElement('style');
  style.id = 'kortix-chrome-style';
  style.textContent =
    '[role="tablist"],[data-sidebar="header"],[data-sidebar="sidebar"],' +
    '.kx-desktop-drag,.kx-desktop-chrome,#kortix-drag-strip{-webkit-app-region:drag;}' +
    'button,a,input,textarea,select,option,label,summary,video,audio,iframe,' +
    '[role="button"],[role="tab"],[role="link"],[role="menuitem"],[role="textbox"],' +
    '[contenteditable],[data-no-drag]{-webkit-app-region:no-drag;}';
  (document.head || document.documentElement).appendChild(style);

  var ID = 'kortix-drag-strip';
  function ensureStrip() {
    if (!document.body) return;
    var strip = document.getElementById(ID);
    if (!strip) {
      strip = document.createElement('div');
      strip.id = ID;
      strip.setAttribute('aria-hidden', 'true');
      // pointer-events:none → clicks fall through to controls beneath; the drag
      // region still works (it's OS-level, not pointer-event driven). z-index:0
      // so it never visually layers over content (it's transparent regardless).
      strip.style.cssText =
        'position:fixed;top:0;left:${DRAG_STRIP_LEFT}px;right:0;height:${DRAG_STRIP_HEIGHT}px;' +
        'z-index:0;pointer-events:none;-webkit-app-region:drag;';
    }
    // First child so every interactive element (later in the DOM, all no-drag)
    // overrides the strip and stays clickable; bare band stays draggable.
    if (strip !== document.body.firstChild) {
      document.body.insertBefore(strip, document.body.firstChild);
    }
  }
  ensureStrip();
  // SPA route changes swap the DOM without a reload — keep the strip first.
  var t;
  new MutationObserver(function () {
    clearTimeout(t);
    t = setTimeout(ensureStrip, 250);
  }).observe(document.documentElement, { childList: true, subtree: true });
})();
`;

/* ─── Frontend URL override (self-hosting) ────────────────────────────────
   Persisted as a single line in userData/frontend_url — same contract as the
   Tauri shell's app-config-dir file. A persisted override wins over the
   env/compile-time default. */

function overridePath() {
  return path.join(app.getPath('userData'), 'frontend_url');
}

function readUrlOverride() {
  try {
    const raw = fs.readFileSync(overridePath(), 'utf8').trim();
    return raw || null;
  } catch {
    return null;
  }
}

function writeUrlOverride(url) {
  try {
    fs.mkdirSync(path.dirname(overridePath()), { recursive: true });
    fs.writeFileSync(overridePath(), url, 'utf8');
  } catch (e) {
    return String(e);
  }
  return null;
}

function clearUrlOverride() {
  try {
    fs.rmSync(overridePath(), { force: true });
  } catch {
    /* already gone */
  }
}

function appBaseUrl() {
  return process.env.KORTIX_DESKTOP_URL || DEFAULT_URL;
}

/** Effective URL the window should load — persisted override beats the default. */
function resolveAppUrl() {
  return readUrlOverride() || appBaseUrl();
}

/* ─── Maximized-state persistence ─────────────────────────────────────────
   Like Tauri we persist ONLY the maximized flag — never size/position, which
   have stranded windows off-screen or restored a tiny window. Every launch
   re-centers at ~85% of the primary display (clamped). */

function statePath() {
  return path.join(app.getPath('userData'), 'window_state.json');
}

function readMaximized() {
  try {
    return !!JSON.parse(fs.readFileSync(statePath(), 'utf8')).maximized;
  } catch {
    return false;
  }
}

function writeMaximized(maximized) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify({ maximized }), 'utf8');
  } catch {
    /* best-effort */
  }
}

/* ─── Navigation gate (port of lib.rs) ───────────────────────────────────── */

// Sandbox previews / tunnels — user content, always in-app.
function isPreviewHost(host) {
  return (
    host.endsWith('.localhost') ||
    host === 'kortix.cloud' ||
    host.endsWith('.kortix.cloud') ||
    host === 'justavps.com' ||
    host.endsWith('.justavps.com')
  );
}

// App-shell hosts that serve BOTH product and marketing.
function isMainAppHost(host) {
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === 'kortix.com' ||
    host.endsWith('.kortix.com')
  );
}

// Product + auth route prefixes allowed to render in the desktop window. MUST
// stay in sync with DESKTOP_ALLOWED_ROUTES in apps/web/src/middleware.ts.
const APP_PATH_PREFIXES = [
  '/projects',
  '/accounts',
  '/invites',
  '/admin',
  '/setup',
  '/connectors',
  '/oauth',
  '/checkout',
  '/tunnel',
  '/github',
  '/cli',
  '/templates',
  '/maintenance',
  '/countryerror',
  '/debug',
];

function isAppPath(pathname) {
  if (pathname === '/auth' || pathname.startsWith('/auth/')) return true;
  return APP_PATH_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(`${p}/`),
  );
}

/**
 * Should `urlStr` render inside the desktop window? (Top-frame navigations
 * only — iframes are never gated, which is the whole point: the Pipedream
 * Connect overlay loads in-app instead of failing "Must be inside iframe".)
 */
function shouldLoadInApp(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol === `${URL_SCHEME}:`) return true; // deep links
  // Supabase GoTrue auth service (e.g. supa.kortix.com/auth/v1/authorize, or a
  // *.supabase.co project): the OAuth hand-off, NOT one of our own /auth pages.
  // It MUST open in the user's real browser — Google/GitHub reject embedded
  // webviews, and the post-OAuth `kortix://auth/callback` bounce only works from
  // a real browser tab. Our own pages (/auth/callback, /auth/login) live on the
  // app host and still load in-app via isAppPath below.
  if (u.pathname.startsWith('/auth/v1/')) return false;
  const host = u.hostname;
  if (isPreviewHost(host)) return true;
  if (isMainAppHost(host) && isAppPath(u.pathname)) return true;
  return false;
}

/* ─── Deep links (kortix://) ──────────────────────────────────────────────
   The OS hands us `kortix://auth/callback?code=…` after OAuth completes in the
   user's browser (also email magic links). Translate the path onto the loaded
   origin and navigate the webview there; the web app then runs its existing
   /auth/callback flow inside the desktop session. */

function translateDeepLink(deepLink) {
  let incoming;
  try {
    incoming = new URL(deepLink);
  } catch {
    return null;
  }
  if (incoming.protocol !== `${URL_SCHEME}:`) return null;

  let target;
  try {
    target = new URL(resolveAppUrl());
  } catch {
    return null;
  }
  // kortix://auth/callback?code=…  →  <appUrl>/auth/callback?code=…
  // For custom schemes the "host" is the first path segment.
  const host = incoming.hostname || '';
  let p = `/${host}${incoming.pathname}`.replace(/\/+$/, '');
  if (p === '') p = '/';
  target.pathname = p;
  target.search = incoming.search;
  return target.toString();
}

function handleDeepLink(deepLink) {
  const target = translateDeepLink(deepLink);
  if (!target || !mainWindow) return;
  mainWindow.webContents.executeJavaScript(
    `window.location.replace(${JSON.stringify(target)})`,
  );
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.focus();
}

/* ─── Windows ─────────────────────────────────────────────────────────────*/

/** @type {BrowserWindow | null} */
let mainWindow = null;
/** @type {BrowserWindow | null} */
let splashWindow = null;

function launchSize() {
  // ~85% of the primary display, clamped to [1280,1700] × [820,1080] — same as
  // lib.rs. Falls back to 1440×920 if the display can't be queried.
  try {
    const { screen } = require('electron');
    const wa = screen.getPrimaryDisplay().workAreaSize;
    const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    return {
      width: clamp(Math.round(wa.width * 0.85), 1280, 1700),
      height: clamp(Math.round(wa.height * 0.85), 820, 1080),
    };
  } catch {
    return { width: 1440, height: 920 };
  }
}

function createSplash() {
  // Same size + center as the main window so swapping splash → app is seamless
  // (no jump in size or position, no white flash).
  const { width, height } = launchSize();
  splashWindow = new BrowserWindow({
    width,
    height,
    frame: false,
    resizable: false,
    movable: false,
    show: true,
    center: true,
    hasShadow: true,
    backgroundColor: BG_COLOR,
    title: 'Kortix',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  splashWindow.loadFile(path.join(__dirname, '..', 'assets', 'splash.html'));
  splashWindow.on('closed', () => {
    splashWindow = null;
  });
}

function dismissSplash() {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.destroy();
  }
  splashWindow = null;
}

function createMainWindow() {
  const { width, height } = launchSize();

  const isMac = process.platform === 'darwin';

  // App icon for the taskbar/dock on Windows/Linux (macOS uses the bundled
  // .icns at package time). Missing file → Electron default icon.
  const winIcon = path.join(__dirname, '..', 'build', 'icon.png');

  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: 720,
    minHeight: 480,
    center: true,
    show: false, // revealed once the remote app finishes loading (splash covers the gap)
    backgroundColor: BG_COLOR,
    title: 'Kortix',
    // macOS: hidden title bar with the traffic lights nudged to sit centered in
    // the app's ~40px tab bar — mirrors lib.rs traffic_light_position(10, 22)
    // and the 72px collapsed-sidebar rail math.
    ...(isMac
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: { x: 10, y: 18 },
        }
      : fs.existsSync(winIcon)
        ? { icon: winIcon }
        : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // HTML5 drag/drop must reach the page (chat-input dropzone) — Electron
      // does this by default; no native interceptor to disable like Tauri.
    },
  });

  // macOS: hide the native traffic lights — on macOS 26 (Tahoe) they render
  // permanently gray/inactive for hidden-title-bar Electron windows (even
  // focused, even on hover). The web app draws its own colored lights in the
  // same spot (DesktopChrome → MacTrafficLights), wired to the kortix:window
  // IPC, so close/minimize/zoom keep working.
  if (isMac) mainWindow.setWindowButtonVisibility(false);

  // Reveal once content is in. did-finish-load fires when the document + its
  // subresources are loaded — good enough to swap the splash for real chrome
  // instead of a blank window.
  mainWindow.webContents.once('did-finish-load', () => {
    dismissSplash();
    if (!mainWindow) return;
    if (readMaximized()) mainWindow.maximize();
    mainWindow.show();
    mainWindow.focus();
  });

  // Safety net: never leave the user staring at a hidden window if the load
  // stalls/errors — show it anyway after a grace period.
  setTimeout(() => {
    if (mainWindow && !mainWindow.isVisible()) {
      dismissSplash();
      mainWindow.show();
    }
  }, 12_000);

  // Inject the drag-zone <style> + fallback strip on every load (full reloads
  // from the Frontend URL switcher; SPA route changes are handled by the
  // MutationObserver inside DESKTOP_CHROME_JS).
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.executeJavaScript(DESKTOP_CHROME_JS).catch(() => {});
    // Render diagnostic (blur): on Retina expect dpr=2 and zoom=1.
    mainWindow?.webContents
      .executeJavaScript('window.devicePixelRatio')
      .then((dpr) =>
        console.log(
          `[kortix-render] dpr=${dpr} zoom=${mainWindow?.webContents.getZoomFactor()}`,
        ),
      )
      .catch(() => {});
  });

  // Persist ONLY the maximized flag, and notify the renderer so any custom
  // window controls can refresh their maximize/restore state (Tauri onResized).
  const emitResized = () =>
    mainWindow?.webContents.send('kortix:resized');
  mainWindow.on('resize', emitResized);
  mainWindow.on('maximize', () => {
    writeMaximized(true);
    emitResized();
  });
  mainWindow.on('unmaximize', () => {
    writeMaximized(false);
    emitResized();
  });

  // Navigation gate — top-frame only. Anything that isn't a logged-in product/
  // auth page or a sandbox preview opens in the user's real browser. Iframes
  // (Pipedream Connect) are NOT gated and load freely in-app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (shouldLoadInApp(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  // window.open(...) / <a target="_blank">.
  //
  // This is the crux of why Electron beats Tauri for the connectors flow.
  // Pipedream Connect (and other OAuth flows) open the provider in a REAL popup
  // and rely on `window.opener` + postMessage back into the page. Tauri forces
  // `window.open` to return `null` (everything is punted to the system browser,
  // no second window can exist) → Pipedream reports "Connect account popup
  // blocked." Here we ALLOW genuine popups as child windows so the
  // popup → OAuth → postMessage-back handshake completes like a normal browser,
  // and only send plain "open in new tab" links to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url, disposition, features }) => {
    if (!url || !/^https?:\/\//.test(url)) return { action: 'deny' };
    // A real popup (window.open with window features) that wants an opener
    // handle — the OAuth/Connect case. `_blank` links carry `noopener` and/or a
    // tab disposition, so they fall through to the system browser below.
    const wantsOpener = !/\bnoopener\b/i.test(features || '');
    if (disposition === 'new-window' && wantsOpener) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          minimizable: false,
          fullscreenable: false,
          backgroundColor: BG_COLOR,
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(resolveAppUrl());
}

/** Full-page reload of the main window onto `url` (used by the menu/IPC). */
function navigateMainWindow(url) {
  if (!mainWindow) return;
  mainWindow.webContents.executeJavaScript(
    `window.location.replace(${JSON.stringify(url)})`,
  );
  mainWindow.focus();
}

/* ─── Native menu (incl. hidden "Frontend URL" switcher) ───────────────────*/

function buildMenu() {
  const isMac = process.platform === 'darwin';

  // Hidden, nested dev switcher so the backend the app points at can change
  // without a rebuild — mirrors the Tauri "Frontend URL" submenu.
  const frontendSubmenu = {
    label: 'Frontend URL',
    submenu: [
      {
        label: 'Production (kortix.com)',
        click: () => {
          writeUrlOverride(PRESET_PROD);
          navigateMainWindow(PRESET_PROD);
        },
      },
      {
        label: 'Dev (dev.kortix.com)',
        click: () => {
          writeUrlOverride(PRESET_DEV);
          navigateMainWindow(PRESET_DEV);
        },
      },
      {
        label: 'Local (localhost:3000)',
        click: () => {
          writeUrlOverride(PRESET_LOCAL);
          navigateMainWindow(PRESET_LOCAL);
        },
      },
      { type: 'separator' },
      {
        label: 'Custom URL…',
        // Native menus can't take text input — ask the web layer to pop the
        // same tiny prompt the Tauri shell uses, which calls back via the
        // set_frontend_url IPC.
        click: () => {
          if (!mainWindow) return;
          mainWindow.webContents.executeJavaScript(
            "window.dispatchEvent(new CustomEvent('kortix-open-frontend-url'))",
          );
          mainWindow.focus();
        },
      },
      {
        label: 'Reset to Default',
        click: () => {
          clearUrlOverride();
          navigateMainWindow(appBaseUrl());
        },
      },
    ],
  };

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              {
                label: 'Check for Updates…',
                click: () => checkForUpdatesInteractive(),
              },
              { type: 'separator' },
              frontendSubmenu,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isMac
          ? []
          : [
              { type: 'separator' },
              { label: 'Check for Updates…', click: () => checkForUpdatesInteractive() },
              frontendSubmenu,
            ]),
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ─── IPC: native bridge (consumed via the __TAURI__ shim in preload.js) ───*/

function registerIpc() {
  // Single funnel matching the Tauri `core.invoke(cmd, args)` contract so the
  // web app's existing calls (set_zoom / open_external / get_frontend_url /
  // set_frontend_url) work unchanged.
  ipcMain.handle('kortix:invoke', (event, cmd, args = {}) => {
    switch (cmd) {
      case 'set_zoom': {
        const scale = Math.min(3, Math.max(0.5, Number(args.scale) || 1));
        const wc = BrowserWindow.fromWebContents(event.sender)?.webContents;
        wc?.setZoomFactor(scale);
        return null;
      }
      case 'open_external': {
        const url = String(args.url || '');
        if (url) shell.openExternal(url);
        return null;
      }
      case 'get_frontend_url':
        return resolveAppUrl();
      case 'set_frontend_url': {
        const raw = String(args.url || '').trim();
        if (!raw) throw new Error('URL is empty');
        const candidate = raw.includes('://') ? raw : `https://${raw}`;
        let parsed;
        try {
          parsed = new URL(candidate);
        } catch (e) {
          throw new Error(`Invalid URL: ${e}`);
        }
        if (!/^https?:$/.test(parsed.protocol)) {
          throw new Error('URL must use http or https');
        }
        writeUrlOverride(candidate);
        navigateMainWindow(candidate);
        return null;
      }
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  });

  // Window controls (Tauri `getCurrentWindow().*`).
  ipcMain.handle('kortix:window', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    switch (action) {
      case 'minimize':
        win.minimize();
        return null;
      case 'toggleMaximize':
        win.isMaximized() ? win.unmaximize() : win.maximize();
        return null;
      case 'close':
        win.close();
        return null;
      case 'isMaximized':
        return win.isMaximized();
      default:
        return null;
    }
  });
}

/* ─── User agent ──────────────────────────────────────────────────────────
   Strip "Electron" (Google blocks embedded-webview UAs) and the product token,
   append the KortixDesktop marker the web middleware + isDesktop() rely on. */

function applyUserAgent() {
  // Strip the Electron token and the product token (whatever the app is named —
  // "Kortix" or "Kortix Dev") before appending the stable KortixDesktop marker.
  const name = app.getName().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ua = app.userAgentFallback
    .replace(/\sElectron\/\S+/, '')
    .replace(new RegExp(`\\s${name}\\/\\S+`), '');
  app.userAgentFallback = `${ua} ${UA_TOKEN}`;
}

/* ─── App lifecycle ───────────────────────────────────────────────────────*/

// Single-instance lock: a second launch (incl. a kortix:// deep link on
// Windows/Linux where the URL arrives as an argv) routes to the running window
// instead of spawning a new process.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // A kortix:// link that arrives before the window exists (macOS cold start).
  let pendingDeepLink = null;

  app.on('second-instance', (_event, argv) => {
    const deepLink = argv.find((a) => a.startsWith(`${URL_SCHEME}://`));
    if (deepLink) handleDeepLink(deepLink);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  // macOS delivers deep links via open-url.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (mainWindow) handleDeepLink(url);
    else pendingDeepLink = url; // arrived before the window existed
  });

  app.whenReady().then(() => {
    // Register kortix:// so the OS routes auth callbacks back to the app.
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(URL_SCHEME, process.execPath, [
        path.resolve(process.argv[1]),
      ]);
    } else {
      app.setAsDefaultProtocolClient(URL_SCHEME);
    }

    applyUserAgent();
    registerIpc();
    buildMenu();
    nativeTheme.themeSource = 'dark';

    createSplash();
    createMainWindow();

    // Kick off the background update check (no-ops on dev/unsigned builds).
    // Getters because both windows are recreated on macOS re-activate.
    setupAutoUpdates({
      getSplashWindow: () => splashWindow,
      getMainWindow: () => mainWindow,
    });

    // A deep link that arrived during cold start (macOS first-launch via URL).
    const firstArgvDeepLink = process.argv.find((a) =>
      a.startsWith(`${URL_SCHEME}://`),
    );
    if (firstArgvDeepLink) pendingDeepLink = firstArgvDeepLink;
    if (pendingDeepLink) {
      mainWindow?.webContents.once('did-finish-load', () => {
        handleDeepLink(pendingDeepLink);
        pendingDeepLink = null;
      });
    }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createSplash();
        createMainWindow();
      } else {
        mainWindow?.show();
        mainWindow?.focus();
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
