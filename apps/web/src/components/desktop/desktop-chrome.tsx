'use client';

import {
  getDesktopZoom,
  isDesktop,
  setDesktopNativeTheme,
  setDesktopZoom,
  zoomIn,
  zoomOut,
  zoomReset,
} from '@/lib/desktop';
import { projectIdFromPathname } from '@/stores/project-switch-store';
import { useSettingsPanelStore } from '@/stores/settings-panel-store';
import { useTheme } from 'next-themes';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

/**
 * Invisible top-of-window drag region. The web app's own UI extends to the
 * window edge; this layer just makes the empty area near the traffic lights
 * draggable. macOS draws its traffic lights. Windows and Linux draw their
 * native frame. The strip has zero visual presence: no border or background.
 */
export function DesktopChrome() {
  const { theme } = useTheme();
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (!isDesktop() || !theme) return;
    void setDesktopNativeTheme(theme);
  }, [theme]);

  useEffect(() => {
    if (!isDesktop()) return;

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
    const onCommand = (event: Event) => {
      const command = (event as CustomEvent<string>).detail;
      if (command === 'zoom-in') void zoomIn();
      else if (command === 'zoom-out') void zoomOut();
      else if (command === 'zoom-reset') void zoomReset();
      else if (command === 'open-settings') {
        if (projectIdFromPathname(pathname)) {
          useSettingsPanelStore.getState().openSettings('preferences');
        } else {
          router.push('/settings');
        }
      }
    };
    // Capture phase so we see the keystroke before any inner element (or
    // WKWebView default) consumes it — otherwise Cmd+R can be silently
    // swallowed before our window-level bubble handler ever runs.
    window.addEventListener('keydown', onKey, { capture: true });
    window.addEventListener('kortix-desktop-command', onCommand);
    return () => {
      window.removeEventListener('keydown', onKey, { capture: true } as EventListenerOptions);
      window.removeEventListener('kortix-desktop-command', onCommand);
    };
  }, [pathname, router]);

  return (
    <div className="kx-desktop-chrome" aria-hidden>
      <div className="kx-desktop-drag" data-tauri-drag-region />
    </div>
  );
}
