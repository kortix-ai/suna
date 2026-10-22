'use client';

import { ListIcon } from '@phosphor-icons/react';

import { TITLEBAR_CONTROL_CLASS } from '@kortix/ui/internal/desktop/titlebar-control';
import { Button } from '@kortix/ui/button';
import { useTranslations } from '@/i18n/use-translations';
import {
  getDesktopZoom,
  isDesktop,
  setDesktopNativeTheme,
  setDesktopZoom,
  showDesktopAppMenu,
  zoomIn,
  zoomOut,
  zoomReset,
} from '@kortix/ui/internal/lib/desktop';
import {
  DEFAULT_THEME_CHOICE,
  isThemedPath,
  normalizeDarkTheme,
  normalizeLightTheme,
} from '@/lib/interface-themes';
import { projectIdFromPathname } from '@kortix/ui/internal/stores/project-switch-store';
import { useSettingsPanelStore } from '@kortix/ui/internal/stores/settings-panel-store';
import { useUserPreferencesStore } from '@kortix/ui/internal/stores/user-preferences-store';
import { useTheme } from 'next-themes';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';

import { cn } from '@kortix/ui';

/**
 * Invisible top-of-window drag region. The web app's own UI extends to the
 * window edge; this layer just makes the empty area near the traffic lights
 * draggable. macOS draws its traffic lights. Windows and Linux draw their
 * native frame. The strip has zero visual presence: no border or background.
 */
export function DesktopChrome() {
  const { theme } = useTheme();
  const lightTheme = useUserPreferencesStore((s) => normalizeLightTheme(s.preferences.lightTheme));
  const darkTheme = useUserPreferencesStore((s) => normalizeDarkTheme(s.preferences.darkTheme));
  const pathname = usePathname();
  const router = useRouter();

  // The window's launch background follows the page the person is on: their
  // palette on a themed route, the default palette (the brand look) elsewhere,
  // so the auth screen never opens on a Dracula background.
  const themed = isThemedPath(pathname);
  useEffect(() => {
    if (!isDesktop() || !theme) return;
    void setDesktopNativeTheme(
      theme,
      themed ? { light: lightTheme, dark: darkTheme } : DEFAULT_THEME_CHOICE,
    );
  }, [theme, lightTheme, darkTheme, themed]);

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
    <>
      <div className="kx-desktop-chrome" aria-hidden>
        <div className="kx-desktop-drag" data-tauri-drag-region />
      </div>
      <DesktopAppMenuButton />
    </>
  );
}

/**
 * The application menu, in the title-bar band's left slot (Windows). The
 * Windows window has no menu bar, so this button and Alt are how About,
 * Settings, Check for Updates and Change Kortix Instance are reached. CSS
 * shows it only under `html[data-desktop-titlebar='overlay']`, which the
 * shell sets before first paint, so server and client markup stay identical.
 */
function DesktopAppMenuButton() {
  const t = useTranslations('sidebar');
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={t('openMenu')}
      title={t('openMenu')}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        void showDesktopAppMenu(rect.left, rect.bottom);
      }}
      className={cn(
        TITLEBAR_CONTROL_CLASS,
        'kx-desktop-app-menu left-[var(--kx-titlebar-menu-left)] w-[var(--kx-titlebar-control-size)] p-0',
      )}
    >
      <ListIcon className="size-4" />
    </Button>
  );
}
