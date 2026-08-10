'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type {
  SessionSourceFilter,
  SessionStatusFilter,
} from '@/components/workspaces/session-label';
import {
  DEFAULT_SESSION_GROUP_MODE,
  type SessionGroupMode,
  type SessionOrderMode,
} from '@/features/workspace/workspace-sidebar/session-grouping';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

/**
 * Per-workspace session-list VIEW state — grouping, ordering, the two filter
 * facets, and section visibility/collapse.
 *
 * Held in a module-level, persisted store so the chosen view survives the
 * workspace shell remounting on navigation — opening a session, ⌘J, switching
 * sessions. Local component state used to reset back to defaults on every
 * such remount.
 */

const STORAGE_KEY = 'kortix.workspace-session-view';

/**
 * The fallback every list-valued selector must use — never a bare `[]`.
 *
 * zustand v5 reads through `useSyncExternalStore`, which compares snapshots
 * with `Object.is`. A selector written `s.statusFiltersByWorkspace[id] ?? []`
 * allocates a NEW array on every read, so the snapshot never equals the
 * previous one and React re-renders forever ("Maximum update depth exceeded").
 * One frozen module-level reference makes the comparison stable.
 *
 * `readonly never[]` is assignable to any `readonly T[]`, so a single constant
 * serves every list in this store.
 */
export const EMPTY_LIST: readonly never[] = Object.freeze([]);

/**
 * The two surfaces that render a session list. They share this store's SHAPE
 * and its menu, but not their state: narrowing the full sessions page must not
 * silently narrow the sidebar you navigate with.
 *
 * The sidebar keeps the bare `workspaceId` as its key, so every value persisted
 * before surfaces existed keeps working and keeps belonging to the sidebar.
 */
export type SessionViewSurface = 'sidebar' | 'page';

function scopeKey(workspaceId: string, surface: SessionViewSurface): string {
  return surface === 'sidebar' ? workspaceId : `${workspaceId}::${surface}`;
}

/**
 * Read a surface's value, INHERITING the sidebar's until this surface sets its
 * own.
 *
 * `??` and not `||`: a surface that has explicitly chosen "no filters" stores
 * an empty array, and that is a real answer, not an absent one. Only
 * `undefined` — never chosen here — falls through to the sidebar. So the page
 * opens showing exactly what the sidebar shows, and stops tracking it the
 * moment you change something on the page.
 */
function readScoped<V>(
  map: Record<string, V>,
  workspaceId: string,
  surface: SessionViewSurface,
  /** Set false for state that is per-surface scratch rather than a preference —
   *  see `selectCollapsedSections`. */
  inherit = true,
): V | undefined {
  const own = map[scopeKey(workspaceId, surface)];
  if (own !== undefined || surface === 'sidebar' || !inherit) return own;
  return map[workspaceId];
}

/** Soft cap so the per-workspace map can't grow unbounded; keeps the last N.
 *  Two surfaces per workspace, so this is ~24 workspaces, as it was before the
 *  page got its own scope. */
const MAX_TRACKED_SCOPES = 48;

function pruneWorkspaces<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_SCOPES) return map;
  return Object.fromEntries(keys.slice(-MAX_TRACKED_SCOPES).map((k) => [k, map[k]]));
}

function toggleValue<V>(list: readonly V[], value: V): V[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

interface State {
  groupByWorkspace: Record<string, SessionGroupMode>;
  orderByWorkspace: Record<string, SessionOrderMode>;
  statusFiltersByWorkspace: Record<string, SessionStatusFilter[]>;
  sourceFiltersByWorkspace: Record<string, SessionSourceFilter[]>;
  hiddenSectionsByWorkspace: Record<string, string[]>;
  collapsedSectionsByWorkspace: Record<string, string[]>;
}

/**
 * Every action takes the surface LAST and defaults it to `sidebar`, so the
 * sidebar's existing call sites are unchanged and only the page opts in.
 */
interface Actions {
  setGroupMode: (workspaceId: string, mode: SessionGroupMode, surface?: SessionViewSurface) => void;
  setOrderMode: (
    workspaceId: string,
    order: SessionOrderMode,
    surface?: SessionViewSurface,
  ) => void;
  toggleStatusFilter: (
    workspaceId: string,
    value: SessionStatusFilter,
    surface?: SessionViewSurface,
  ) => void;
  toggleSourceFilter: (
    workspaceId: string,
    value: SessionSourceFilter,
    surface?: SessionViewSurface,
  ) => void;
  resetFilters: (workspaceId: string, surface?: SessionViewSurface) => void;
  toggleSectionHidden: (
    workspaceId: string,
    sectionId: string,
    surface?: SessionViewSurface,
  ) => void;
  toggleSectionCollapsed: (
    workspaceId: string,
    sectionId: string,
    surface?: SessionViewSurface,
  ) => void;
  collapseAllSections: (
    workspaceId: string,
    sectionIds: readonly string[],
    surface?: SessionViewSurface,
  ) => void;
}

/**
 * Selectors. Components MUST read through these rather than indexing the maps,
 * or the page silently stops inheriting the sidebar's defaults.
 *
 * Each returns either a stored reference or the frozen `EMPTY_LIST`/a scalar —
 * never a fresh array — because zustand v5 compares snapshots with `Object.is`.
 */
export const selectGroupMode =
  (workspaceId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): SessionGroupMode =>
    readScoped(s.groupByWorkspace, workspaceId, surface) ?? DEFAULT_SESSION_GROUP_MODE;

export const selectOrderMode =
  (workspaceId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): SessionOrderMode =>
    readScoped(s.orderByWorkspace, workspaceId, surface) ?? 'activity';

export const selectStatusFilters =
  (workspaceId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): readonly SessionStatusFilter[] =>
    readScoped(s.statusFiltersByWorkspace, workspaceId, surface) ?? EMPTY_LIST;

export const selectSourceFilters =
  (workspaceId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): readonly SessionSourceFilter[] =>
    readScoped(s.sourceFiltersByWorkspace, workspaceId, surface) ?? EMPTY_LIST;

export const selectHiddenSections =
  (workspaceId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): readonly string[] =>
    readScoped(s.hiddenSectionsByWorkspace, workspaceId, surface) ?? EMPTY_LIST;

/**
 * The ONE piece of state a surface does not inherit: every section starts
 * expanded, and a fold only applies where it was made.
 *
 * Grouping, ordering and the filters are preferences — how you want sessions
 * organised — so the page adopting the sidebar's is right. Collapse is not a
 * preference, it is scratch: "I folded Older away in the narrow sidebar to see
 * past it." Inheriting that made the full sessions page open with its sections
 * already shut, which is the opposite of what a page you navigated to in order
 * to see everything should do.
 */
export const selectCollapsedSections =
  (workspaceId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): readonly string[] =>
    readScoped(s.collapsedSectionsByWorkspace, workspaceId, surface, false) ?? EMPTY_LIST;

export const useSessionFilterStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      // Every write below targets THIS surface's key, while the `readScoped`
      // reads still inherit the sidebar's value until that first write lands —
      // so a toggle on the page starts from what the page is showing, and ends
      // up owned by the page.
      groupByWorkspace: {},
      setGroupMode: (workspaceId, mode, surface = 'sidebar') => {
        if (
          (readScoped(get().groupByWorkspace, workspaceId, surface) ??
            DEFAULT_SESSION_GROUP_MODE) === mode
        ) {
          return;
        }
        set({
          groupByWorkspace: { ...get().groupByWorkspace, [scopeKey(workspaceId, surface)]: mode },
        });
      },

      orderByWorkspace: {},
      setOrderMode: (workspaceId, order, surface = 'sidebar') => {
        if ((readScoped(get().orderByWorkspace, workspaceId, surface) ?? 'activity') === order)
          return;
        set({
          orderByWorkspace: { ...get().orderByWorkspace, [scopeKey(workspaceId, surface)]: order },
        });
      },

      statusFiltersByWorkspace: {},
      toggleStatusFilter: (workspaceId, value, surface = 'sidebar') => {
        const current = readScoped(get().statusFiltersByWorkspace, workspaceId, surface) ?? [];
        set({
          statusFiltersByWorkspace: {
            ...get().statusFiltersByWorkspace,
            [scopeKey(workspaceId, surface)]: toggleValue(current, value),
          },
        });
      },

      sourceFiltersByWorkspace: {},
      toggleSourceFilter: (workspaceId, value, surface = 'sidebar') => {
        const current = readScoped(get().sourceFiltersByWorkspace, workspaceId, surface) ?? [];
        set({
          sourceFiltersByWorkspace: {
            ...get().sourceFiltersByWorkspace,
            [scopeKey(workspaceId, surface)]: toggleValue(current, value),
          },
        });
      },

      resetFilters: (workspaceId, surface = 'sidebar') => {
        const key = scopeKey(workspaceId, surface);
        set({
          statusFiltersByWorkspace: { ...get().statusFiltersByWorkspace, [key]: [] },
          sourceFiltersByWorkspace: { ...get().sourceFiltersByWorkspace, [key]: [] },
        });
      },

      hiddenSectionsByWorkspace: {},
      toggleSectionHidden: (workspaceId, sectionId, surface = 'sidebar') => {
        const current = readScoped(get().hiddenSectionsByWorkspace, workspaceId, surface) ?? [];
        set({
          hiddenSectionsByWorkspace: {
            ...get().hiddenSectionsByWorkspace,
            [scopeKey(workspaceId, surface)]: toggleValue(current, sectionId),
          },
        });
      },

      collapsedSectionsByWorkspace: {},
      toggleSectionCollapsed: (workspaceId, sectionId, surface = 'sidebar') => {
        // `inherit: false` to match `selectCollapsedSections` — a toggle must
        // start from the list this surface is actually rendering, never the
        // sidebar's.
        const current =
          readScoped(get().collapsedSectionsByWorkspace, workspaceId, surface, false) ?? [];
        set({
          collapsedSectionsByWorkspace: {
            ...get().collapsedSectionsByWorkspace,
            [scopeKey(workspaceId, surface)]: toggleValue(current, sectionId),
          },
        });
      },
      collapseAllSections: (workspaceId, sectionIds, surface = 'sidebar') => {
        set({
          collapsedSectionsByWorkspace: {
            ...get().collapsedSectionsByWorkspace,
            [scopeKey(workspaceId, surface)]: [...sectionIds],
          },
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      version: 1,
      migrate: (persisted) => {
        const legacy = persisted as Partial<State> & {
          groupByProject?: Record<string, SessionGroupMode>;
          orderByProject?: Record<string, SessionOrderMode>;
          statusFiltersByProject?: Record<string, SessionStatusFilter[]>;
          sourceFiltersByProject?: Record<string, SessionSourceFilter[]>;
          hiddenSectionsByProject?: Record<string, string[]>;
          collapsedSectionsByProject?: Record<string, string[]>;
        };
        return {
          ...legacy,
          groupByWorkspace: legacy.groupByWorkspace ?? legacy.groupByProject ?? {},
          orderByWorkspace: legacy.orderByWorkspace ?? legacy.orderByProject ?? {},
          statusFiltersByWorkspace:
            legacy.statusFiltersByWorkspace ?? legacy.statusFiltersByProject ?? {},
          sourceFiltersByWorkspace:
            legacy.sourceFiltersByWorkspace ?? legacy.sourceFiltersByProject ?? {},
          hiddenSectionsByWorkspace:
            legacy.hiddenSectionsByWorkspace ?? legacy.hiddenSectionsByProject ?? {},
          collapsedSectionsByWorkspace:
            legacy.collapsedSectionsByWorkspace ?? legacy.collapsedSectionsByProject ?? {},
        } as State & Actions;
      },
      partialize: (state) => ({
        groupByWorkspace: pruneWorkspaces(state.groupByWorkspace),
        orderByWorkspace: pruneWorkspaces(state.orderByWorkspace),
        statusFiltersByWorkspace: pruneWorkspaces(state.statusFiltersByWorkspace),
        sourceFiltersByWorkspace: pruneWorkspaces(state.sourceFiltersByWorkspace),
        hiddenSectionsByWorkspace: pruneWorkspaces(state.hiddenSectionsByWorkspace),
        collapsedSectionsByWorkspace: pruneWorkspaces(state.collapsedSectionsByWorkspace),
      }),
    },
  ),
);
