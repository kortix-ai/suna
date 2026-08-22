// Electron window chrome shared by the main process and its focused tests.

/* ─── macOS title-bar geometry — THE source of truth ──────────────────────
   `titleBarStyle: 'hidden'` removes the OS title bar but keeps the traffic
   lights, so the web app's own first row shares a band with them. Every
   surface that reaches the top of the window has to agree on where that band
   is, and the numbers live on both sides of a process boundary: the main
   process positions the lights, the (remote) web app positions everything
   else.

   They used to be copied by hand and had drifted into four different band
   heights — 60px in this file's comment, 52px for `.kx-app-header`, 40px for
   the tab bar and both sidebar headers, and a 26px centre line hard-coded into
   two React components. Derive them all from one table instead.

   The web half mirrors this as CSS custom properties on
   `html[data-desktop-platform='macos']` in apps/web/src/app/globals.css;
   apps/web/src/features/workspace/project-layout/desktop-titlebar.test.ts
   fails if the two ever disagree again. */
const MAC_TITLEBAR = {
  /** Height of the band the traffic lights and the app's first row share. */
  band: 40,
  /** Traffic-light diameter (macOS Big Sur and later). */
  lightSize: 12,
  /** Traffic-light centre-to-centre spacing. */
  lightPitch: 20,
  /** Left inset of the first (close) light. */
  lightInsetX: 10,
  /** Clear space between the last light and the app's first control. */
  gutter: 10,
  /** Box of a web-rendered control sitting in the band. */
  control: 28,
  /** Optical gap between that control and the content following it. */
  contentGap: 8,
};

/** Vertically centre a `size`-tall box in the band. */
function centerInBand(size) {
  return (MAC_TITLEBAR.band - size) / 2;
}

/**
 * `BrowserWindowConstructorOptions.trafficLightPosition` — the top-left of the
 * traffic-light cluster, centred in the band.
 */
function macTrafficLightPosition() {
  return {
    x: MAC_TITLEBAR.lightInsetX,
    y: centerInBand(MAC_TITLEBAR.lightSize),
  };
}

/** Window x where the traffic-light cluster ends (3 lights, 2 gaps). */
function macLightsEndX() {
  const { lightInsetX, lightSize, lightPitch } = MAC_TITLEBAR;
  return lightInsetX + lightSize + lightPitch * 2;
}

/**
 * Web-side placement, in window px, for the one control the app draws in the
 * band (the shell's "Open sidebar" toggle) and for the content after it.
 * Mirrored into CSS custom properties by globals.css.
 */
function macBandMetrics() {
  const controlLeft = macLightsEndX() + MAC_TITLEBAR.gutter;
  return {
    band: MAC_TITLEBAR.band,
    lightsEnd: macLightsEndX(),
    controlTop: centerInBand(MAC_TITLEBAR.control),
    controlLeft,
    contentLeft: controlLeft + MAC_TITLEBAR.control + MAC_TITLEBAR.contentGap,
  };
}

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

module.exports = {
  DESKTOP_CHROME_JS,
  MAC_TITLEBAR,
  configureNativeWindowControls,
  macBandMetrics,
  macLightsEndX,
  macTrafficLightPosition,
};
