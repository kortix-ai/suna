'use client';

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

  useEffect(() => {
    if (!isDesktop()) return;
    setPlatform(desktopPlatform());

    // Reapply persisted zoom on mount. WKWebView resets to 1.0 each launch,
    // so we always have to push the saved value back in.
    void setDesktopZoom(getDesktopZoom());

    // Browser-style zoom shortcuts. Cmd on macOS, Ctrl elsewhere.
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // `=` and `+` both produce the in-zoom shortcut on US layouts; `Shift+=` is `+`.
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        void zoomIn();
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        void zoomOut();
      } else if (e.key === '0') {
        e.preventDefault();
        void zoomReset();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="kx-desktop-chrome" aria-hidden>
      <div className="kx-desktop-drag" data-tauri-drag-region />
      {platform && platform !== 'macos' ? <WindowControls /> : null}
    </div>
  );
}

function WindowControls() {
  return (
    <div className="kx-desktop-controls" aria-label="Window controls">
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
