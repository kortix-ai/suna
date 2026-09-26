// Kortix desktop shell — Electron main process.
//
// A thin native wrapper around the remote web app: window sizing, the kortix://
// deep-link auth flow, a navigation gate (logged-in product + auth pages in-app;
// everything else in the user's real browser), the frontend-URL menu (the dev
// preset switcher, or the one "Change Kortix Instance…" entry on production
// builds), and the native bridge (zoom / open-external / window controls /
// frontend-url override).
//
// Why Electron: a prior Tauri/WKWebView shell routed EVERY navigation —
// including cross-origin IFRAME loads — through one hook, so embedded overlays
// (the Pipedream Connect iframe) got punted to the system browser and failed
// with "Must be inside iframe". Electron's will-navigate fires for the top
// frame only, so iframes "just work", and real popups (OAuth) keep a working
// window.opener. We expose the same `KortixDesktop` UA token + a
// `window.__TAURI__` bridge shape (see preload.js) so the web app's desktop
// bridge (apps/web/src/lib/desktop.ts) runs UNCHANGED.

const { app, BrowserWindow, Menu, dialog, shell, ipcMain, nativeTheme, safeStorage } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const { setupAutoUpdates, checkForUpdatesInteractive } = require('./updater');
const basicAuth = require('./basic-auth');
const { needsMainWindow, revealMainWindow, shouldAllowPreventedUnload } = require('./lifecycle-rules');
const { menuContextForUrl } = require('./menu-state');
const { decidePopup, isAllowedPopupNavigation } = require('./popup-rules');
const { backgroundForTheme, normalizeTheme } = require('./theme-state');
const { restoreWindowState } = require('./window-state');
const { buildFrontendMenu } = require('./frontend-menu');
const { resolveChannel } = require('./update-channel');
const { openInstanceChooser, focusInstanceChooser } = require('./instance-chooser');
const { explainNetError, hostOf, normalizeInstanceUrl } = require('./instance-rules');
const { createInstanceStore } = require('./instance-store');
const { isConfiguredAppUrl, isTrustedAppSender } = require('./native-sender');
const { isAppPath, isPreviewHost } = require('./nav-rules');
const { rendererGoneNeedsRecovery } = require('./renderer-recovery');
const { NAVIGATION_SHORTCUTS, historyTarget } = require('./navigation');
const { DESKTOP_CHROME_JS, configureNativeWindowControls, macTrafficLightPosition } = require('./window-chrome');

// Name comes from the bundle (productName): "Kortix" for prod, "Kortix Dev" for
// dev builds. Per-name data dir so dev + prod coexist without sharing a session,
// and so we never inherit another "Kortix" app's stale Chromium state (per-site
// zoom / GPU cache) — a real cause of blurry rendering. `${name} Desktop` keeps
// us off the bare "Kortix" Application Support folder.
// KORTIX_DESKTOP_USER_DATA points a launch at an isolated profile (automated
// runs, side-by-side test sessions) without touching the real one.
app.setPath(
  'userData',
  process.env.KORTIX_DESKTOP_USER_DATA || path.join(app.getPath('appData'), `${app.getName()} Desktop`),
);

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
const DEFAULT_URL = process.env.KORTIX_DESKTOP_DEFAULT_URL || bakedDefaultUrl() || 'https://kortix.com/projects';

// The update channel baked into the bundle decides whether the frontend-URL
// menu is the developer preset switcher or the single production
// "Change Kortix Instance…" entry (frontend-menu.js).
const CHANNEL = resolveChannel(require('../package.json'));

const URL_SCHEME = 'kortix';
// Matches DESKTOP_UA_TOKEN in apps/web/src/lib/desktop.ts and the
// KortixDesktop check in apps/web/src/middleware.ts.
const UA_TOKEN = 'KortixDesktop/0.1.0';

// net::ERR_ABORTED — a navigation replaced by another one, not a failure.
const ERR_ABORTED = -3;

/* ─── Kortix instance (frontend URL) ──────────────────────────────────────
   instance-store.js owns userData/frontend_url (the self-hosting override),
   the first-launch marker, and URL precedence: saved URL → KORTIX_DESKTOP_URL
   → DEFAULT_URL. A new profile is marked HERE, at module load, because the
   single-instance lock at the bottom of this file writes into userData. */

const instanceStore = createInstanceStore({
  dir: app.getPath('userData'),
  envUrl: process.env.KORTIX_DESKTOP_URL,
  defaultUrl: DEFAULT_URL,
});
instanceStore.markIfNewProfile();

/**
 * Is this auth challenge coming from the exact origin we load the app from?
 * Anything else — an iframe, a sandbox preview, an attacker page returning 401
 * Basic — must never be answered with our shared credential.
 * @param {{ host?: string, port?: number }} authInfo
 */
function isAppOriginChallenge(authInfo) {
  let target;
  try {
    target = new URL(instanceStore.appUrl());
  } catch {
    return false;
  }
  if (!authInfo.host || authInfo.host !== target.hostname) return false;
  const targetPort = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  return !authInfo.port || authInfo.port === targetPort;
}

/* ─── Window and shell-state persistence ───────────────────────────────── */

function statePath() {
  return path.join(app.getPath('userData'), 'window_state.json');
}

function readWindowState() {
  try {
    return JSON.parse(fs.readFileSync(statePath(), 'utf8'));
  } catch {
    return null;
  }
}

function writeWindowState(state) {
  try {
    fs.writeFileSync(statePath(), JSON.stringify(state), 'utf8');
  } catch {
    /* best-effort */
  }
}

function themePath() {
  return path.join(app.getPath('userData'), 'theme.json');
}

function readTheme() {
  try {
    return normalizeTheme(JSON.parse(fs.readFileSync(themePath(), 'utf8')).theme);
  } catch {
    return 'system';
  }
}

function writeTheme(theme) {
  try {
    fs.writeFileSync(themePath(), JSON.stringify({ theme: normalizeTheme(theme) }), 'utf8');
  } catch {
    /* best-effort */
  }
}

function currentBackgroundColor() {
  return backgroundForTheme(nativeTheme.themeSource, nativeTheme.shouldUseDarkColors);
}

/* ─── Navigation gate (port of lib.rs) ───────────────────────────────────── */

// `isPreviewHost` and `isAppPath` live in nav-rules.js, where a test keeps the
// route list equal to the web middleware's DESKTOP_ALLOWED_ROUTES.
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
  // configured app origin and still load in-app via isAppPath below.
  if (u.pathname.startsWith('/auth/v1/')) return false;
  const host = u.hostname;
  if (isPreviewHost(host)) return true;
  // Navigation and native commands share the configured frontend origin.
  if (isConfiguredAppUrl(urlStr, instanceStore.appUrl()) && isAppPath(u.pathname)) return true;
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
    target = new URL(instanceStore.appUrl());
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
  mainWindow.webContents.executeJavaScript(`window.location.replace(${JSON.stringify(target)})`);
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

function restoredWindowState() {
  const { screen } = require('electron');
  return restoreWindowState(readWindowState(), screen.getAllDisplays(), screen.getPrimaryDisplay(), launchSize());
}

function createSplash() {
  // Same size + center as the main window so swapping splash → app is seamless
  // (no jump in size or position, no white flash).
  const { bounds } = restoredWindowState();
  splashWindow = new BrowserWindow({
    ...bounds,
    frame: false,
    resizable: false,
    movable: false,
    show: true,
    hasShadow: true,
    backgroundColor: currentBackgroundColor(),
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
  const restored = restoredWindowState();

  const isMac = process.platform === 'darwin';

  // App icon for the taskbar/dock on Windows/Linux (macOS uses the bundled
  // .icns at package time). Missing file → Electron default icon.
  const winIcon = path.join(__dirname, '..', 'build', 'icon.png');

  mainWindow = new BrowserWindow({
    ...restored.bounds,
    minWidth: 720,
    minHeight: 480,
    show: false, // revealed once the remote app finishes loading (splash covers the gap)
    backgroundColor: currentBackgroundColor(),
    title: 'Kortix',
    // macOS: hidden title bar, traffic lights centered in the title-bar band
    // the web app's first row shares with them. The band height and every
    // offset derived from it live in ONE table (window-chrome.js →
    // MAC_TITLEBAR); never re-hard-code a y here.
    ...(isMac
      ? {
          titleBarStyle: 'hidden',
          trafficLightPosition: macTrafficLightPosition(),
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

  // Keep one canonical set of controls. Web-rendered traffic lights could
  // coexist with native buttons after focus/reload transitions.
  configureNativeWindowControls(mainWindow, isMac);

  const syncRendererWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('kortix:fullscreen', mainWindow.isFullScreen());
  };

  // Reveal once content is in. did-finish-load fires when the document + its
  // subresources are loaded — good enough to swap the splash for real chrome
  // instead of a blank window.
  mainWindow.webContents.once('did-finish-load', () => {
    dismissSplash();
    if (!mainWindow) return;
    if (restored.maximized) mainWindow.maximize();
    refreshNavigationMenu();
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

  // Inject the drag-zone author style on every full load. The web shell owns
  // the thin top-edge drag handle; no compositor-level overlay covers content.
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow?.webContents.executeJavaScript(DESKTOP_CHROME_JS).catch(() => {});
    syncRendererWindowState();
    // Render diagnostic (blur): on Retina expect dpr=2 and zoom=1.
    mainWindow?.webContents
      .executeJavaScript('window.devicePixelRatio')
      .then((dpr) => console.log(`[kortix-render] dpr=${dpr} zoom=${mainWindow?.webContents.getZoomFactor()}`))
      .catch(() => {});
  });

  // Persist the last normal bounds. Maximized/full-screen bounds are not valid
  // restore geometry. restoreWindowState() rejects off-screen saved positions.
  let lastNormalBounds = restored.bounds;
  let persistTimer = null;
  const persistWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (!mainWindow.isMaximized() && !mainWindow.isFullScreen()) {
      lastNormalBounds = mainWindow.getBounds();
    }
    writeWindowState({
      bounds: lastNormalBounds,
      maximized: mainWindow.isMaximized(),
    });
  };
  const schedulePersist = () => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(persistWindowState, 200);
  };

  const emitResized = () => mainWindow?.webContents.send('kortix:resized');
  mainWindow.on('resize', () => {
    emitResized();
    schedulePersist();
  });
  mainWindow.on('move', schedulePersist);
  mainWindow.on('maximize', () => {
    persistWindowState();
    emitResized();
  });
  mainWindow.on('unmaximize', () => {
    persistWindowState();
    emitResized();
  });
  mainWindow.on('enter-full-screen', () => mainWindow?.webContents.send('kortix:fullscreen', true));
  mainWindow.on('leave-full-screen', () => mainWindow?.webContents.send('kortix:fullscreen', false));
  mainWindow.on('close', persistWindowState);

  mainWindow.webContents.on('will-prevent-unload', (event) => {
    const response = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      message: 'Leave this page?',
      detail: 'You have unsaved changes. Leaving will discard them.',
    });
    if (shouldAllowPreventedUnload(response)) event.preventDefault();
  });

  // Navigation gate — top-frame only. Anything that isn't a logged-in product/
  // auth page or a sandbox preview opens in the user's real browser. Iframes
  // (Pipedream Connect) are NOT gated and load freely in-app.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (shouldLoadInApp(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  // Go menu state follows every committed navigation, including the App
  // Router's same-document ones.
  mainWindow.webContents.on('did-navigate', refreshNavigationMenu);
  mainWindow.webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) refreshNavigationMenu();
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
    const decision = decidePopup({ url, disposition, features });
    if (decision === 'popup') {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 520,
          height: 720,
          minimizable: false,
          fullscreenable: false,
          backgroundColor: currentBackgroundColor(),
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    if (decision === 'external') shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('did-create-window', (child) => {
    const keepPopupNavigationSafe = (event, url) => {
      if (isAllowedPopupNavigation(url)) return;
      event.preventDefault();
    };
    child.webContents.on('will-navigate', keepPopupNavigationSafe);
    child.webContents.on('will-redirect', keepPopupNavigationSafe);
  });

  // Electron ships no network error page: a dead app origin paints only the
  // window background. Offer to retry or pick another instance instead. Only
  // the main frame on the configured origin counts — a failing sandbox preview
  // is not an instance problem. ERR_ABORTED is a navigation replaced by another.
  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === ERR_ABORTED) return;
    if (!isConfiguredAppUrl(validatedURL, instanceStore.appUrl())) return;
    console.warn(`[kortix] ${validatedURL} did not load: ${errorDescription} (${errorCode}).`);
    dismissSplash();
    if (mainWindow && !mainWindow.isVisible()) mainWindow.show();
    void changeInstance('unreachable', explainNetError(hostOf(validatedURL), errorDescription));
  });

  // A renderer that crashes, is killed, or runs out of memory leaves only the
  // window background: no page, no script, no in-app exit. Offer a way back.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (!rendererGoneNeedsRecovery(details)) return;
    console.warn(`[kortix] renderer gone: ${details?.reason} (exit ${details?.exitCode}).`);
    if (!mainWindow || mainWindow.isDestroyed()) return;
    void dialog
      .showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Reload', 'Go Home'],
        defaultId: 0,
        cancelId: 0,
        message: 'Kortix stopped unexpectedly',
        detail: 'Reload to return to this page, or go home to your latest project.',
      })
      .then(({ response }) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        if (response === 1) goHome();
        else mainWindow.webContents.reload();
      });
  });

  mainWindow.on('closed', () => {
    if (persistTimer) clearTimeout(persistTimer);
    mainWindow = null;
  });

  // did-fail-load reports failures; the rejected promise carries nothing more.
  mainWindow.loadURL(instanceStore.appUrl()).catch(() => {});
}

/**
 * Full-page load of the main window onto `url` (menu, IPC, instance chooser).
 * loadURL, not location.replace(): a window whose last load failed has no
 * document to run script in. History is cleared after the load — Back must not
 * return to the previous instance.
 */
function navigateMainWindow(url) {
  if (!mainWindow) return;
  const wc = mainWindow.webContents;
  wc.loadURL(url)
    .then(() => wc.navigationHistory.clear())
    .catch(() => {}); // did-fail-load reports failures
  mainWindow.focus();
}

/* ─── Back / Forward / Home ───────────────────────────────────────────────
   The window has no browser toolbar, so these are shell behaviour on every
   page — including pages the web app does not own (sandbox previews, a 401
   body, a render that threw). Policy lives in navigation.js. */

/** History index for one step, skipping entries the gate keeps out of the window. */
function mainHistoryTarget(direction) {
  const history = mainWindow?.webContents.navigationHistory;
  if (!history) return -1;
  return historyTarget(history.getAllEntries(), history.getActiveIndex(), direction, shouldLoadInApp);
}

/**
 * @param {'back' | 'forward' | 'home'} direction
 * @returns {boolean} whether the window moved
 */
function navigateWindow(direction) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;
  const wc = mainWindow.webContents;
  if (direction === 'home') {
    goHome();
    return true;
  }
  const index = mainHistoryTarget(direction);
  if (index < 0) return false;
  wc.navigationHistory.goToIndex(index);
  return true;
}

/** Forward needs a history target; Back falls home when there is none. */
function refreshNavigationMenu() {
  const menu = Menu.getApplicationMenu();
  if (!menu) return;
  const forward = menu.getMenuItemById('kx-go-forward');
  if (forward) forward.enabled = mainHistoryTarget('forward') >= 0;
  const context = menuContextForUrl(mainWindow?.webContents.getURL() || '');
  const newSession = menu.getMenuItemById('kx-file-new-session');
  const closeTab = menu.getMenuItemById('kx-file-close-tab');
  if (newSession) newSession.enabled = context.inProject;
  if (closeTab) closeTab.enabled = context.hasActiveTab;
}

function sendDesktopCommand(command) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('kortix:command', command);
}

/**
 * Go ▸ Back (Cmd/Ctrl+[). The shell has no browser toolbar, so without this a
 * page with no in-app exit is a dead end.
 *
 * History traversal must not land on an external URL. With nothing in-app
 * behind the page, Back goes home.
 */
function goBackInApp() {
  if (!mainWindow) return;
  const index = mainHistoryTarget('back');
  if (index < 0) goHome();
  else mainWindow.webContents.navigationHistory.goToIndex(index);
}

/** Go ▸ Home (Cmd/Ctrl+Shift+H): a full load of the configured app URL, from any page. */
function goHome() {
  navigateMainWindow(instanceStore.appUrl());
}

/** Save a choice (menu, web bridge) and load the app onto it. Returns the save error, or null. */
function switchInstance(choice) {
  const error = instanceStore.save(choice);
  if (!error) navigateMainWindow(instanceStore.appUrl());
  return error;
}

/** The instance chooser over the running app; a saved choice reloads the app. */
async function changeInstance(mode, error = null) {
  const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
  if (await openInstanceChooser({ mode, error, parent, store: instanceStore })) {
    navigateMainWindow(instanceStore.appUrl());
  }
}

/* ─── HTTP Basic credentials (dev/staging environment password) ────────────
   Policy is basicAuth.decideChallenge(); this section owns the side effects:
   the safeStorage-encrypted file userData/basic_auth.json, the per-session
   memory, the dialog window, and the "was that rejected?" bookkeeping. */

/** challenge key → { user, password } for this process lifetime. */
const sessionBasicCredentials = new Map();
/** challenge key → { source: 'env'|'stored'|'prompt', at } — last credential sent. */
const lastBasicAnswers = new Map();
/** challenge key → dialog promise; dedupes parallel challenges. */
const pendingBasicPrompts = new Map();

function basicAuthStorePath() {
  return path.join(app.getPath('userData'), 'basic_auth.json');
}

function readBasicAuthStore() {
  try {
    return basicAuth.parseStore(fs.readFileSync(basicAuthStorePath(), 'utf8'));
  } catch {
    return basicAuth.parseStore(null);
  }
}

function writeBasicAuthStore(store) {
  try {
    fs.mkdirSync(path.dirname(basicAuthStorePath()), { recursive: true });
    fs.writeFileSync(basicAuthStorePath(), basicAuth.serializeStore(store), {
      mode: 0o600,
    });
  } catch (e) {
    console.warn(`[kortix] could not write ${basicAuthStorePath()}: ${e}`);
  }
}

function canRememberBasicCredential() {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

/** Remembered credential for `host` — memory first, then the encrypted file. */
function loadBasicCredential(key) {
  const inMemory = sessionBasicCredentials.get(key);
  if (inMemory) return inMemory;
  const entry = basicAuth.lookupHost(readBasicAuthStore(), key);
  if (!entry || !canRememberBasicCredential()) return null;
  try {
    const password = safeStorage.decryptString(Buffer.from(entry.secret, 'base64'));
    const cred = { user: entry.user, password };
    sessionBasicCredentials.set(key, cred);
    return cred;
  } catch (e) {
    // Keychain changed / different user account — the blob is unreadable.
    console.warn(`[kortix] dropping unreadable saved credential for ${key}: ${e}`);
    writeBasicAuthStore(basicAuth.removeHost(readBasicAuthStore(), key));
    return null;
  }
}

function rememberBasicCredential(key, cred, persist) {
  sessionBasicCredentials.set(key, cred);
  if (!persist || !canRememberBasicCredential()) return;
  const secret = safeStorage.encryptString(cred.password).toString('base64');
  writeBasicAuthStore(
    basicAuth.upsertHost(readBasicAuthStore(), key, {
      user: cred.user,
      secret,
    }),
  );
}

function forgetBasicCredential(key) {
  sessionBasicCredentials.delete(key);
  lastBasicAnswers.delete(key);
  const store = readBasicAuthStore();
  const had = !!basicAuth.lookupHost(store, key);
  if (had) writeBasicAuthStore(basicAuth.removeHost(store, key));
  return had;
}

function forgetBasicCredentialForAppHost() {
  let target;
  try {
    target = new URL(instanceStore.appUrl());
  } catch {
    return;
  }
  const host = target.hostname;
  const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
  const had = forgetBasicCredential(basicAuth.challengeKey({ host, port, isProxy: false }));
  dialog.showMessageBox({
    type: 'info',
    message: had
      ? `Forgot the saved environment password for ${host}.`
      : `No environment password is saved for ${host}.`,
    detail: had ? 'The next time this host asks, the sign-in dialog opens again.' : undefined,
  });
}

/**
 * Open the credential dialog. Resolves to { user, password, remember } or null
 * on cancel/close. Parallel challenges for one host share one dialog.
 */
function promptForBasicCredential({ key, host, realm, user, error }) {
  const pending = pendingBasicPrompts.get(key);
  if (pending) return pending;

  // The first challenge fires before the app has painted, while the main
  // window is still hidden behind the splash. Chrome shows its dialog over a
  // blank page; do the same — the dark main window is the parent.
  if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible()) {
    dismissSplash();
    mainWindow.show();
  }

  const promise = new Promise((resolve) => {
    const parent = mainWindow && !mainWindow.isDestroyed() ? mainWindow : undefined;
    const win = new BrowserWindow({
      width: 400,
      height: 320,
      parent,
      modal: !!parent,
      show: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: 'Sign in',
      backgroundColor: currentBackgroundColor(),
      webPreferences: {
        preload: path.join(__dirname, 'basic-auth-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    win.setMenuBarVisibility(false);

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      console.log(`[kortix] Basic sign-in dialog for ${host}: ${result ? 'submitted' : 'cancelled'}.`);
      ipcMain.removeListener('kortix:basic-auth:submit', onSubmit);
      ipcMain.removeListener('kortix:basic-auth:cancel', onCancel);
      pendingBasicPrompts.delete(key);
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };
    const fromThisDialog = (event) => !win.isDestroyed() && event.sender === win.webContents;
    const onSubmit = (event, payload) => {
      if (!fromThisDialog(event)) return;
      finish({
        user: String(payload?.user ?? '').trim() || basicAuth.DEFAULT_USER,
        password: String(payload?.password ?? ''),
        remember: Boolean(payload?.remember),
      });
    };
    const onCancel = (event) => {
      if (fromThisDialog(event)) finish(null);
    };
    ipcMain.on('kortix:basic-auth:submit', onSubmit);
    ipcMain.on('kortix:basic-auth:cancel', onCancel);
    win.on('closed', () => finish(null));

    win.webContents.once('did-finish-load', () => {
      win.webContents.send('kortix:basic-auth:init', {
        host,
        realm: realm || '',
        user,
        error,
        canRemember: canRememberBasicCredential(),
      });
      win.show();
    });
    win.loadFile(path.join(__dirname, '..', 'assets', 'basic-auth.html'));
  });
  pendingBasicPrompts.set(key, promise);
  return promise;
}

/** Answer one allowed Basic challenge (app origin: env/store/dialog; proxy: store/dialog). */
async function answerBasicChallenge(authInfo, callback) {
  const host = authInfo.host;
  const key = basicAuth.challengeKey(authInfo);
  const decision = basicAuth.decideChallenge({
    host,
    env: authInfo.isProxy
      ? undefined
      : {
          user: process.env.KORTIX_DESKTOP_BASIC_USER,
          password: process.env.KORTIX_DESKTOP_BASIC_PASSWORD,
        },
    stored: loadBasicCredential(key),
    lastAnswer: lastBasicAnswers.get(key) || null,
    now: Date.now(),
  });

  if (decision.action === 'answer') {
    console.log(`[kortix] Basic challenge from ${host}: answering from ${decision.source}.`);
    lastBasicAnswers.set(key, { source: decision.source, at: Date.now() });
    callback(decision.user, decision.password);
    return;
  }
  console.log(`[kortix] Basic challenge from ${host}: asking the user.`);

  if (decision.dropStored) {
    console.warn(`[kortix] ${host} rejected the saved environment password — forgetting it.`);
    forgetBasicCredential(key);
  }
  const result = await promptForBasicCredential({
    key,
    host,
    realm: authInfo.realm,
    user: decision.user,
    error: decision.error,
  });
  if (!result) {
    // Cancel → the request fails and the page renders the 401 body, same as
    // Chrome. For an app-origin challenge, a reload re-challenges. A proxy
    // response is not a navigation failure, so surface the shell's existing
    // Retry / change-instance screen instead of leaving the raw 407 page open.
    lastBasicAnswers.delete(key);
    callback();
    if (authInfo.isProxy) {
      void changeInstance(
        'unreachable',
        `Proxy sign-in for ${host} was cancelled. Try again to reconnect.`,
      );
    }
    return;
  }
  rememberBasicCredential(key, { user: result.user, password: result.password }, result.remember);
  lastBasicAnswers.set(key, { source: 'prompt', at: Date.now() });
  callback(result.user, result.password);
}

/* ─── Native menu (incl. the frontend-URL entry) ───────────────────────────*/

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const shortcuts = isMac ? NAVIGATION_SHORTCUTS.darwin : NAVIGATION_SHORTCUTS.other;

  // Dev builds keep the nested preset switcher (mirrors the Tauri "Frontend
  // URL" submenu). Production builds show ONE "Change Kortix Instance…" item
  // that opens the native chooser; frontend-menu.js owns the split.
  const frontendMenu = buildFrontendMenu({
    channel: CHANNEL,
    onPreset: (url) => switchInstance({ kind: 'custom', url }),
    onChange: () => void changeInstance('change'),
    onReset: () => switchInstance({ kind: 'default' }),
    onForgetPassword: () => forgetBasicCredentialForAppHost(),
  });

  const template = [
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { role: 'about' },
              {
                id: 'kx-app-settings',
                label: 'Settings…',
                accelerator: 'CommandOrControl+,',
                click: () => sendDesktopCommand('open-settings'),
              },
              {
                label: 'Check for Updates…',
                click: () => checkForUpdatesInteractive(),
              },
              { type: 'separator' },
              frontendMenu,
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
    {
      label: 'File',
      submenu: [
        {
          id: 'kx-file-new-session',
          label: 'New Session',
          accelerator: 'CommandOrControl+N',
          enabled: false,
          click: () => sendDesktopCommand('new-session'),
        },
        {
          id: 'kx-file-close-tab',
          label: 'Close Tab',
          accelerator: 'CommandOrControl+W',
          enabled: false,
          click: () => sendDesktopCommand('close-tab'),
        },
        {
          id: 'kx-file-close-window',
          label: 'Close Window',
          accelerator: 'CommandOrControl+Shift+W',
          click: () => mainWindow?.close(),
        },
        ...(!isMac
          ? [
              { type: 'separator' },
              {
                id: 'kx-file-settings',
                label: 'Settings…',
                accelerator: 'CommandOrControl+,',
                click: () => sendDesktopCommand('open-settings'),
              },
            ]
          : []),
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        {
          id: 'kx-view-actual-size',
          label: 'Actual Size',
          accelerator: 'CommandOrControl+0',
          click: () => sendDesktopCommand('zoom-reset'),
        },
        {
          id: 'kx-view-zoom-in',
          label: 'Zoom In',
          accelerator: 'CommandOrControl+Plus',
          click: () => sendDesktopCommand('zoom-in'),
        },
        {
          id: 'kx-view-zoom-out',
          label: 'Zoom Out',
          accelerator: 'CommandOrControl+-',
          click: () => sendDesktopCommand('zoom-out'),
        },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(isMac
          ? []
          : [
              { type: 'separator' },
              {
                label: 'Check for Updates…',
                click: () => checkForUpdatesInteractive(),
              },
              frontendMenu,
            ]),
      ],
    },
    {
      // Browser-standard history, so no page can strand the user. The
      // accelerators are native menu accelerators, so they work on any page,
      // including one the web app did not render.
      label: 'Go',
      submenu: [
        {
          id: 'kx-go-back',
          label: 'Back',
          accelerator: shortcuts.back,
          click: () => goBackInApp(),
        },
        {
          id: 'kx-go-forward',
          label: 'Forward',
          accelerator: shortcuts.forward,
          enabled: false,
          click: () => navigateWindow('forward'),
        },
        { type: 'separator' },
        {
          id: 'kx-go-home',
          label: 'Home',
          accelerator: shortcuts.home,
          click: () => navigateWindow('home'),
        },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  refreshNavigationMenu();
}

/* ─── IPC: native bridge (consumed via the __TAURI__ shim in preload.js) ───*/

// The preload exposes the native bridge to whatever page is loaded in the main
// window — including sandbox-preview / tunnel content, which is untrusted
// (agent- or attacker-rendered). Only the Kortix app shell may drive privileged
// commands; otherwise a preview page could call e.g. set_frontend_url to
// permanently repoint the whole desktop app at an attacker origin. Derive the
// sender's current origin from the configured frontend URL. Custom frontends
// need the same bridge as kortix.com. Only the main frame of the main window
// may call it; embedded previews and other windows do not inherit that trust.
function isTrustedSender(event) {
  try {
    return isTrustedAppSender(event, mainWindow?.webContents, instanceStore.appUrl());
  } catch {
    return false;
  }
}

function registerIpc() {
  // Single funnel matching the Tauri `core.invoke(cmd, args)` contract so the
  // web app's existing calls (set_zoom / open_external / get_frontend_url /
  // set_frontend_url) work unchanged.
  ipcMain.handle('kortix:invoke', (event, cmd, args = {}) => {
    if (!isTrustedSender(event)) {
      throw new Error('Unauthorized IPC sender');
    }
    switch (cmd) {
      case 'set_zoom': {
        const scale = Math.min(3, Math.max(0.5, Number(args.scale) || 1));
        const wc = BrowserWindow.fromWebContents(event.sender)?.webContents;
        wc?.setZoomFactor(scale);
        return null;
      }
      case 'set_native_theme': {
        const theme = normalizeTheme(args.theme);
        nativeTheme.themeSource = theme;
        writeTheme(theme);
        const background = currentBackgroundColor();
        mainWindow?.setBackgroundColor(background);
        splashWindow?.setBackgroundColor(background);
        return null;
      }
      case 'open_external': {
        const url = String(args.url || '');
        // Only ever hand http(s) URLs to the OS shell — never file:, custom
        // schemes, or crafted protocol URLs. (Sender is already origin-gated
        // above; this is defense in depth, matching setWindowOpenHandler.)
        if (/^https?:\/\//i.test(url)) shell.openExternal(url);
        return null;
      }
      case 'get_frontend_url':
        return instanceStore.appUrl();
      case 'set_frontend_url': {
        // Same URL rules as the instance chooser.
        const normalized = normalizeInstanceUrl(String(args.url || ''));
        if (!normalized.ok) throw new Error(normalized.error);
        const saveError = switchInstance({
          kind: 'custom',
          url: normalized.url,
        });
        if (saveError) throw new Error(`Kortix could not save the URL: ${saveError}`);
        return null;
      }
      default:
        throw new Error(`Unknown command: ${cmd}`);
    }
  });

  // One history step (preload.js: the mouse side buttons and the web app's
  // Back). Any page in the main window may ask: a history step is what its own
  // `history.back()` could do anyway, and the target is still chosen here.
  // Other windows (OAuth popups) may not. Resolves whether the window moved.
  ipcMain.handle('kortix:navigate', (event, direction) => {
    if (!mainWindow || event.sender !== mainWindow.webContents) return false;
    if (direction !== 'back' && direction !== 'forward') return false;
    return navigateWindow(direction);
  });

  // Window controls (Tauri `getCurrentWindow().*`).
  ipcMain.handle('kortix:window', (event, action) => {
    if (!isTrustedSender(event)) {
      throw new Error('Unauthorized IPC sender');
    }
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
  const ua = app.userAgentFallback.replace(/\sElectron\/\S+/, '').replace(new RegExp(`\\s${name}\\/\\S+`), '');
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

  // HTTP Basic challenges cover the app origin and authenticating proxies.
  // Dev/staging sit behind one shared origin credential — see apps/web/src/
  // middleware.ts, which answers 401 "Authentication required.".
  //
  // Chrome shows its own username/password dialog for these. Electron does NOT:
  // if nothing handles 'login' the request is simply cancelled, so the window
  // renders the bare 401 body with no way to get past it. That is exactly what
  // a dev build pointed at dev.kortix.com looked like before this handler.
  //
  // Origin order: KORTIX_DESKTOP_BASIC_PASSWORD env → credential remembered
  // for this host and port → a native-style dialog (assets/basic-auth.html).
  // Proxy order omits the app-origin environment credential. Proxy entries are
  // isolated by proxy host and port. Policy, including rejection detection, is
  // the pure decideChallenge() in src/basic-auth.js so it is unit-tested.
  //
  // A non-proxy credential is answered ONLY for the configured app origin.
  // Untrusted in-app content (sandbox previews, iframes) can point at any host,
  // and a 401 Basic challenge is all an attacker host needs to harvest it.
  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (authInfo.scheme !== 'basic') return;
    if (!authInfo.isProxy && !isAppOriginChallenge(authInfo)) {
      console.warn(`[kortix] ignoring HTTP Basic challenge from ${authInfo.host} — not the app origin.`);
      event.preventDefault();
      callback();
      return;
    }
    event.preventDefault();
    answerBasicChallenge(authInfo, callback);
  });

  app.on('second-instance', (_event, argv) => {
    const deepLink = argv.find((a) => a.startsWith(`${URL_SCHEME}://`));
    if (deepLink) handleDeepLink(deepLink);
    revealMainWindow(mainWindow);
    // First launch: the chooser is the only window.
    focusInstanceChooser();
  });

  // macOS delivers deep links via open-url.
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (mainWindow) handleDeepLink(url);
    else pendingDeepLink = url; // arrived before the window existed
  });

  app.whenReady().then(async () => {
    // Register kortix:// so the OS routes auth callbacks back to the app.
    if (process.defaultApp && process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(URL_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(URL_SCHEME);
    }

    applyUserAgent();
    registerIpc();
    nativeTheme.themeSource = readTheme();
    nativeTheme.on('updated', () => {
      const background = currentBackgroundColor();
      mainWindow?.setBackgroundColor(background);
      splashWindow?.setBackgroundColor(background);
    });
    buildMenu();

    // First launch of a new profile: choose the instance before anything loads.
    if (instanceStore.needsSetup() && !(await openInstanceChooser({ mode: 'setup', store: instanceStore }))) {
      app.quit();
      return;
    }

    createSplash();
    createMainWindow();

    // Kick off the background update check (no-ops on dev/unsigned builds).
    // Getters because both windows are recreated on macOS re-activate.
    setupAutoUpdates({
      getSplashWindow: () => splashWindow,
      getMainWindow: () => mainWindow,
    });

    // A deep link that arrived during cold start (macOS first-launch via URL).
    const firstArgvDeepLink = process.argv.find((a) => a.startsWith(`${URL_SCHEME}://`));
    if (firstArgvDeepLink) pendingDeepLink = firstArgvDeepLink;
    if (pendingDeepLink) {
      mainWindow?.webContents.once('did-finish-load', () => {
        handleDeepLink(pendingDeepLink);
        pendingDeepLink = null;
      });
    }

    app.on('activate', () => {
      if (needsMainWindow(mainWindow)) {
        createSplash();
        createMainWindow();
      } else {
        revealMainWindow(mainWindow);
      }
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
