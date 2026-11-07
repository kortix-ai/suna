const { beforeEach, describe, it, expect, mock } = require('bun:test');
const { EventEmitter } = require('node:events');

// updater.js loads only inside Electron: fake the two modules it requires and
// record every message box it opens.
const boxes = [];
let answer = 1; // the button the person clicks: 0 = Restart now, 1 = Later / OK
const autoUpdater = Object.assign(new EventEmitter(), {
  checkForUpdates: () => Promise.resolve(),
  quitAndInstall: mock(() => {}),
});
mock.module('electron', () => ({
  app: { isPackaged: true, getVersion: () => '1.2.3' },
  dialog: {
    showMessageBox: (...args) => {
      boxes.push(args);
      return Promise.resolve({ response: answer });
    },
  },
}));
mock.module('electron-updater', () => ({ autoUpdater }));

const liveWindow = { isDestroyed: () => false };
const destroyedWindow = { isDestroyed: () => true };
let mainWindow = null;
let checkForUpdatesInteractive;

beforeEach(() => {
  boxes.length = 0;
  answer = 1;
  autoUpdater.quitAndInstall.mockClear();
  // A fresh updater per test: a staged update is module state that would leak into the next test.
  delete require.cache[require.resolve('./updater')];
  autoUpdater.removeAllListeners();
  const updater = require('./updater');
  updater.setupAutoUpdates({ getSplashWindow: () => null, getMainWindow: () => mainWindow });
  checkForUpdatesInteractive = updater.checkForUpdatesInteractive;
});

const upToDate = {
  type: 'info',
  buttons: ['OK'],
  title: 'You’re up to date',
  message: 'Kortix 1.2.3 is the latest version.',
};

describe('update dialogs', () => {
  it('shows nothing after the silent boot check', () => {
    mainWindow = liveWindow;
    autoUpdater.emit('update-not-available');
    autoUpdater.emit('error', new Error('offline'));
    expect(boxes).toEqual([]);
  });

  it('parents "up to date" to the live app window', () => {
    mainWindow = liveWindow;
    checkForUpdatesInteractive();
    autoUpdater.emit('update-not-available');
    expect(boxes).toEqual([[liveWindow, upToDate]]);
  });

  it('shows "up to date" ownerless when the app window is destroyed', () => {
    mainWindow = destroyedWindow;
    checkForUpdatesInteractive();
    autoUpdater.emit('update-not-available');
    expect(boxes).toEqual([[upToDate]]);
  });

  it('shows a failed check ownerless when there is no app window, and parented when there is one', () => {
    const failed = {
      type: 'error',
      buttons: ['OK'],
      title: 'Update check failed',
      message: 'Couldn’t check for updates.',
      detail: 'offline',
    };
    mainWindow = null;
    checkForUpdatesInteractive();
    autoUpdater.emit('error', new Error('offline'));
    mainWindow = liveWindow;
    checkForUpdatesInteractive();
    autoUpdater.emit('error', new Error('offline'));
    expect(boxes).toEqual([[failed], [liveWindow, failed]]);
  });

  it('offers a restart for a staged update, ownerless without a window, and installs on "Restart now"', async () => {
    const ready = {
      type: 'info',
      buttons: ['Restart now', 'Later'],
      defaultId: 0,
      cancelId: 1,
      title: 'Update ready',
      message: 'Kortix 1.2.4 is ready to install.',
      detail:
        'Restart Kortix to finish updating. It only takes a moment — your work lives on the web, so nothing is lost.',
    };
    mainWindow = destroyedWindow;
    autoUpdater.emit('update-downloaded', { version: '1.2.4' });
    expect(boxes).toEqual([[ready]]);
    await new Promise(setImmediate);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    // The menu check re-opens the prompt for the staged update, on the live window.
    mainWindow = liveWindow;
    answer = 0;
    checkForUpdatesInteractive();
    expect(boxes[1]).toEqual([liveWindow, { ...ready, message: 'A Kortix update is ready to install.' }]);
    await new Promise(setImmediate);
    await new Promise(setImmediate);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
