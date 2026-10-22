// Preload for the Quick Entry bar (assets/quick-entry.html).
// Isolated context; the page gets these functions and nothing else.

const { contextBridge, ipcRenderer } = require('electron');

const MENUS = ['session', 'agent'];

contextBridge.exposeInMainWorld('kortixQuickEntry', {
  /**
   * Main → page, on every open: `{ target, session, composer, canScreenshot }`.
   * `target` is the project name or null; `session` the picked `{ title, status }`
   * or null for a new session; `composer` the new session's agent label, or null.
   */
  onShow: (cb) => ipcRenderer.on('kortix:quick-entry:show', (_e, state) => cb(state)),
  /** Main → page: the bar is closing; play the close transition before main hides the window. */
  onHide: (cb) => ipcRenderer.on('kortix:quick-entry:hide', () => cb()),
  /** Main → page: the same state, after a pick or a new list from the app. */
  onState: (cb) => ipcRenderer.on('kortix:quick-entry:state', (_e, state) => cb(state)),
  /** Main → page: a screenshot to attach, `{ name, type, bytes }`. */
  onAttach: (cb) => ipcRenderer.on('kortix:quick-entry:attach', (_e, file) => cb(file)),
  /** Main → page: a one-line notice `{ text, action? }`, or `{ text: null }` to clear it. */
  onNotice: (cb) => ipcRenderer.on('kortix:quick-entry:notice', (_e, notice) => cb(notice)),
  /** Open one of the bar's native menus at `{ x, y }`, in page coordinates. */
  menu: (kind, { x, y }) => {
    if (MENUS.includes(kind)) ipcRenderer.send('kortix:quick-entry:menu', kind, { x: Number(x) || 0, y: Number(y) || 0 });
  },
  /** Hide the bar, let the person select a screen region, and attach it. */
  screenshot: () => ipcRenderer.send('kortix:quick-entry:screenshot'),
  /** Run the current notice's action. */
  noticeAction: () => ipcRenderer.send('kortix:quick-entry:notice-action'),
  /** Hand the prompt and its files (`{ name, type, bytes }`) to the app window. Main hides the bar. */
  submit: (text, attachments) =>
    ipcRenderer.send('kortix:quick-entry:submit', String(text ?? ''), Array.isArray(attachments) ? attachments : []),
  dismiss: () => ipcRenderer.send('kortix:quick-entry:dismiss'),
  /** Page → main: the rendered height, so the window fits the bar as it grows. */
  resize: (height) => ipcRenderer.send('kortix:quick-entry:resize', Number(height) || 0),
});
