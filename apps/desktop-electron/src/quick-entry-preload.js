// Preload for the Quick Entry bar (assets/quick-entry.html).
// Isolated context; the page gets these six functions and nothing else.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kortixQuickEntry', {
  /**
   * Main → page, on every open: `{ target, session }`. `target` is the project
   * name or null; `session` is the picked `{ title, status }`, or null for a new session.
   */
  onShow: (cb) => ipcRenderer.on('kortix:quick-entry:show', (_e, state) => cb(state)),
  /** Main → page: the same state, after a pick or a new session list. */
  onState: (cb) => ipcRenderer.on('kortix:quick-entry:state', (_e, state) => cb(state)),
  /** Open the session picker at `{ x, y }`, in page coordinates. */
  pick: ({ x, y }) => ipcRenderer.send('kortix:quick-entry:pick', { x: Number(x) || 0, y: Number(y) || 0 }),
  /** Hand the prompt to the app window. Main hides the bar. */
  submit: (text) => ipcRenderer.send('kortix:quick-entry:submit', String(text ?? '')),
  dismiss: () => ipcRenderer.send('kortix:quick-entry:dismiss'),
  /** Page → main: the rendered height, so the window fits the bar as the text grows. */
  resize: (height) => ipcRenderer.send('kortix:quick-entry:resize', Number(height) || 0),
});
