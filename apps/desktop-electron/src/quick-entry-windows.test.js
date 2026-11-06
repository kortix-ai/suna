const { afterEach, describe, it, expect, mock } = require('bun:test');
const { EventEmitter } = require('node:events');
const path = require('node:path');

// quick-entry.js loads only inside Electron: a fake BrowserWindow records the
// options each window is created with.
const created = [];
class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    created.push(this);
    this.options = options;
    this.webContents = Object.assign(new EventEmitter(), { send() {}, isLoading: () => false });
  }
  loadFile() {}
  loadURL() {
    return Promise.resolve();
  }
  isDestroyed() {
    return false;
  }
  isVisible() {
    return false;
  }
  getOpacity() {
    return 1;
  }
  setOpacity() {}
  setBounds() {}
  setAlwaysOnTop() {}
  showInactive() {}
  show() {}
  focus() {}
  destroy() {}
}
const display = { bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 } };
mock.module('electron', () => ({
  app: { isHidden: () => false },
  BrowserWindow: FakeWindow,
  Menu: {},
  clipboard: {},
  desktopCapturer: {},
  globalShortcut: {},
  ipcMain: { on() {} },
  nativeImage: {},
  screen: { getCursorScreenPoint: () => ({ x: 0, y: 0 }), getDisplayNearestPoint: () => display },
  shell: {},
  systemPreferences: {},
}));
const { setupQuickEntry } = require('./quick-entry');

const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform });
  created.length = 0;
});

/** Open the bar on `os` and return the options of the bar and of its scrim. */
function openOn(os) {
  Object.defineProperty(process, 'platform', { value: os });
  const quickEntry = setupQuickEntry({ dir: '/nonexistent', openMainWindow() {}, getMainWindow: () => null });
  quickEntry.show();
  created[0].webContents.emit('did-finish-load');
  quickEntry.close();
  expect(created).toHaveLength(2);
  return { bar: created[0].options, scrim: created[1].options };
}

const overlay = {
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
  title: 'Quick Entry',
};
const hardened = { contextIsolation: true, nodeIntegration: false, sandbox: true };

describe('Quick Entry windows', () => {
  it('opens the bar and its scrim as frameless always-on-top panels on macOS', () => {
    const { bar, scrim } = openOn('darwin');
    expect(bar).toStrictEqual({
      ...overlay,
      type: 'panel',
      width: 856,
      height: 188,
      webPreferences: { preload: path.join(__dirname, 'quick-entry-preload.js'), ...hardened },
    });
    expect(scrim).toStrictEqual({ ...overlay, type: 'panel', webPreferences: hardened });
  });

  it('opens the same windows without the panel type elsewhere', () => {
    const { bar, scrim } = openOn('linux');
    expect(bar).toStrictEqual({
      ...overlay,
      width: 856,
      height: 188,
      webPreferences: { preload: path.join(__dirname, 'quick-entry-preload.js'), ...hardened },
    });
    expect(scrim).toStrictEqual({ ...overlay, webPreferences: hardened });
  });
});
