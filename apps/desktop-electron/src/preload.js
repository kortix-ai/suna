// Kortix desktop shell — Electron preload.
//
// Exposes a `window.__TAURI__` object with the shape the web app's desktop
// bridge expects (the previous shell set Tauri's `withGlobalTauri`). The web
// app's only native-bridge consumer — packages/ui/src/internal/lib/desktop.ts — talks
// exclusively through `window.__TAURI__.core.invoke(...)` and
// `window.__TAURI__.window.getCurrentWindow()`, so mirroring that shape here
// means the entire web app runs UNCHANGED on Electron. No `isElectron` branches
// in the web code; `isDesktop()` keeps working off the shared UA token.
//
// Runs in an isolated context (contextIsolation: true). contextBridge proxies
// the functions below into the page's main world; the heavy lifting happens in
// the main process over the `kortix:invoke` / `kortix:window` IPC channels.

const { contextBridge, ipcRenderer } = require('electron');

/** Tauri `core.invoke(cmd, args)` → main-process command funnel. */
const invoke = (cmd, args) => ipcRenderer.invoke('kortix:invoke', cmd, args);

/** Tauri `getCurrentWindow().<action>()` → window-control funnel. */
const winCall = (action) => ipcRenderer.invoke('kortix:window', action);

const currentWindow = {
  minimize: () => winCall('minimize'),
  toggleMaximize: () => winCall('toggleMaximize'),
  close: () => winCall('close'),
  isMaximized: () => winCall('isMaximized'),
  // Tauri returns Promise<() => void>; returning the unlisten fn directly is
  // fine — desktop.ts awaits it and `await fn` resolves to the fn itself.
  onResized: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('kortix:resized', listener);
    return () => ipcRenderer.removeListener('kortix:resized', listener);
  },
  // Dragging is handled natively via `-webkit-app-region` CSS (see main.js),
  // so this is a no-op — only the Tauri-injected drag shim ever called it.
  startDragging: () => {},
};

contextBridge.exposeInMainWorld('__TAURI__', {
  core: { invoke },
  window: { getCurrentWindow: () => currentWindow },
});

// Mouse side buttons. A browser steps history on them; Electron does nothing.
// DOM `button` 3 and 4 are the back and forward buttons on macOS, Windows and
// Linux alike, so one listener covers every platform (Windows' `app-command`
// would fire for the same click and navigate twice). The main process picks
// the history entry, so an entry outside the app is never reloaded here.
window.addEventListener(
  'mouseup',
  (event) => {
    const direction = event.button === 3 ? 'back' : event.button === 4 ? 'forward' : null;
    if (!direction) return;
    event.preventDefault();
    void ipcRenderer.invoke('kortix:navigate', direction);
  },
  true,
);

// Explicit marker so the web app can detect the shell if it ever needs to.
contextBridge.exposeInMainWorld('kortixDesktop', {
  shell: 'electron',
  version: '0.1.0',
  // 'overlay': the OS draws only the caption buttons over the page's top row
  // (Windows, window-chrome.js → WIN_TITLEBAR). The web app's head script
  // reads it before first paint and sets `data-desktop-titlebar`, so a shell
  // with the native title bar never gets the band layout.
  titlebar: process.platform === 'win32' ? 'overlay' : 'default',
  // One history step through the shell's policy, which skips entries the
  // navigation gate keeps out of the window. Resolves true when it moved. The
  // web app's Back uses this: a renderer history.back() into such an entry is
  // cancelled by the gate (will-navigate does fire for it) and nothing happens.
  navigate: (direction) => ipcRenderer.invoke('kortix:navigate', direction),
});

ipcRenderer.on('kortix:command', (_event, command) => {
  window.dispatchEvent(new CustomEvent('kortix-desktop-command', { detail: command }));
});

// A prompt is waiting in the Quick Entry bar. The event carries no text: the
// web app takes it with the trusted `quick_entry_take` command.
ipcRenderer.on('kortix:quick-entry', () => {
  window.dispatchEvent(new CustomEvent('kortix-desktop-quick-entry'));
});

// An agent, model or effort picked in the Quick Entry bar. The detail is a JSON
// string: an object built in this isolated world would reach the page as null.
ipcRenderer.on('kortix:quick-entry-select', (_event, kind, value) => {
  window.dispatchEvent(
    new CustomEvent('kortix-desktop-quick-entry-select', { detail: JSON.stringify({ kind, value }) }),
  );
});

const setFullscreenState = (fullscreen) => {
  const html = document.documentElement;
  if (!html) return;
  if (fullscreen) html.setAttribute('data-desktop-fullscreen', 'true');
  else html.removeAttribute('data-desktop-fullscreen');
};
ipcRenderer.on('kortix:fullscreen', (_event, fullscreen) => setFullscreenState(fullscreen));
