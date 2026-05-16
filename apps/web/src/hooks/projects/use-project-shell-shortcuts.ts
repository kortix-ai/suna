'use client';

import { useEffect } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { useProjectSessionTabsStore } from '@/stores/project-session-tabs-store';

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
  const closeTab = useProjectSessionTabsStore((s) => s.closeTab);
  const reopenLastClosed = useProjectSessionTabsStore((s) => s.reopenLastClosed);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const modHeld = tabSwitchModifier === 'meta' ? e.metaKey : e.ctrlKey;
      const modOther = tabSwitchModifier === 'meta' ? e.ctrlKey : e.metaKey;

      // Resolve active session from URL (cheaper than threading params).
      const m = pathname?.match(/^\/projects\/([^/]+)\/sessions\/([^/]+)/);
      const urlProject = m?.[1];
      const activeSessionId = m?.[2] ?? null;
      const tabs =
        useProjectSessionTabsStore.getState().tabsByProject[projectId] ?? [];

      const goToTab = (sessionId: string) => {
        router.push(`/projects/${projectId}/sessions/${sessionId}`);
      };

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

      // Close active tab — always Ctrl+W (Cmd+W is hijacked by macOS browsers).
      if (e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey && e.code === 'KeyW') {
        if (urlProject !== projectId || !activeSessionId) return;
        e.preventDefault();
        const remaining = tabs.filter((id) => id !== activeSessionId);
        closeTab(projectId, activeSessionId);
        if (remaining.length > 0) {
          const idx = tabs.indexOf(activeSessionId);
          goToTab(remaining[Math.min(idx, remaining.length - 1)]);
        } else {
          router.push(`/projects/${projectId}/sessions`);
        }
        return;
      }

      // Next tab — Mod+Alt+ArrowRight
      if (modHeld && !modOther && !e.shiftKey && e.altKey && e.code === 'ArrowRight') {
        if (tabs.length === 0) return;
        e.preventDefault();
        const idx = activeSessionId ? tabs.indexOf(activeSessionId) : -1;
        goToTab(tabs[(idx + 1 + tabs.length) % tabs.length]);
        return;
      }

      // Prev tab — Mod+Alt+ArrowLeft
      if (modHeld && !modOther && !e.shiftKey && e.altKey && e.code === 'ArrowLeft') {
        if (tabs.length === 0) return;
        e.preventDefault();
        const idx = activeSessionId ? tabs.indexOf(activeSessionId) : 0;
        goToTab(tabs[(idx - 1 + tabs.length) % tabs.length]);
        return;
      }

      if (e.altKey) return; // remaining shortcuts reject alt

      // Next tab — Mod+Shift+]
      if (modHeld && !modOther && e.shiftKey && e.code === 'BracketRight') {
        if (tabs.length === 0) return;
        e.preventDefault();
        const idx = activeSessionId ? tabs.indexOf(activeSessionId) : -1;
        goToTab(tabs[(idx + 1 + tabs.length) % tabs.length]);
        return;
      }

      // Prev tab — Mod+Shift+[
      if (modHeld && !modOther && e.shiftKey && e.code === 'BracketLeft') {
        if (tabs.length === 0) return;
        e.preventDefault();
        const idx = activeSessionId ? tabs.indexOf(activeSessionId) : 0;
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

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [projectId, pathname, router, tabSwitchModifier, onNewSession, closeTab, reopenLastClosed]);
}
