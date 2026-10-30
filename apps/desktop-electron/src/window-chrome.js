// Electron window chrome shared by the main process and its focused tests.

/* ─── macOS title-bar geometry — THE source of truth ──────────────────────
   `titleBarStyle: 'hidden'` removes the OS title bar but keeps the traffic
   lights, so the web app's own first row shares a band with them. Every
   surface that reaches the top of the window has to agree on where that band
   is, and the numbers live on both sides of a process boundary: the main
   process positions the lights, the (remote) web app positions everything
   else.

   They used to be copied by hand and had drifted into four different band
   heights — 60px in this file's comment, 52px for the standalone-page
   breadcrumb header, 40px for the tab bar and both sidebar headers, and a
   26px centre line hard-coded into two React components. Derive them all
   from one table instead.

   The web half mirrors this as CSS custom properties on
   `html[data-desktop-platform='macos']` in apps/web/src/app/globals.css;
   apps/web/src/features/workspace/project-layout/desktop-titlebar.test.ts
   fails if the two ever disagree again. */
const MAC_TITLEBAR = {
  /** Height of the band the traffic lights and the app's first row share. */
  band: 40,
  /** Traffic-light diameter (macOS Big Sur and later). */
  lightSize: 12,
  /** Height of the button frame positioned by AppKit. */
  lightFrame: 24,
  /**
   * The supplied Retina capture places the visible native circle 10 image
   * pixels above the project row even though the old 24px-frame model said
   * they matched. Move AppKit's origin by five window pixels, not the web row.
   */
  nativeCenterCorrectionY: 5,
  /** Traffic-light centre-to-centre spacing. */
  lightPitch: 20,
  /** Left inset of the first (close) light. */
  lightInsetX: 10,
  /** Clear space between the last light and the app's first control. */
  gutter: 16,
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
 * lights' button frames, placed so the circles centre in the band.
 */
function macTrafficLightPosition() {
  return {
    x: MAC_TITLEBAR.lightInsetX,
    y: centerInBand(MAC_TITLEBAR.lightFrame) + MAC_TITLEBAR.nativeCenterCorrectionY,
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

/* ─── Windows title-bar geometry ─────────────────────────────────────────
   Windows uses `titleBarStyle: 'hidden'` + `titleBarOverlay`: no Win32 title
   bar and no menu-bar strip. Windows draws only minimize / maximize / close,
   over the top-right corner of the page. The page then shares one band with
   them, the same model as the macOS lights, mirrored:

   - right: the caption buttons. Electron sizes each at Chromium's
     kWindowsCaptionButtonWidth (45 px) plus 1 px spacing between buttons
     (shell/browser/ui/views/win_caption_button.cc), so 3 buttons = 137 px.
     The page reserves 138.
   - left: the web app draws one control in the slot the lights take on macOS,
     the app-menu button. It pops up this shell's application menu
     (`show_app_menu`), so About, Settings, Check for Updates and Change Kortix
     Instance are one click away. Alt opens the same menu.

   The web half mirrors this as CSS custom properties on
   `html[data-desktop-titlebar='overlay']` in apps/web/src/app/globals.css;
   apps/web/src/features/workspace/project-layout/desktop-titlebar.test.ts
   fails if the two disagree. */
const WIN_TITLEBAR = {
  /** Height of the band the caption buttons and the app's first row share. */
  band: 40,
  /** Width of the three caption buttons, right edge of the window. */
  controlsWidth: 138,
  /** Box of a web-rendered control sitting in the band. */
  control: 28,
  /** Left inset of the app-menu button. */
  insetX: 8,
  /** Clear space between two web-rendered controls in the band. */
  gutter: 8,
};

/** Web-side placement, in window px. Mirrored into CSS by globals.css. */
function winBandMetrics() {
  const { band, controlsWidth, control, insetX, gutter } = WIN_TITLEBAR;
  const menuEnd = insetX + control;
  const controlLeft = menuEnd + gutter;
  return {
    band,
    controlsWidth,
    controlTop: (band - control) / 2,
    menuLeft: insetX,
    menuEnd,
    controlLeft,
    contentLeft: controlLeft + control + gutter,
  };
}

/**
 * `titleBarOverlay` for `dark`. The overlay is transparent, so the page's own
 * surface shows behind the buttons; only the glyphs follow the theme (the
 * web app's `--foreground` for Pure light / Pure dark).
 */
function winTitleBarOverlay(dark) {
  return {
    color: '#00000000',
    symbolColor: dark ? '#FFFFFF' : '#1F1F1F',
    height: WIN_TITLEBAR.band,
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
  WIN_TITLEBAR,
  configureNativeWindowControls,
  macBandMetrics,
  macLightsEndX,
  macTrafficLightPosition,
  winBandMetrics,
  winTitleBarOverlay,
};
