'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import {
  useProjectSessionTabsStore,
  CUSTOMIZE_TAB_ID,
} from '@/stores/project-session-tabs-store';
import { useCloseProjectTab } from '@/hooks/projects/use-close-project-tab';
import { isDesktop } from '@/lib/desktop';

/**
 * Project-shell keyboard shortcuts — equivalents to the legacy dashboard's
 * tab-bar shortcuts, scoped to the project's open session tabs.
 *
 * | Shortcut              | Action                              |
 * |-----------------------|-------------------------------------|
 * | Mod+T                 | New session (same as Mod+J)         |
 * | Ctrl+W                | Close active session tab            |
 * | Mod+Shift+T           | Reopen last closed session tab      |
 * | Mod+Shift+]           | Next tab                            |
 * | Mod+Shift+[           | Previous tab                        |
 * | Mod+Alt+ArrowRight    | Next tab (alt)                      |
 * | Mod+Alt+ArrowLeft     | Previous tab (alt)                  |
 * | Mod+1 … Mod+8         | Switch to nth open tab              |
 * | Mod+9                 | Switch to LAST open tab             |
 *
 * `Mod` follows the user's `tabSwitchModifier` preference (Ctrl by default).
 * Global shortcuts (Mod+J new session, Mod+K command palette, Mod+B sidebar
 * toggles) live in their own components and aren't duplicated here.
 *
 * Ctrl+W is always Ctrl (never Cmd) because macOS browsers intercept Cmd+W
 * to close the tab/window — same compromise the legacy tab-bar uses.
 */
export function useProjectShellShortcuts({
  projectId,
  onNewSession,
}: {
  projectId: string;
  onNewSession: () => void;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const tabSwitchModifier = useUserPreferencesStore(
    (s) => s.preferences.keyboard.tabSwitchModifier,
  );
  const reopenLastClosed = useProjectSessionTabsStore((s) => s.reopenLastClosed);
  const closeProjectTab = useCloseProjectTab(projectId);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const modHeld = tabSwitchModifier === 'meta' ? e.metaKey : e.ctrlKey;
      const modOther = tabSwitchModifier === 'meta' ? e.ctrlKey : e.metaKey;

      // Resolve the active tab from the URL (cheaper than threading params).
      // The active tab is either a session id, the Customize sentinel, or none.
      const sessMatch = pathname?.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)/);
      const custMatch = pathname?.match(/^\/projects\/([^/]+)\/customize/);
      const urlProject = sessMatch?.[1] ?? custMatch?.[1] ?? null;
      const activeTabId = sessMatch?.[2] ?? (custMatch ? CUSTOMIZE_TAB_ID : null);
      const tabs =
        useProjectSessionTabsStore.getState().tabsByProject[projectId] ?? [];

      const hrefForTab = (id: string) =>
        id === CUSTOMIZE_TAB_ID
          ? `/projects/${projectId}/customize`
          : `/projects/${projectId}/sessions/${id}`;
      const goToTab = (id: string) => router.push(hrefForTab(id));

      // New tab — Mod+T
      if (modHeld && !modOther && !e.shiftKey && !e.altKey && e.code === 'KeyT') {
        e.preventDefault();
        onNewSession();
        return;
      }

      // Reopen last closed — Mod+Shift+T
      if (modHeld && !modOther && e.shiftKey && !e.altKey && e.code === 'KeyT') {
        e.preventDefault();
        const reopened = reopenLastClosed(projectId);
        if (reopened) goToTab(reopened);
        return;
      }

      // Close active tab — Ctrl+W everywhere; Cmd+W too in the desktop app
      // (no browser there to hijack it). Works for sessions and Customize.
      if (
        e.code === 'KeyW' &&
        !e.shiftKey &&
        !e.altKey &&
        ((e.ctrlKey && !e.metaKey) || (isDesktop() && e.metaKey && !e.ctrlKey))
      ) {
        if (urlProject !== projectId || !activeTabId) return;
        e.preventDefault();
        // Single source of truth for tab close (handles stale-event guard,
        // optimistic active pin, navigate-first ordering, transition).
        closeProjectTab(activeTabId);
        return;
      }

      // Next tab — Mod+Alt+ArrowRight
      if (modHeld && !modOther && !e.shiftKey && e.altKey && e.code === 'ArrowRight') {
        if (tabs.length === 0) return;
        e.preventDefault();
        const idx = activeTabId ? tabs.indexOf(activeTabId) : -1;
        goToTab(tabs[(idx + 1 + tabs.length) % tabs.length]);
        return;
      }

      // Prev tab — Mod+Alt+ArrowLeft
      if (modHeld && !modOther && !e.shiftKey && e.altKey && e.code === 'ArrowLeft') {
        if (tabs.length === 0) return;
        e.preventDefault();
        const idx = activeTabId ? tabs.indexOf(activeTabId) : 0;
        goToTab(tabs[(idx - 1 + tabs.length) % tabs.length]);
        return;
      }

      if (e.altKey) return; // remaining shortcuts reject alt

      // Next tab — Mod+Shift+]
      if (modHeld && !modOther && e.shiftKey && e.code === 'BracketRight') {
        if (tabs.length === 0) return;
        e.preventDefault();
        const idx = activeTabId ? tabs.indexOf(activeTabId) : -1;
        goToTab(tabs[(idx + 1 + tabs.length) % tabs.length]);
        return;
      }

      // Prev tab — Mod+Shift+[
      if (modHeld && !modOther && e.shiftKey && e.code === 'BracketLeft') {
        if (tabs.length === 0) return;
        e.preventDefault();
        const idx = activeTabId ? tabs.indexOf(activeTabId) : 0;
        goToTab(tabs[(idx - 1 + tabs.length) % tabs.length]);
        return;
      }

      // Switch to tab N — Mod+1..8 (1-based)
      // Switch to LAST tab — Mod+9
      if (modHeld && !modOther && !e.shiftKey) {
        const digitMatch = e.code.match(/^Digit(\d)$/);
        if (digitMatch) {
          const num = parseInt(digitMatch[1], 10);
          if (num >= 1 && num <= 8) {
            if (tabs[num - 1]) {
              e.preventDefault();
              goToTab(tabs[num - 1]);
            }
            return;
          }
          if (num === 9 && tabs.length > 0) {
            e.preventDefault();
            goToTab(tabs[tabs.length - 1]);
            return;
          }
        }
      }
    };

    // Capture phase: WKWebView (desktop) and inner elements can swallow some
    // key combos before a bubble-phase window listener runs — the same reason
    // DesktopChrome captures Cmd+R. Capturing guarantees Ctrl+W et al. fire.
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [projectId, pathname, router, tabSwitchModifier, onNewSession, closeProjectTab, reopenLastClosed]);
}
