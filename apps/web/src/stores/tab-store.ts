'use client';

import { safeLocalStorage } from '@/lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from '@/stores/persisted-store-registry';
import { getCurrentInstanceIdFromWindow, toInstanceAwarePath } from '@kortix/sdk';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

// ============================================================================
// Types
// ============================================================================

export type TabType =
  | 'session'
  | 'file'
  | 'dashboard'
  | 'settings'
  | 'project'
  | 'page'
  | 'preview'
  | 'terminal'
  | 'services'
  | 'browser'
  | 'desktop';

/** The permanent dashboard/home tab. Always pinned, always first. */
export const DASHBOARD_TAB_ID = 'page:/dashboard';

export const DASHBOARD_TAB: Omit<Tab, 'openedAt'> & { openedAt: number } = {
  id: DASHBOARD_TAB_ID,
  title: '',
  type: 'dashboard',
  href: '/dashboard',
  pinned: true,
  openedAt: 0,
};

/** Ensures the dashboard tab exists at position 0 in the given state. */
function ensureDashboardTab(
  tabs: Record<string, Tab>,
  tabOrder: string[],
): { tabs: Record<string, Tab>; tabOrder: string[] } {
  const newTabs = { ...tabs };
  if (!newTabs[DASHBOARD_TAB_ID]) {
    newTabs[DASHBOARD_TAB_ID] = { ...DASHBOARD_TAB };
  } else {
    newTabs[DASHBOARD_TAB_ID] = { ...newTabs[DASHBOARD_TAB_ID], pinned: true, title: '' };
  }
  const orderWithout = tabOrder.filter((id) => id !== DASHBOARD_TAB_ID);
  return { tabs: newTabs, tabOrder: [DASHBOARD_TAB_ID, ...orderWithout] };
}

export interface Tab {
  /** Unique identifier — for sessions this is the sessionId, for files the file path, etc. */
  id: string;
  /** Display label shown on the tab */
  title: string;
  /** What kind of tab this is — determines icon and routing */
  type: TabType;
  /** The route path this tab maps to (e.g. /sessions/abc, /files, /dashboard) */
  href: string;
  /** Whether the tab has been modified / needs attention (unsaved, pending permissions, etc.) */
  dirty?: boolean;
  /** Whether the tab is pinned (pinned tabs stay at the left, can't be closed) */
  pinned?: boolean;
  /** Timestamp when the tab was opened — used for ordering */
  openedAt: number;
  /** For sub-session tabs: the parent session ID (enables back-to-parent navigation) */
  parentSessionId?: string;
  /** Extra data for specialized tab types (e.g. preview URL, port number) */
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Store
// ============================================================================

interface TabState {
  /** All open tabs keyed by tab.id for O(1) lookup */
  tabs: Record<string, Tab>;
  /** Ordered list of tab IDs (determines visual order) */
  tabOrder: string[];
  /** The currently active/focused tab ID */
  activeTabId: string | null;

  // --- Actions ---

  /** Open a new tab (or activate it if it already exists) */
  openTab: (tab: Omit<Tab, 'openedAt'>) => void;

  /** Close a tab by ID. Returns the next tab to activate (or null). */
  closeTab: (tabId: string) => string | null;

  /** Set the active tab */
  setActiveTab: (tabId: string) => void;
}

// ============================================================================
// Resilient localStorage — tab state must never crash the app on quota limits
// ============================================================================

const safeTabStorage = safeLocalStorage;

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      tabs: {},
      tabOrder: [],
      activeTabId: null,

      openTab: (tabInput) => {
        const { tabs, tabOrder } = get();

        // If tab already exists, update its metadata (URL may have changed) and activate it.
        // Important: do NOT force-refresh preview tabs here. Re-opening or
        // re-activating an existing preview tab should keep the iframe alive
        // unless the preview component itself explicitly refreshes.
        if (tabs[tabInput.id]) {
          const existing = tabs[tabInput.id];
          const merged: Tab = {
            ...existing,
            ...tabInput,
            openedAt: existing.openedAt,
            metadata: { ...existing.metadata, ...tabInput.metadata },
          };
          set({
            tabs: { ...tabs, [tabInput.id]: merged },
            activeTabId: tabInput.id,
          });
          return;
        }

        const newTab: Tab = {
          ...tabInput,
          openedAt: Date.now(),
        };

        const updated = ensureDashboardTab({ ...tabs, [newTab.id]: newTab }, [
          ...tabOrder,
          newTab.id,
        ]);

        set({
          ...updated,
          activeTabId: newTab.id,
        });
      },

      closeTab: (tabId) => {
        const { tabs, tabOrder, activeTabId } = get();
        const tab = tabs[tabId];
        // Prevent closing dashboard tab or any pinned tab
        if (!tab || tab.pinned || tabId === DASHBOARD_TAB_ID) return activeTabId;

        const { [tabId]: _, ...remainingTabs } = tabs;
        const newOrder = tabOrder.filter((id) => id !== tabId);

        // Determine next active tab
        let nextActiveId: string | null = null;
        if (activeTabId === tabId) {
          // For sub-session tabs: prefer activating the parent session tab
          if (tab.parentSessionId && remainingTabs[tab.parentSessionId]) {
            nextActiveId = tab.parentSessionId;
          } else {
            // Browser-style (Chrome/Firefox): activate positional neighbor
            // 1. Prefer the tab to the RIGHT of the closed tab
            // 2. If closed tab was rightmost, activate the one to the LEFT
            const oldIndex = tabOrder.indexOf(tabId);
            if (newOrder.length > 0) {
              if (oldIndex < newOrder.length) {
                // There's a tab at the same index (i.e. the one that was to the right)
                nextActiveId = newOrder[oldIndex];
              } else {
                // Closed tab was rightmost — activate the new last tab
                nextActiveId = newOrder[newOrder.length - 1];
              }
            }
          }
        } else {
          nextActiveId = activeTabId;
        }

        set({
          tabs: remainingTabs,
          tabOrder: newOrder,
          activeTabId: nextActiveId,
        });

        return nextActiveId;
      },

      setActiveTab: (tabId) => {
        const { tabs } = get();
        if (!tabs[tabId]) return;
        set({ activeTabId: tabId });
      },
    }),
    {
      name: 'kortix-tabs',
      // Never let a full quota crash the app — the storage wrapper evicts the
      // disposable per-server cache and retries instead of throwing.
      storage: createJSONStorage(() => safeTabStorage),
      partialize: (state) => ({
        tabs: state.tabs,
        tabOrder: state.tabOrder,
        activeTabId: state.activeTabId,
      }),
      merge: (persisted, current) => {
        const p = (persisted as Partial<TabState>) || {};
        return {
          ...current,
          ...p,
          tabs: p.tabs && typeof p.tabs === 'object' ? p.tabs : current.tabs,
          tabOrder: Array.isArray(p.tabOrder) ? p.tabOrder : current.tabOrder,
        };
      },
      // On rehydration, ensure dashboard tab is always present
      onRehydrateStorage: () => (state) => {
        if (state) {
          const tabs = state.tabs && typeof state.tabs === 'object' ? state.tabs : {};
          const tabOrder = Array.isArray(state.tabOrder) ? state.tabOrder : [];
          const ensured = ensureDashboardTab(tabs, tabOrder);
          state.tabs = ensured.tabs;
          state.tabOrder = ensured.tabOrder;
          if (!state.activeTabId) {
            state.activeTabId = DASHBOARD_TAB_ID;
          }
        }
      },
    },
  ),
);

// Registers this store for `resetClientState()`'s sign-out sweep without
// `reset-client-state.ts` importing this file — see `persisted-store-registry.ts`.
registerPersistedStore('kortix-tabs', () => resetPersistedStore(useTabStore));

// ============================================================================
// Utility: open + navigate in one shot
// ============================================================================

/** Tab types rendered via pre-mounted CSS show/hide (use pushState, not router). */
const PRE_MOUNTED_TAB_TYPES: ReadonlySet<TabType> = new Set([
  'session',
  'file',
  'preview',
  'terminal',
  'settings',
  'page',
  'project',
  'dashboard',
  'services',
  'browser',
  'desktop',
]);

/**
 * Open (or activate) a tab AND navigate the browser to it.
 *
 * Pre-mounted types (session, file, preview, terminal) use `history.pushState`
 * so the component stays mounted. Other types require a Next.js `router` for
 * full page navigation.
 *
 * Prefer this over calling `openTab()` + manual `pushState`/`router.push`
 * separately — it guarantees the newly opened tab is always visible.
 */
export function openTabAndNavigate(
  tabInput: Omit<Tab, 'openedAt'>,
  router?: { push: (url: string) => void },
) {
  useTabStore.getState().openTab(tabInput);
  if (typeof window === 'undefined') return;
  const href = toInstanceAwarePath(tabInput.href, getCurrentInstanceIdFromWindow());
  if (PRE_MOUNTED_TAB_TYPES.has(tabInput.type)) {
    window.history.pushState(null, '', href);
  } else if (router) {
    router.push(href);
  }
}
