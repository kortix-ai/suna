'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import type { SessionSourceFilter, SessionStatusFilter } from '@/components/projects/session-label';
import {
  DEFAULT_SESSION_GROUP_MODE,
  type SessionGroupMode,
  type SessionOrderMode,
} from '@/features/workspace/project-sidebar/session-grouping';
import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from '@/stores/persisted-store-registry';

/**
 * Per-project session-list VIEW state — grouping, ordering, the two filter
 * facets, and section visibility/collapse.
 *
 * Held in a module-level, persisted store so the chosen view survives the
 * project shell remounting on navigation — opening a session, ⌘J, switching
 * sessions. Local component state used to reset back to defaults on every
 * such remount.
 */

const STORAGE_KEY = 'kortix.project-session-view';

/**
 * The fallback every list-valued selector must use — never a bare `[]`.
 *
 * zustand v5 reads through `useSyncExternalStore`, which compares snapshots
 * with `Object.is`. A selector written `s.statusFiltersByProject[id] ?? []`
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
 * The sidebar keeps the bare `projectId` as its key, so every value persisted
 * before surfaces existed keeps working and keeps belonging to the sidebar.
 */
export type SessionViewSurface = 'sidebar' | 'page';

function scopeKey(projectId: string, surface: SessionViewSurface): string {
  return surface === 'sidebar' ? projectId : `${projectId}::${surface}`;
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
  projectId: string,
  surface: SessionViewSurface,
  /** Set false for state that is per-surface scratch rather than a preference —
   *  see `selectCollapsedSections`. */
  inherit = true,
): V | undefined {
  const own = map[scopeKey(projectId, surface)];
  if (own !== undefined || surface === 'sidebar' || !inherit) return own;
  return map[projectId];
}

/** Soft cap so the per-project map can't grow unbounded; keeps the last N.
 *  Two surfaces per project, so this is ~24 projects, as it was before the
 *  page got its own scope. */
const MAX_TRACKED_SCOPES = 48;

function pruneProjects<V>(map: Record<string, V>): Record<string, V> {
  const keys = Object.keys(map);
  if (keys.length <= MAX_TRACKED_SCOPES) return map;
  return Object.fromEntries(keys.slice(-MAX_TRACKED_SCOPES).map((k) => [k, map[k]]));
}

function toggleValue<V>(list: readonly V[], value: V): V[] {
  return list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
}

interface State {
  groupByProject: Record<string, SessionGroupMode>;
  orderByProject: Record<string, SessionOrderMode>;
  statusFiltersByProject: Record<string, SessionStatusFilter[]>;
  sourceFiltersByProject: Record<string, SessionSourceFilter[]>;
  hiddenSectionsByProject: Record<string, string[]>;
  collapsedSectionsByProject: Record<string, string[]>;
}

/**
 * Every action takes the surface LAST and defaults it to `sidebar`, so the
 * sidebar's existing call sites are unchanged and only the page opts in.
 */
interface Actions {
  setGroupMode: (projectId: string, mode: SessionGroupMode, surface?: SessionViewSurface) => void;
  setOrderMode: (projectId: string, order: SessionOrderMode, surface?: SessionViewSurface) => void;
  toggleStatusFilter: (
    projectId: string,
    value: SessionStatusFilter,
    surface?: SessionViewSurface,
  ) => void;
  toggleSourceFilter: (
    projectId: string,
    value: SessionSourceFilter,
    surface?: SessionViewSurface,
  ) => void;
  resetFilters: (projectId: string, surface?: SessionViewSurface) => void;
  toggleSectionHidden: (projectId: string, sectionId: string, surface?: SessionViewSurface) => void;
  toggleSectionCollapsed: (
    projectId: string,
    sectionId: string,
    surface?: SessionViewSurface,
  ) => void;
  collapseAllSections: (
    projectId: string,
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
  (projectId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): SessionGroupMode =>
    readScoped(s.groupByProject, projectId, surface) ?? DEFAULT_SESSION_GROUP_MODE;

export const selectOrderMode =
  (projectId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): SessionOrderMode =>
    readScoped(s.orderByProject, projectId, surface) ?? 'activity';

export const selectStatusFilters =
  (projectId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): readonly SessionStatusFilter[] =>
    readScoped(s.statusFiltersByProject, projectId, surface) ?? EMPTY_LIST;

export const selectSourceFilters =
  (projectId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): readonly SessionSourceFilter[] =>
    readScoped(s.sourceFiltersByProject, projectId, surface) ?? EMPTY_LIST;

export const selectHiddenSections =
  (projectId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): readonly string[] =>
    readScoped(s.hiddenSectionsByProject, projectId, surface) ?? EMPTY_LIST;

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
  (projectId: string, surface: SessionViewSurface = 'sidebar') =>
  (s: State): readonly string[] =>
    readScoped(s.collapsedSectionsByProject, projectId, surface, false) ?? EMPTY_LIST;

export const useSessionFilterStore = create<State & Actions>()(
  persist(
    (set, get) => ({
      // Every write below targets THIS surface's key, while the `readScoped`
      // reads still inherit the sidebar's value until that first write lands —
      // so a toggle on the page starts from what the page is showing, and ends
      // up owned by the page.
      groupByProject: {},
      setGroupMode: (projectId, mode, surface = 'sidebar') => {
        if (
          (readScoped(get().groupByProject, projectId, surface) ?? DEFAULT_SESSION_GROUP_MODE) ===
          mode
        ) {
          return;
        }
        set({
          groupByProject: { ...get().groupByProject, [scopeKey(projectId, surface)]: mode },
        });
      },

      orderByProject: {},
      setOrderMode: (projectId, order, surface = 'sidebar') => {
        if ((readScoped(get().orderByProject, projectId, surface) ?? 'activity') === order) return;
        set({
          orderByProject: { ...get().orderByProject, [scopeKey(projectId, surface)]: order },
        });
      },

      statusFiltersByProject: {},
      toggleStatusFilter: (projectId, value, surface = 'sidebar') => {
        const current = readScoped(get().statusFiltersByProject, projectId, surface) ?? [];
        set({
          statusFiltersByProject: {
            ...get().statusFiltersByProject,
            [scopeKey(projectId, surface)]: toggleValue(current, value),
          },
        });
      },

      sourceFiltersByProject: {},
      toggleSourceFilter: (projectId, value, surface = 'sidebar') => {
        const current = readScoped(get().sourceFiltersByProject, projectId, surface) ?? [];
        set({
          sourceFiltersByProject: {
            ...get().sourceFiltersByProject,
            [scopeKey(projectId, surface)]: toggleValue(current, value),
          },
        });
      },

      resetFilters: (projectId, surface = 'sidebar') => {
        const key = scopeKey(projectId, surface);
        set({
          statusFiltersByProject: { ...get().statusFiltersByProject, [key]: [] },
          sourceFiltersByProject: { ...get().sourceFiltersByProject, [key]: [] },
        });
      },

      hiddenSectionsByProject: {},
      toggleSectionHidden: (projectId, sectionId, surface = 'sidebar') => {
        const current = readScoped(get().hiddenSectionsByProject, projectId, surface) ?? [];
        set({
          hiddenSectionsByProject: {
            ...get().hiddenSectionsByProject,
            [scopeKey(projectId, surface)]: toggleValue(current, sectionId),
          },
        });
      },

      collapsedSectionsByProject: {},
      toggleSectionCollapsed: (projectId, sectionId, surface = 'sidebar') => {
        // `inherit: false` to match `selectCollapsedSections` — a toggle must
        // start from the list this surface is actually rendering, never the
        // sidebar's.
        const current =
          readScoped(get().collapsedSectionsByProject, projectId, surface, false) ?? [];
        set({
          collapsedSectionsByProject: {
            ...get().collapsedSectionsByProject,
            [scopeKey(projectId, surface)]: toggleValue(current, sectionId),
          },
        });
      },
      collapseAllSections: (projectId, sectionIds, surface = 'sidebar') => {
        set({
          collapsedSectionsByProject: {
            ...get().collapsedSectionsByProject,
            [scopeKey(projectId, surface)]: [...sectionIds],
          },
        });
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      partialize: (state) => ({
        groupByProject: pruneProjects(state.groupByProject),
        orderByProject: pruneProjects(state.orderByProject),
        statusFiltersByProject: pruneProjects(state.statusFiltersByProject),
        sourceFiltersByProject: pruneProjects(state.sourceFiltersByProject),
        hiddenSectionsByProject: pruneProjects(state.hiddenSectionsByProject),
        collapsedSectionsByProject: pruneProjects(state.collapsedSectionsByProject),
      }),
    },
  ),
);

// Registers this store for `resetClientState()`'s sign-out sweep without
// `reset-client-state.ts` importing this file — see `persisted-store-registry.ts`.
registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(useSessionFilterStore));
