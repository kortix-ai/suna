'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useServerStore } from '@/stores/server-store';
import { getCurrentInstanceIdFromWindow, toInstanceAwarePath } from '@/lib/instance-routes';

// ============================================================================
// Types
// ============================================================================

export type TabType = 'session' | 'file' | 'dashboard' | 'settings' | 'project' | 'page' | 'preview' | 'terminal' | 'services' | 'browser' | 'desktop';

/** The permanent dashboard/home tab. Always pinned, always first. */
export const DASHBOARD_TAB_ID = 'page:/dashboard';

/** Maximum number of recently closed tabs to remember for CMD+Shift+T */
const MAX_RECENTLY_CLOSED = 20;

/** Maximum depth for tab focus history (VS Code-like back-navigation) */
const MAX_FOCUS_HISTORY = 50;
export const DASHBOARD_TAB: Omit<Tab, 'openedAt'> & { openedAt: number } = {
  id: DASHBOARD_TAB_ID,
  title: '',
  type: 'dashboard',
  href: '/dashboard',
  pinned: true,
  openedAt: 0,
};

/**
 * Push the current active tab onto the focus history stack.
 * Deduplicates consecutive entries and caps at MAX_FOCUS_HISTORY.
 */
function pushFocusHistory(history: string[], tabId: string): string[] {
  // Don't push duplicates at the top of the stack
  if (history[0] === tabId) return history;
  return [tabId, ...history].slice(0, MAX_FOCUS_HISTORY);
}

/**
 * Remove all occurrences of given tab IDs from focus history.
 */
function cleanFocusHistory(history: string[], removedIds: Set<string>): string[] {
  return history.filter((id) => !removedIds.has(id));
}

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
  /** The server instance this tab belongs to (session/file tabs are scoped per instance) */
  serverId?: string;
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
  /** Stack of recently closed tabs (most recent first) for Mod+Shift+T reopen */
  recentlyClosedTabs: Tab[];
  /** Focus history stack — most recently focused tab IDs first (VS Code-like back-navigation) */
  tabFocusHistory: string[];

  // --- Actions ---

  /** Open a new tab (or activate it if it already exists) */
  openTab: (tab: Omit<Tab, 'openedAt'>) => void;

  /** Close a tab by ID. Returns the next tab to activate (or null). */
  closeTab: (tabId: string) => string | null;

  /** Reopen the most recently closed tab. Returns the reopened tab or null. */
  reopenLastClosedTab: () => Tab | null;

  /** Set the active tab */
  setActiveTab: (tabId: string) => void;

  /** Update a tab's title */
  updateTabTitle: (tabId: string, title: string) => void;

  /** Mark a tab dirty/clean */
  setTabDirty: (tabId: string, dirty: boolean) => void;

  /** Pin/unpin a tab */
  pinTab: (tabId: string, pinned: boolean) => void;

  /** Reorder tabs (move tabId to newIndex) */
  moveTab: (tabId: string, newIndex: number) => void;

  /** Close all tabs except the given one */
  closeOtherTabs: (tabId: string) => void;

  /** Close tabs to the right of the given tab */
  closeTabsToRight: (tabId: string) => void;

  /** Close all unpinned tabs */
  closeAllTabs: () => void;

  /** Get ordered tab objects */
  getOrderedTabs: () => Tab[];

  /** Save current server-scoped tabs and restore tabs for a different server */
  swapForServer: (newServerId: string, currentServerId?: string) => void;
}

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      tabs: {},
      tabOrder: [],
      activeTabId: null,
      recentlyClosedTabs: [],
      tabFocusHistory: [],

      openTab: (tabInput) => {
        const { tabs, tabOrder, activeTabId, tabFocusHistory } = get();

        // Record current active tab in focus history before switching
        const newHistory = activeTabId && activeTabId !== tabInput.id
          ? pushFocusHistory(tabFocusHistory, activeTabId)
          : tabFocusHistory;

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
            tabFocusHistory: newHistory,
          });
          return;
        }

        const newTab: Tab = {
          ...tabInput,
          openedAt: Date.now(),
        };

        const updated = ensureDashboardTab(
          { ...tabs, [newTab.id]: newTab },
          [...tabOrder, newTab.id],
        );

        set({
          ...updated,
          activeTabId: newTab.id,
          tabFocusHistory: newHistory,
        });
      },

      closeTab: (tabId) => {
        const { tabs, tabOrder, activeTabId, recentlyClosedTabs, tabFocusHistory } = get();
        const tab = tabs[tabId];
        // Prevent closing dashboard tab or any pinned tab
        if (!tab || tab.pinned || tabId === DASHBOARD_TAB_ID) return activeTabId;

        // Push closed tab onto recently-closed stack
        const updatedClosedTabs = [tab, ...recentlyClosedTabs].slice(0, MAX_RECENTLY_CLOSED);

        const { [tabId]: _, ...remainingTabs } = tabs;
        const newOrder = tabOrder.filter((id) => id !== tabId);

        // Remove the closed tab from focus history
        const closedSet = new Set([tabId]);
        let newFocusHistory = cleanFocusHistory(tabFocusHistory, closedSet);

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
          recentlyClosedTabs: updatedClosedTabs,
          tabFocusHistory: newFocusHistory,
        });

        return nextActiveId;
      },

      reopenLastClosedTab: () => {
        const { recentlyClosedTabs, tabs, tabOrder } = get();
        if (recentlyClosedTabs.length === 0) return null;

        const [tabToReopen, ...remaining] = recentlyClosedTabs;

        // If a tab with the same ID already exists, just activate it
        if (tabs[tabToReopen.id]) {
          set({ activeTabId: tabToReopen.id, recentlyClosedTabs: remaining });
          return tabToReopen;
        }

        const updated = ensureDashboardTab(
          { ...tabs, [tabToReopen.id]: tabToReopen },
          [...tabOrder, tabToReopen.id],
        );

        set({
          ...updated,
          activeTabId: tabToReopen.id,
          recentlyClosedTabs: remaining,
        });

        return tabToReopen;
      },

      setActiveTab: (tabId) => {
        const { tabs, activeTabId, tabFocusHistory } = get();
        if (!tabs[tabId]) return;
        const newHistory = activeTabId && activeTabId !== tabId
          ? pushFocusHistory(tabFocusHistory, activeTabId)
          : tabFocusHistory;
        set({ activeTabId: tabId, tabFocusHistory: newHistory });
      },

      updateTabTitle: (tabId, title) => {
        const { tabs } = get();
        if (!tabs[tabId]) return;
        set({
          tabs: { ...tabs, [tabId]: { ...tabs[tabId], title } },
        });
      },

      setTabDirty: (tabId, dirty) => {
        const { tabs } = get();
        if (!tabs[tabId]) return;
        set({
          tabs: { ...tabs, [tabId]: { ...tabs[tabId], dirty } },
        });
      },

      pinTab: (tabId, pinned) => {
        const { tabs, tabOrder } = get();
        if (!tabs[tabId]) return;
        const updatedTabs = { ...tabs, [tabId]: { ...tabs[tabId], pinned } };

        // Reorder: pinned tabs at the beginning
        const pinnedIds = tabOrder.filter((id) => updatedTabs[id]?.pinned);
        const unpinnedIds = tabOrder.filter((id) => !updatedTabs[id]?.pinned);

        set({
          tabs: updatedTabs,
          tabOrder: [...pinnedIds, ...unpinnedIds],
        });
      },

      moveTab: (tabId, newIndex) => {
        const { tabOrder } = get();
        const currentIndex = tabOrder.indexOf(tabId);
        if (currentIndex === -1) return;
        const newOrder = [...tabOrder];
        newOrder.splice(currentIndex, 1);
        newOrder.splice(newIndex, 0, tabId);
        set({ tabOrder: newOrder });
      },

      closeOtherTabs: (tabId) => {
        const { tabs, tabFocusHistory } = get();
        const remainingTabs: Record<string, Tab> = {};
        const newOrder: string[] = [];
        const removedIds = new Set<string>();

        // Keep the target tab, all pinned tabs, and always the dashboard
        for (const id of get().tabOrder) {
          if (id === tabId || tabs[id]?.pinned || id === DASHBOARD_TAB_ID) {
            remainingTabs[id] = tabs[id];
            newOrder.push(id);
          } else {
            removedIds.add(id);
          }
        }

        const ensured = ensureDashboardTab(remainingTabs, newOrder);
        set({
          ...ensured,
          activeTabId: tabId,
          tabFocusHistory: cleanFocusHistory(tabFocusHistory, removedIds),
        });
      },

      closeTabsToRight: (tabId) => {
        const { tabs, tabOrder, activeTabId, tabFocusHistory } = get();
        const index = tabOrder.indexOf(tabId);
        if (index === -1) return;

        const remainingSet = new Set<string>();
        const newOrder = tabOrder.filter(
          (id, i) => {
            const keep = i <= index || tabs[id]?.pinned || id === DASHBOARD_TAB_ID;
            if (keep) remainingSet.add(id);
            return keep;
          }
        );
        const remainingTabs: Record<string, Tab> = {};
        for (const id of newOrder) {
          remainingTabs[id] = tabs[id];
        }

        const removedIds = new Set(tabOrder.filter((id) => !remainingSet.has(id)));
        const ensured = ensureDashboardTab(remainingTabs, newOrder);
        set({
          ...ensured,
          activeTabId: remainingTabs[activeTabId!] ? activeTabId : tabId,
          tabFocusHistory: cleanFocusHistory(tabFocusHistory, removedIds),
        });
      },

      closeAllTabs: () => {
        const { tabs, tabOrder } = get();
        const remainingTabs: Record<string, Tab> = {};
        const newOrder: string[] = [];
        const removedIds = new Set<string>();

        for (const id of tabOrder) {
          if (tabs[id]?.pinned || id === DASHBOARD_TAB_ID) {
            remainingTabs[id] = tabs[id];
            newOrder.push(id);
          } else {
            removedIds.add(id);
          }
        }

        const ensured = ensureDashboardTab(remainingTabs, newOrder);
        set({
          ...ensured,
          activeTabId: ensured.tabOrder[0] || null,
          tabFocusHistory: [],  // All non-pinned tabs are gone, clear history
        });
      },

      getOrderedTabs: () => {
        const { tabs, tabOrder } = get();
        return tabOrder.map((id) => tabs[id]).filter(Boolean);
      },

      swapForServer: (newServerId: string, currentServerId?: string) => {
        const { tabs, tabOrder, activeTabId, tabFocusHistory } = get();

        // Save the entire current tab state for the old server
        if (currentServerId) {
          try {
            const cache = JSON.parse(localStorage.getItem('kortix-tabs-per-server') || '{}');
            cache[currentServerId] = { tabs, tabOrder, activeTabId, tabFocusHistory };
            localStorage.setItem('kortix-tabs-per-server', JSON.stringify(cache));
          } catch {}
        }

        // Restore the full tab state for the new server
        try {
          const cache = JSON.parse(localStorage.getItem('kortix-tabs-per-server') || '{}');
          const saved = cache[newServerId];
          if (saved?.tabs && saved?.tabOrder) {
            const ensured = ensureDashboardTab(saved.tabs, saved.tabOrder);
            set({
              ...ensured,
              activeTabId: saved.activeTabId || DASHBOARD_TAB_ID,
              tabFocusHistory: saved.tabFocusHistory || [],
            });
            return;
          }
        } catch {}

        // No saved state for new server — start with just the dashboard tab
        const ensured = ensureDashboardTab({}, []);
        set({ ...ensured, activeTabId: DASHBOARD_TAB_ID, tabFocusHistory: [] });
      },
    }),
    {
      name: 'kortix-tabs',
      partialize: (state) => ({
        tabs: state.tabs,
        tabOrder: state.tabOrder,
        activeTabId: state.activeTabId,
        recentlyClosedTabs: state.recentlyClosedTabs,
        tabFocusHistory: state.tabFocusHistory,
      }),
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
          // Initialize focus history for existing users upgrading
          if (!state.tabFocusHistory) {
            state.tabFocusHistory = [];
          }
        }
      },
    }
  )
);

// ============================================================================
// Utility: open + navigate in one shot
// ============================================================================

/** Tab types rendered via pre-mounted CSS show/hide (use pushState, not router). */
const PRE_MOUNTED_TAB_TYPES: ReadonlySet<TabType> = new Set(['session', 'file', 'preview', 'terminal', 'settings', 'page', 'project', 'dashboard', 'services', 'browser', 'desktop']);

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

// ============================================================================
// Keep per-server tab cache in sync
// ============================================================================
// Whenever the tab state changes, persist it to the per-server cache for the
// currently active server. This ensures the cache is always up-to-date — not
// just when explicitly switching servers via swapForServer(). Without this,
// tabs opened/closed after the last swap would be lost on page reload.

let _syncTimer: ReturnType<typeof setTimeout> | undefined;

useTabStore.subscribe((state) => {
  // Debounce to avoid excessive writes on rapid tab changes
  clearTimeout(_syncTimer);
  _syncTimer = setTimeout(() => {
    try {
      const serverId = useServerStore.getState().activeServerId;
      if (!serverId) return;

      const cache = JSON.parse(localStorage.getItem('kortix-tabs-per-server') || '{}');
      cache[serverId] = {
        tabs: state.tabs,
        tabOrder: state.tabOrder,
        activeTabId: state.activeTabId,
        tabFocusHistory: state.tabFocusHistory,
      };
      localStorage.setItem('kortix-tabs-per-server', JSON.stringify(cache));
    } catch {}
  }, 500);
});
