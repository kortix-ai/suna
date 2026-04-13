/**
 * Tab store — persists open tabs and navigation history across app restarts.
 *
 * Supports two tab types:
 * - Session tabs (chat sessions identified by session ID)
 * - Page tabs (utility pages like Files, Terminal, Memory, etc.)
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';

// ---------------------------------------------------------------------------
// Page tab definitions
// ---------------------------------------------------------------------------

export interface PageTab {
  id: string;       // e.g. "page:files"
  label: string;    // e.g. "Files"
  icon: string;     // Ionicons name
}

/** All known page tabs */
export const PAGE_TABS: Record<string, PageTab> = {
  'page:files':             { id: 'page:files',             label: 'Files',             icon: 'folder-open-outline' },
  'page:terminal':          { id: 'page:terminal',          label: 'Terminal',          icon: 'terminal-outline' },
  'page:memory':            { id: 'page:memory',            label: 'Memory',            icon: 'hardware-chip-outline' },
  'page:marketplace':       { id: 'page:marketplace',       label: 'Marketplace',       icon: 'sparkles-outline' },
  'page:workspace':         { id: 'page:workspace',         label: 'Workspace',         icon: 'grid-outline' },
  'page:secrets':           { id: 'page:secrets',           label: 'Secrets Manager',   icon: 'key-outline' },
  'page:llm-providers':     { id: 'page:llm-providers',     label: 'LLM Providers',     icon: 'cube-outline' },
  'page:ssh':               { id: 'page:ssh',               label: 'SSH',               icon: 'link-outline' },
  'page:api':               { id: 'page:api',               label: 'API',               icon: 'code-slash-outline' },
  'page:triggers':          { id: 'page:triggers',          label: 'Triggers',          icon: 'calendar-outline' },
  'page:channels':          { id: 'page:channels',          label: 'Channels',          icon: 'chatbox-outline' },
  'page:tunnel':            { id: 'page:tunnel',            label: 'Tunnel',            icon: 'swap-horizontal-outline' },
  'page:integrations':      { id: 'page:integrations',      label: 'Integrations',      icon: 'git-branch-outline' },
  'page:running-services':  { id: 'page:running-services',  label: 'Service Manager',  icon: 'pulse-outline' },
  'page:browser':           { id: 'page:browser',           label: 'Browser',           icon: 'compass-outline' },
  'page:agent-browser':     { id: 'page:agent-browser',     label: 'Agent Browser',     icon: 'globe-outline' },
  'page:updates':           { id: 'page:updates',           label: 'Updates',           icon: 'arrow-down-circle-outline' },
  'page:projects':          { id: 'page:projects',          label: 'Projects',          icon: 'folder-outline' },
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface TabState {
  /** Currently active session/tab ID (null = dashboard or page tab) */
  activeSessionId: string | null;
  /** Currently active page tab ID (null = session or dashboard) */
  activePageId: string | null;
  /** List of open tab IDs (session IDs) */
  openTabIds: string[];
  /** List of open page tab IDs */
  openPageIds: string[];
  /** Combined open tabs (sessions + pages) ordered by when they were opened */
  openTabOrder: string[];
  /** Navigation history (session IDs, page IDs, and __dashboard__) */
  sessionHistory: string[];
  /** Current position in history */
  historyIndex: number;
  /** Whether the tabs overview grid is shown (not persisted) */
  showTabsOverview: boolean;
  /** Per-tab ephemeral UI state (scroll positions, view state, etc.) */
  tabStateById: Record<string, Record<string, unknown>>;

  navigateToSession: (sessionId: string | null) => void;
  navigateToPage: (pageId: string) => void;
  closeTab: (tabId: string) => void;
  closeAllTabs: () => void;
  goBack: () => void;
  goForward: () => void;
  setShowTabsOverview: (show: boolean) => void;
  setTabState: (tabId: string, patch: Record<string, unknown>) => void;
  clearTabState: (tabId: string) => void;
}

export const useTabStore = create<TabState>()(
  persist(
    (set, get) => ({
      activeSessionId: null,
      activePageId: null,
      openTabIds: [],
      openPageIds: [],
      openTabOrder: [],
      sessionHistory: [],
      historyIndex: -1,
      showTabsOverview: false,
      tabStateById: {},

      navigateToSession: (sessionId) => {
        set((state) => {
          const entry = sessionId ?? '__dashboard__';
          const currentEntry =
            state.historyIndex >= 0 ? state.sessionHistory[state.historyIndex] : undefined;

          const nextHistory = currentEntry === entry
            ? state.sessionHistory
            : [...state.sessionHistory.slice(0, state.historyIndex + 1), entry];
          const nextIndex = currentEntry === entry
            ? state.historyIndex
            : nextHistory.length - 1;

          if (!sessionId) {
            return {
              activeSessionId: null,
              activePageId: null,
              showTabsOverview: false,
              sessionHistory: nextHistory,
              historyIndex: nextIndex,
            };
          }

          const newOpenTabIds = state.openTabIds.includes(sessionId)
            ? state.openTabIds
            : [...state.openTabIds, sessionId];
          const newOpenTabOrder = state.openTabOrder.includes(sessionId)
            ? state.openTabOrder
            : [...state.openTabOrder, sessionId];

          return {
            activeSessionId: sessionId,
            activePageId: null,
            showTabsOverview: false,
            openTabIds: newOpenTabIds,
            openTabOrder: newOpenTabOrder,
            sessionHistory: nextHistory,
            historyIndex: nextIndex,
          };
        });
      },

      navigateToPage: (pageId) => {
        set((state) => {
          const newOpenPageIds = state.openPageIds.includes(pageId)
            ? state.openPageIds
            : [...state.openPageIds, pageId];
          const newOpenTabOrder = state.openTabOrder.includes(pageId)
            ? state.openTabOrder
            : [...state.openTabOrder, pageId];

          const currentEntry =
            state.historyIndex >= 0 ? state.sessionHistory[state.historyIndex] : undefined;
          const nextHistory = currentEntry === pageId
            ? state.sessionHistory
            : [...state.sessionHistory.slice(0, state.historyIndex + 1), pageId];
          const nextIndex = currentEntry === pageId
            ? state.historyIndex
            : nextHistory.length - 1;

          return {
            activeSessionId: null,
            activePageId: pageId,
            showTabsOverview: false,
            openPageIds: newOpenPageIds,
            openTabOrder: newOpenTabOrder,
            sessionHistory: nextHistory,
            historyIndex: nextIndex,
          };
        });
      },

      closeTab: (tabId) => {
        set((state) => {
          const nextOpenTabOrder = state.openTabOrder.filter((id) => id !== tabId);
          const { [tabId]: _removed, ...nextTabStateById } = state.tabStateById;
          // Page tab
          if (tabId.startsWith('page:')) {
            return {
              openPageIds: state.openPageIds.filter((id) => id !== tabId),
              activePageId: state.activePageId === tabId ? null : state.activePageId,
              openTabOrder: nextOpenTabOrder,
              tabStateById: nextTabStateById,
            };
          }
          // Session tab
          return {
            openTabIds: state.openTabIds.filter((id) => id !== tabId),
            activeSessionId:
              state.activeSessionId === tabId ? null : state.activeSessionId,
            openTabOrder: nextOpenTabOrder,
            tabStateById: nextTabStateById,
          };
        });
      },

      closeAllTabs: () => {
        set({
          openTabIds: [],
          openPageIds: [],
          activeSessionId: null,
          activePageId: null,
          openTabOrder: [],
          tabStateById: {},
        });
      },

      goBack: () => {
        const { historyIndex, sessionHistory } = get();
        if (historyIndex <= 0) return;
        const newIndex = historyIndex - 1;
        const entry = sessionHistory[newIndex];

        if (entry === '__dashboard__') {
          set({
            historyIndex: newIndex,
            activeSessionId: null,
            activePageId: null,
          });
          return;
        }

        if (entry?.startsWith('page:')) {
          const { openPageIds, openTabOrder } = get();
          const nextOpenPageIds = openPageIds.includes(entry)
            ? openPageIds
            : [...openPageIds, entry];
          const nextOpenTabOrder = openTabOrder.includes(entry)
            ? openTabOrder
            : [...openTabOrder, entry];
          set({
            historyIndex: newIndex,
            activeSessionId: null,
            activePageId: entry,
            openPageIds: nextOpenPageIds,
            openTabOrder: nextOpenTabOrder,
          });
          return;
        }

        if (!entry) return;

        const { openTabIds, openTabOrder } = get();
        const nextOpenTabIds = openTabIds.includes(entry)
          ? openTabIds
          : [...openTabIds, entry];
        const nextOpenTabOrder = openTabOrder.includes(entry)
          ? openTabOrder
          : [...openTabOrder, entry];

        set({
          historyIndex: newIndex,
          activeSessionId: entry,
          activePageId: null,
          openTabIds: nextOpenTabIds,
          openTabOrder: nextOpenTabOrder,
        });
      },

      goForward: () => {
        const { historyIndex, sessionHistory } = get();
        if (historyIndex >= sessionHistory.length - 1) return;
        const newIndex = historyIndex + 1;
        const entry = sessionHistory[newIndex];

        if (entry === '__dashboard__') {
          set({
            historyIndex: newIndex,
            activeSessionId: null,
            activePageId: null,
          });
          return;
        }

        if (entry?.startsWith('page:')) {
          const { openPageIds, openTabOrder } = get();
          const nextOpenPageIds = openPageIds.includes(entry)
            ? openPageIds
            : [...openPageIds, entry];
          const nextOpenTabOrder = openTabOrder.includes(entry)
            ? openTabOrder
            : [...openTabOrder, entry];
          set({
            historyIndex: newIndex,
            activeSessionId: null,
            activePageId: entry,
            openPageIds: nextOpenPageIds,
            openTabOrder: nextOpenTabOrder,
          });
          return;
        }

        if (!entry) return;

        const { openTabIds, openTabOrder } = get();
        const nextOpenTabIds = openTabIds.includes(entry)
          ? openTabIds
          : [...openTabIds, entry];
        const nextOpenTabOrder = openTabOrder.includes(entry)
          ? openTabOrder
          : [...openTabOrder, entry];

        set({
          historyIndex: newIndex,
          activeSessionId: entry,
          activePageId: null,
          openTabIds: nextOpenTabIds,
          openTabOrder: nextOpenTabOrder,
        });
      },

      setShowTabsOverview: (show) => {
        set({ showTabsOverview: show });
      },

      setTabState: (tabId, patch) => {
        set((state) => ({
          tabStateById: {
            ...state.tabStateById,
            [tabId]: {
              ...(state.tabStateById[tabId] || {}),
              ...patch,
            },
          },
        }));
      },

      clearTabState: (tabId) => {
        set((state) => {
          const { [tabId]: _removed, ...rest } = state.tabStateById;
          return { tabStateById: rest };
        });
      },
    }),
    {
      name: 'kortix-tab-state',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (state) => ({
        activeSessionId: state.activeSessionId,
        activePageId: state.activePageId,
        openTabIds: state.openTabIds,
        openPageIds: state.openPageIds,
        openTabOrder: state.openTabOrder,
        sessionHistory: state.sessionHistory,
        historyIndex: state.historyIndex,
        tabStateById: state.tabStateById,
      }),
      // Guard rehydration against corrupted AsyncStorage data.
      // If any persisted field is missing or the wrong type, reset it to a safe default
      // to prevent ".filter is not a function" / "Cannot read properties of undefined" crashes.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        state.openTabIds = Array.isArray(state.openTabIds) ? state.openTabIds : [];
        state.openPageIds = Array.isArray(state.openPageIds) ? state.openPageIds : [];
        state.openTabOrder = Array.isArray(state.openTabOrder) ? state.openTabOrder : [];
        state.sessionHistory = Array.isArray(state.sessionHistory) ? state.sessionHistory : [];
        state.historyIndex = typeof state.historyIndex === 'number' ? state.historyIndex : -1;
        state.tabStateById = state.tabStateById && typeof state.tabStateById === 'object'
          ? state.tabStateById
          : {};
        if (state.activeSessionId !== null && typeof state.activeSessionId !== 'string') {
          state.activeSessionId = null;
        }
        if (state.activePageId !== null && typeof state.activePageId !== 'string') {
          state.activePageId = null;
        }
      },
    },
  ),
);
