// ⌘I (Ctrl+I) toggles the session's right-side panel: the web app's
// `toggleRightPanel` (packages/ui, session-action-panel-column.tsx).
//
// The page handles the key while its own document has focus. A cross-origin
// <iframe>, such as the session's Browser preview, receives its own keys, and
// the page never sees them: after a click into the preview, ⌘I did nothing
// (KRTX-2944). From a subframe the shell takes the key and sends the command
// the page listens for. It never takes the key from the page itself, so one
// press toggles once on any web build.

const PANEL_TOGGLE_COMMAND = 'toggle-right-panel';

/**
 * Whether the shell forwards this key to the page as `PANEL_TOGGLE_COMMAND`:
 * a plain ⌘I / Ctrl+I keyDown while focus is in a subframe. Alt and Shift stay
 * with DevTools (⌥⌘I, Ctrl+Shift+I).
 *
 * @param {Electron.Input} input from `before-input-event`
 * @param {{ parent: unknown } | null} focusedFrame `webContents.focusedFrame`
 */
function forwardsPanelToggle(input, focusedFrame) {
  return (
    input.type === 'keyDown' &&
    !input.isAutoRepeat &&
    (input.meta || input.control) &&
    !input.alt &&
    !input.shift &&
    input.key.toLowerCase() === 'i' &&
    Boolean(focusedFrame && focusedFrame.parent)
  );
}

module.exports = { PANEL_TOGGLE_COMMAND, forwardsPanelToggle };
