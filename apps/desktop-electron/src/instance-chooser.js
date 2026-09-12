// Kortix instance chooser — one native window (assets/instance-chooser.html)
// for three moments:
//   'setup'        first launch of a new profile, before any app window exists
//   'change'       Frontend URL → Custom URL…
//   'unreachable'  the app origin failed to load
//
// It needs no web page, which is the point: native menus take no text input,
// and the web app's own prompt needs a page that loaded. Rules live in
// instance-rules.js, files in instance-store.js; this module owns the window
// and its IPC.

const { app, BrowserWindow, ipcMain, net } = require('electron');
const path = require('node:path');
const { checkInstanceChoice, describeDefaultInstance, hostOf } = require('./instance-rules');

const WIDTH = 460;
const CHANNEL = {
  init: 'kortix:instance:init',
  submit: 'kortix:instance:submit',
  cancel: 'kortix:instance:cancel',
  quit: 'kortix:instance:quit',
  resize: 'kortix:instance:resize',
};

/** @type {BrowserWindow | null} */
let openWindow = null;

/** Bring the open chooser forward. Returns false when none is open. */
function focusInstanceChooser() {
  if (!openWindow || openWindow.isDestroyed()) return false;
  if (openWindow.isVisible()) openWindow.focus();
  return true;
}

/**
 * Open the chooser and wait for the user.
 *
 * @param {{
 *   mode: 'setup' | 'change' | 'unreachable',
 *   error?: string | null,
 *   parent?: BrowserWindow,
 *   store: ReturnType<import('./instance-store').createInstanceStore>,
 * }} opts
 * @returns {Promise<boolean>} true once a choice is saved. False when the user
 *   cancels, quits, or closes the window — or when a chooser is already open
 *   (it is focused instead).
 */
function openInstanceChooser({ mode, error = null, parent, store }) {
  if (focusInstanceChooser()) return Promise.resolve(false);

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: WIDTH,
      height: 400,
      useContentSize: true,
      parent,
      modal: !!parent,
      center: true,
      show: false,
      resizable: false,
      minimizable: !parent,
      maximizable: false,
      fullscreenable: false,
      title: 'Kortix',
      backgroundColor: '#141414',
      webPreferences: {
        preload: path.join(__dirname, 'instance-chooser-preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    openWindow = win;
    win.setMenuBarVisibility(false);

    let settled = false;
    const finish = (saved) => {
      if (settled) return;
      settled = true;
      console.log(`[kortix] instance chooser (${mode}): ${saved ? 'saved' : 'dismissed'}.`);
      ipcMain.removeHandler(CHANNEL.submit);
      ipcMain.removeListener(CHANNEL.cancel, onCancel);
      ipcMain.removeListener(CHANNEL.quit, onQuit);
      ipcMain.removeListener(CHANNEL.resize, onResize);
      openWindow = null;
      resolve(saved);
      if (win.isDestroyed()) return;
      // Hide now; destroy on the next task, after the caller opened the app
      // window. On Windows/Linux destroying the last window quits the app.
      win.hide();
      setTimeout(() => {
        if (!win.isDestroyed()) win.destroy();
      }, 0);
    };
    const fromThisWindow = (event) => !win.isDestroyed() && event.sender === win.webContents;

    ipcMain.handle(CHANNEL.submit, async (event, submission) => {
      if (!fromThisWindow(event)) throw new Error('Unauthorized IPC sender');
      const checked = await checkInstanceChoice(submission, {
        fetch: (url, init) => net.fetch(url, init),
      });
      // Closed during the reachability check: save nothing.
      if (settled || !checked.ok) return checked;
      const saveError = store.save(checked.choice);
      if (saveError) return { ok: false, error: `Kortix could not save the URL: ${saveError}` };
      finish(true);
      return { ok: true };
    });
    const onCancel = (event) => {
      if (fromThisWindow(event)) finish(false);
    };
    const onQuit = (event) => {
      if (!fromThisWindow(event)) return;
      finish(false);
      app.quit();
    };

    let shown = false;
    const reveal = () => {
      if (shown || win.isDestroyed()) return;
      shown = true;
      if (!parent) win.center();
      win.show();
      win.focus();
    };
    // The page reports its rendered height; the window fits it, then shows.
    // Once visible, an error line appearing animates the growth (macOS only).
    const onResize = (event, height) => {
      if (!fromThisWindow(event)) return;
      win.setContentSize(WIDTH, Math.min(720, Math.max(200, Math.round(Number(height) || 0))), shown);
      reveal();
    };

    ipcMain.on(CHANNEL.cancel, onCancel);
    ipcMain.on(CHANNEL.quit, onQuit);
    ipcMain.on(CHANNEL.resize, onResize);
    win.on('closed', () => finish(false));

    win.webContents.once('did-finish-load', () => {
      const override = store.override();
      win.webContents.send(CHANNEL.init, {
        mode,
        error,
        host: hostOf(store.appUrl()),
        defaultInstance: describeDefaultInstance(store.baseUrl()),
        current: override ? { kind: 'custom', url: override } : { kind: 'default', url: '' },
        menuPath: `${process.platform === 'darwin' ? app.name : 'View'} → Frontend URL`,
      });
      setTimeout(reveal, 1_500); // never stay hidden if the page reports nothing
    });
    win.loadFile(path.join(__dirname, '..', 'assets', 'instance-chooser.html'));
  });
}

module.exports = { openInstanceChooser, focusInstanceChooser };
