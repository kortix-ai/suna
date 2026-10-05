// Renderer recovery policy for the desktop shell — pure, no Electron.
//
// When the main window's renderer process dies, the window keeps its
// background colour and nothing else: no page, no script, no in-app exit.
// main.js asks this module whether to offer Reload.

/**
 * Whether a `render-process-gone` event left the window without a page.
 * Everything except a clean exit does: crashed, killed, oom, abnormal-exit,
 * launch-failed, integrity-failure. Missing details recover too — an empty
 * window is the worse mistake.
 *
 * @param {{ reason?: string } | undefined} details
 */
function rendererGoneNeedsRecovery(details) {
  return details?.reason !== 'clean-exit';
}

module.exports = { rendererGoneNeedsRecovery };
