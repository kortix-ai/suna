/**
 * Utility to extract the current active session context for enriching preview tabs.
 * 
 * When a preview tab is opened from within a session (e.g., a localhost link in chat),
 * we want to tag it with the source session ID and title so the Running Services panel
 * can display "Slide 1 - Session Name" associations.
 */

import { useTabStore } from '@/stores/tab-store';

interface SessionContext {
  sourceSessionId: string;
  sourceSessionTitle: string;
}

/**
 * Get the current active session context from the tab store.
 * Returns null if the active tab is not a session tab.
 * 
 * Call this at the moment a preview tab is being opened to capture
 * which session triggered it.
 */
export function getActiveSessionContext(): SessionContext | null {
  const state = useTabStore.getState();
  const activeTabId = state.activeTabId;
  if (!activeTabId) return null;

  const activeTab = state.tabs[activeTabId];
  if (!activeTab || activeTab.type !== 'session') return null;

  return {
    sourceSessionId: activeTab.id,
    sourceSessionTitle: activeTab.title || 'Untitled',
  };
}

/**
 * Build metadata for a preview tab, enriched with session context if available.
 * Merges the session context into the provided metadata object.
 */
export function enrichPreviewMetadata(
  metadata: Record<string, unknown>,
): Record<string, unknown> {
  const ctx = getActiveSessionContext();
  if (!ctx) return metadata;

  return {
    ...metadata,
    sourceSessionId: ctx.sourceSessionId,
    sourceSessionTitle: ctx.sourceSessionTitle,
  };
}
