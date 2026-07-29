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
import {
  type QuickView,
  type QuickViewTarget,
  useKortixComputerStore,
} from '@/stores/kortix-computer-store';
import { getActivePanelSessionId, useSessionBrowserStore } from '@/stores/session-browser-store';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';

export function openSessionQuickView(
  view: QuickView,
  source: 'palette' | 'header' | 'chat' | 'preview' | 'chip',
  /** Aims the request — which URL the browser should land on, or that Files
   *  should open on its Changes diff. Callers that know the destination pass
   *  it here instead of writing `viewBySession`, which only Advanced reads. */
  target?: QuickViewTarget,
): void {
  const wasOpen = useKortixComputerStore.getState().isSidePanelOpen;
  const panelMode = useUserPreferencesStore.getState().preferences.panelMode ?? 'easy';

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
      // 'files' for the explorer, so translate rather than pass through —
      // and a Changes-targeted request lands on that 'files' diff value.
      const panelView = view === 'files' ? (target?.changes ? 'files' : 'explorer') : view;
      useSessionBrowserStore.getState().setView(activePanelSessionId, panelView);
    }
    useKortixComputerStore.getState().openSidePanel();
  } else {
    useKortixComputerStore
      .getState()
      .requestQuickView(view, activePanelSessionId ?? undefined, target);
  }

  if (!wasOpen) track('panel_opened', { source });
}
