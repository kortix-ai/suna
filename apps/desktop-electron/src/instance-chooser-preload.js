// Preload for the Kortix instance chooser (assets/instance-chooser.html).
// Isolated context; the page gets five functions and nothing else.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kortixInstance', {
  /** Main → page: mode / default instance / current choice / error text. */
  onInit: (cb) => ipcRenderer.on('kortix:instance:init', (_e, init) => cb(init)),
  /** Resolves to { ok: true } (main closes the window) or { ok: false, error, unreachable? }. */
  submit: ({ kind, url, force }) =>
    ipcRenderer.invoke('kortix:instance:submit', {
      kind: kind === 'custom' ? 'custom' : 'default',
      url: String(url ?? ''),
      force: Boolean(force),
    }),
  cancel: () => ipcRenderer.send('kortix:instance:cancel'),
  quit: () => ipcRenderer.send('kortix:instance:quit'),
  /** Page → main: rendered content height, so the window fits its content. */
  resize: (height) => ipcRenderer.send('kortix:instance:resize', Number(height) || 0),
});
