'use client';

/**
 * Open the active session's Terminal, Audit, or Browser surface from OUTSIDE
 * the panel (the command palette, the session header). One shared implementation
 * because the branching is id-space-sensitive and was already burned once:
 *
 * - Easy mode routes through `requestQuickView`, which resolves the active
 *   session from the kortix-computer-store's own `_activeSessionId` —
 *   callers outside the panel have no reliable id of their own (the URL id
 *   is a DIFFERENT id space from the OpenCode `chatSessionId` panel state is
 *   keyed by; see `session-browser-store.ts`'s `getActivePanelSessionId`).
 * - Advanced mode has no pending-view consumer (its tab strip reads
 *   `session-browser-store` directly), so it writes `setView` onto the
 *   active panel session via that same helper, then opens the panel.
 */

import { track } from '@/lib/track';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { getActivePanelSessionId, useSessionBrowserStore } from '@/stores/session-browser-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';

export function openSessionQuickView(
  view: 'terminal' | 'audit' | 'browser' | 'files',
  source: 'palette' | 'header',
): void {
  const wasOpen = useKortixComputerStore.getState().isSidePanelOpen;
  const panelMode =
    useUserPreferencesStore.getState().preferences.panelMode ?? 'easy';

  // Resolved here for BOTH modes: session-browser-store's active panel
  // session is maintained on every route (tab dashboard AND the standalone
  // session page), unlike kortix-computer-store's `_activeSessionId`, which
  // is tab-gated — relying on the latter silently dropped the terminal open
  // on /projects/:id/sessions/:id.
  const activePanelSessionId = getActivePanelSessionId();

  if (panelMode === 'advanced') {
    if (activePanelSessionId) {
      // `SessionPanelView` calls the file explorer 'explorer'; its 'files'
      // member is the git-changes diff view. The quick-view vocabulary uses
      // 'files' for the explorer, so translate rather than pass through.
      useSessionBrowserStore
        .getState()
        .setView(activePanelSessionId, view === 'files' ? 'explorer' : view);
    }
    useKortixComputerStore.getState().openSidePanel();
  } else {
    useKortixComputerStore
      .getState()
      .requestQuickView(view, activePanelSessionId ?? undefined);
  }

  if (!wasOpen) track('panel_opened', { source });
}
