// Preload for the Quick Entry bar (assets/quick-entry.html).
// Isolated context; the page gets four functions and nothing else.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kortixQuickEntry', {
  /** Main → page, on every open: `{ target }`, the project name for the label, or null. */
  onShow: (cb) => ipcRenderer.on('kortix:quick-entry:show', (_e, state) => cb(state)),
  /** Hand the prompt to the app window. Main hides the bar. */
  submit: (text) => ipcRenderer.send('kortix:quick-entry:submit', String(text ?? '')),
  dismiss: () => ipcRenderer.send('kortix:quick-entry:dismiss'),
  /** Page → main: the rendered height, so the window fits the bar as the text grows. */
  resize: (height) => ipcRenderer.send('kortix:quick-entry:resize', Number(height) || 0),
});
