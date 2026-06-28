// Kortix desktop shell — Electron preload.
//
// Exposes a `window.__TAURI__` object with the shape the web app's desktop
// bridge expects (the previous shell set Tauri's `withGlobalTauri`). The web
// app's only native-bridge consumer — apps/web/src/lib/desktop.ts — talks
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

// Explicit marker so the web app can detect the shell if it ever needs to.
contextBridge.exposeInMainWorld('kortixDesktop', {
  shell: 'electron',
  version: '0.1.0',
});
