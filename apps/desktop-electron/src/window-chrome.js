// Electron window chrome shared by the main process and its focused tests.

// Keep drag behavior on explicit web-app regions only. A previous fallback
// inserted a 40px, full-width drag strip over the title-bar band. Chromium
// treats app regions at the compositor level, so pointer-events:none did not
// make the controls underneath clickable; Projects, workspace, Upgrade, and
// account actions could all become window-drag targets instead.
const DESKTOP_CHROME_JS = `
(function () {
  if (window.__kortixChrome) return;
  window.__kortixChrome = true;

  var style = document.createElement('style');
  style.id = 'kortix-chrome-style';
  style.textContent =
    '[role="tablist"],[data-sidebar="header"],[data-sidebar="sidebar"],' +
    '.kx-desktop-drag,.kx-desktop-chrome{-webkit-app-region:drag;}' +
    'button,a,input,textarea,select,option,label,summary,video,audio,iframe,' +
    '[role="button"],[role="tab"],[role="link"],[role="menuitem"],[role="textbox"],' +
    '[contenteditable],[data-no-drag]{-webkit-app-region:no-drag;}';
  (document.head || document.documentElement).appendChild(style);
})();
`;

/** Use the platform controls instead of painting a second web copy. */
function configureNativeWindowControls(window, isMac) {
  if (isMac) window.setWindowButtonVisibility(true);
}

module.exports = { DESKTOP_CHROME_JS, configureNativeWindowControls };
