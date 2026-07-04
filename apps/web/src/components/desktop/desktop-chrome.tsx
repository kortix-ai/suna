'use client';

import { useTranslations } from 'next-intl';

import { useEffect, useState } from 'react';
import {
  desktopPlatform,
  desktopWindow,
  getDesktopZoom,
  isDesktop,
  setDesktopZoom,
  zoomIn,
  zoomOut,
  zoomReset,
  type DesktopPlatform,
} from '@/lib/desktop';

/**
 * Invisible top-of-window drag region. The web app's own UI extends to the
 * window edge; this layer just makes the empty area near the traffic lights
 * draggable. On macOS the OS draws the traffic lights itself; on Win/Linux
 * we render minimal min/max/close buttons here since `decorations: true` would
 * draw the OS title bar (which we don't want). The strip has zero visual
 * presence — `transparent`, no border, no background.
 */
export function DesktopChrome() {
  const [platform, setPlatform] = useState<DesktopPlatform | null>(null);
  // Only the Electron shell hides the native macOS traffic lights (its
  // preload exposes this marker) — the Tauri shell keeps them, so drawing
  // our own there would double them up.
  const [isElectronShell, setIsElectronShell] = useState(false);

  useEffect(() => {
    if (!isDesktop()) return;
    setPlatform(desktopPlatform());
    setIsElectronShell(
      (window as unknown as { kortixDesktop?: { shell?: string } }).kortixDesktop?.shell ===
        'electron',
    );

    // Reapply persisted zoom on mount. WKWebView resets to 1.0 each launch,
    // so we always have to push the saved value back in.
    void setDesktopZoom(getDesktopZoom());

    // Browser-style shortcuts. Cmd on macOS, Ctrl elsewhere.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // Zoom: `=`/`+` zoom in, `-`/`_` zoom out, `0` reset.
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        void zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        void zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        void zoomReset();
      } else if (e.key === 'r' || e.key === 'R') {
        // Reload the webview. WKWebView swallows Cmd+R by default; this
        // makes it work like every other app on macOS. (Cmd+B sidebar
        // toggle is already wired by the shadcn SidebarProvider —
        // don't intercept it here.)
        e.preventDefault();
        window.location.reload();
      }
    };
    // Capture phase so we see the keystroke before any inner element (or
    // WKWebView default) consumes it — otherwise Cmd+R can be silently
    // swallowed before our window-level bubble handler ever runs.
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions);
  }, []);

  return (
    <div className="kx-desktop-chrome" aria-hidden>
      <div className="kx-desktop-drag" data-tauri-drag-region />
      {platform === 'macos' && isElectronShell ? <MacTrafficLights /> : null}
      {platform && platform !== 'macos' ? <WindowControls /> : null}
    </div>
  );
}

/**
 * Custom macOS traffic lights. The native ones render permanently gray on
 * macOS 26 (Tahoe) for hidden-title-bar Electron windows, so the shell hides
 * them (main.js `setWindowButtonVisibility(false)`) and we draw our own in
 * the same zone (x 10–70, center y≈26 — the calibrated title-bar line) wired
 * to the same window controls. Native behaviors kept: glyphs appear on
 * group hover, dots dim to gray when the window loses focus.
 */
const MAC_LIGHTS = [
  {
    action: () => void desktopWindow.close(),
    label: 'Close',
    color: '#ff5f57',
    glyph: (
      <path d="M3.5 3.5 L9.5 9.5 M9.5 3.5 L3.5 9.5" stroke="#4d0000" strokeWidth="1.2" strokeLinecap="round" />
    ),
  },
  {
    action: () => void desktopWindow.minimize(),
    label: 'Minimize',
    color: '#febc2e',
    glyph: <path d="M3 6.5 L10 6.5" stroke="#985712" strokeWidth="1.2" strokeLinecap="round" />,
  },
  {
    action: () => void desktopWindow.toggleMaximize(),
    label: 'Zoom',
    color: '#28c840',
    glyph: (
      <path d="M6.5 3 L6.5 10 M3 6.5 L10 6.5" stroke="#0b5d16" strokeWidth="1.2" strokeLinecap="round" />
    ),
  },
] as const;

function MacTrafficLights() {
  // Native lights dim to gray when the window isn't focused — mirror that.
  const [focused, setFocused] = useState(true);
  useEffect(() => {
    setFocused(document.hasFocus());
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  return (
    // Native geometry, pinned in raw px (rem drifts with the root font):
    // 20px hit boxes butted together → dot centers at x 16/36/56, zone ends
    // at 66 — inside the ~70px gutter every header indent already clears.
    <div className="group fixed top-[16px] left-[6px] z-[10000] flex [-webkit-app-region:no-drag] [app-region:no-drag]">
      {MAC_LIGHTS.map((light) => (
        <button
          key={light.label}
          type="button"
          aria-label={light.label}
          onClick={light.action}
          className="flex h-[20px] w-[20px] cursor-default items-center justify-center"
        >
          <span
            className="flex h-[13px] w-[13px] items-center justify-center rounded-full shadow-[inset_0_0_0_0.5px_rgba(0,0,0,0.15)] transition-[background-color] duration-150"
            style={{ backgroundColor: focused ? light.color : 'var(--kx-light-inactive, #8e8e8e)' }}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 13 13"
              aria-hidden
              className="opacity-0 transition-opacity duration-100 group-hover:opacity-100"
            >
              {light.glyph}
            </svg>
          </span>
        </button>
      ))}
    </div>
  );
}

function WindowControls() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="kx-desktop-controls" aria-label={tHardcodedUi.raw('componentsDesktopDesktopChrome.line74JsxAttrAriaLabelWindowControls')}>
      <button
        type="button"
        className="kx-desktop-ctrl"
        aria-label="Minimize"
        onClick={() => void desktopWindow.minimize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <rect x="1" y="4.5" width="8" height="1" fill="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className="kx-desktop-ctrl"
        aria-label="Maximize"
        onClick={() => void desktopWindow.toggleMaximize()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" />
        </svg>
      </button>
      <button
        type="button"
        className="kx-desktop-ctrl kx-desktop-ctrl-close"
        aria-label="Close"
        onClick={() => void desktopWindow.close()}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden>
          <path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>
    </div>
  );
}
