// Kortix desktop shell — auto-update (electron-updater + GitHub Releases).
//
// Until now the desktop app had NO update path: users had to notice a new
// version and manually re-download from the web /download route. This wires up
// a proper, native updating flow.
//
// Flow:
//   1. On launch we ask GitHub for the newest signed release (the feed is the
//      `vX.Y.Z` release list — electron-builder.yml already declares the github
//      provider, so the packaged app ships an `app-update.yml` pointing at it).
//   2. If a newer version exists it downloads in the BACKGROUND — the app stays
//      fully usable; we never block the window on a ~100 MB download. While the
//      splash is still up we surface "Checking…/Downloading… N%" on it.
//   3. Once the update is staged we show a native "Restart to update" dialog.
//      Declining keeps the staged update; it installs automatically on the next
//      quit (autoInstallOnAppQuit). A periodic re-check covers long sessions.
//   4. A "Check for Updates…" menu item runs the same flow on demand, this time
//      with explicit feedback ("You're up to date" / errors).
//
// Scope: auto-update runs only for PACKAGED, STABLE-channel builds. Unpackaged
// `electron .` dev runs can't self-update (no app-update.yml, electron-updater
// refuses), and the `dev` desktop channel ships to a mutable prerelease that
// isn't a versioned feed — so those builds no-op instead of cross-updating to a
// prod installer. macOS additionally requires the build to be signed +
// notarized (Squirrel.Mac); CI signs when the cert secrets are present.

const { app, dialog } = require('electron');
const { autoUpdater } = require('electron-updater');
// Pure helpers live in their own module so they're unit-testable without the
// Electron runtime (see update-channel.test.js).
const { resolveChannel, isUpdaterSupported } = require('./update-channel');

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

/* ─── Wiring ──────────────────────────────────────────────────────────────── */

let getSplashWindow = () => null;
let getMainWindow = () => null;
let initialized = false;
let updateReady = false; // an update finished downloading and is staged
// Whether the in-flight check was user-initiated (menu) — drives "up to
// date"/error dialogs that we suppress for the silent boot check.
let interactive = false;

function channel() {
  try {
    return resolveChannel(require('../package.json'));
  } catch {
    return 'stable';
  }
}

function supported() {
  return isUpdaterSupported({ isPackaged: app.isPackaged, channel: channel() });
}

/** Reflect update progress on the splash window if it's still visible. */
function setSplashStatus(text) {
  const splash = getSplashWindow();
  if (!splash || splash.isDestroyed()) return;
  splash.webContents
    .executeJavaScript(
      `(function(){var e=document.getElementById('kx-status');` +
        `if(e)e.textContent=${JSON.stringify(text || '')};})()`,
    )
    .catch(() => {});
}

/** Offer to restart into the staged update (or install silently on quit). */
async function promptRestart(info) {
  const version = (info && info.version) || '';
  const win = getMainWindow();
  const opts = {
    type: 'info',
    buttons: ['Restart now', 'Later'],
    defaultId: 0,
    cancelId: 1,
    title: 'Update ready',
    message: version ? `Kortix ${version} is ready to install.` : 'A Kortix update is ready to install.',
    detail:
      'Restart Kortix to finish updating. It only takes a moment — your work lives on the web, so nothing is lost.',
  };
  const { response } = win && !win.isDestroyed()
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  if (response === 0) {
    // Let the dialog close before tearing the app down.
    setImmediate(() => autoUpdater.quitAndInstall());
  }
}

function registerHandlers() {
  autoUpdater.on('checking-for-update', () => {
    setSplashStatus('Checking for updates…');
  });

  autoUpdater.on('update-available', (info) => {
    console.log('[kortix-updater] update available:', info && info.version);
    setSplashStatus('Downloading update…');
  });

  autoUpdater.on('update-not-available', () => {
    setSplashStatus('');
    if (interactive) {
      interactive = false;
      const win = getMainWindow();
      const opts = {
        type: 'info',
        buttons: ['OK'],
        title: 'You’re up to date',
        message: `Kortix ${app.getVersion()} is the latest version.`,
      };
      win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    }
  });

  autoUpdater.on('download-progress', (p) => {
    const pct = p && typeof p.percent === 'number' ? Math.round(p.percent) : null;
    setSplashStatus(pct == null ? 'Downloading update…' : `Downloading update… ${pct}%`);
  });

  autoUpdater.on('update-downloaded', (info) => {
    console.log('[kortix-updater] update downloaded:', info && info.version);
    updateReady = true;
    interactive = false;
    setSplashStatus('');
    void promptRestart(info);
  });

  autoUpdater.on('error', (err) => {
    console.log('[kortix-updater] error:', (err && err.message) || err);
    setSplashStatus('');
    if (interactive) {
      interactive = false;
      const win = getMainWindow();
      const opts = {
        type: 'error',
        buttons: ['OK'],
        title: 'Update check failed',
        message: 'Couldn’t check for updates.',
        detail: (err && err.message) || 'Please try again later.',
      };
      win && !win.isDestroyed() ? dialog.showMessageBox(win, opts) : dialog.showMessageBox(opts);
    }
  });
}

/**
 * Register handlers and start the background check. No-ops (with a log) on
 * unsupported builds so callers don't have to guard.
 */
function setupAutoUpdates({ getSplashWindow: gs, getMainWindow: gm }) {
  if (typeof gs === 'function') getSplashWindow = gs;
  if (typeof gm === 'function') getMainWindow = gm;

  if (!supported()) {
    console.log(
      `[kortix-updater] disabled (packaged=${app.isPackaged} channel=${channel()})`,
    );
    return;
  }
  if (initialized) return;
  initialized = true;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;
  registerHandlers();

  autoUpdater
    .checkForUpdates()
    .catch((e) => console.log('[kortix-updater] initial check failed:', (e && e.message) || e));

  // Re-check periodically so a long-running window eventually picks up a release.
  setInterval(() => {
    if (!updateReady) autoUpdater.checkForUpdates().catch(() => {});
  }, SIX_HOURS_MS);
}

/**
 * Menu-driven check. Shows explicit feedback: a staged update re-opens the
 * restart prompt; otherwise the check runs with "up to date"/error dialogs.
 */
function checkForUpdatesInteractive() {
  if (!supported()) {
    const opts = {
      type: 'info',
      buttons: ['OK'],
      title: 'Updates',
      message: app.isPackaged
        ? 'This build doesn’t use the automatic update channel.'
        : 'Automatic updates are only available in the installed app.',
    };
    dialog.showMessageBox(opts);
    return;
  }
  if (updateReady) {
    void promptRestart({ version: undefined });
    return;
  }
  interactive = true;
  autoUpdater.checkForUpdates().catch((e) => {
    // The 'error' handler shows the dialog; this guards the rejected promise.
    console.log('[kortix-updater] manual check failed:', (e && e.message) || e);
  });
}

module.exports = {
  setupAutoUpdates,
  checkForUpdatesInteractive,
};
