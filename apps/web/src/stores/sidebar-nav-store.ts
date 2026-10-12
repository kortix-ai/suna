import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createSafeJSONStorage } from '@/lib/storage/managed-storage';
import { registerPersistedStore, resetPersistedStore } from '@/stores/persisted-store-registry';

/**
 * The project sidebar's navigation rows, in the order and with the visibility
 * the person chose in "Customize sidebar". Per browser, across projects: the
 * sidebar is the same panel in every project, so one layout serves all of
 * them. A row a project does not offer (a flag is off, a permission is denied)
 * keeps its place here and simply does not render.
 */

export const SIDEBAR_NAV_ITEM_IDS = ['customize', 'apps', 'review', 'reminders', 'files'] as const;
export type SidebarNavItemId = (typeof SIDEBAR_NAV_ITEM_IDS)[number];

/**
 * `never` moves the row into the More menu (`project-nav-items.tsx`), so its
 * page stays one click away. `active` shows the row only while it has
 * something to say: a Review count that needs you, or a reminder that can
 * still fire. Only the rows in `SIDEBAR_NAV_ACTIVITY_ITEMS` have such a signal.
 */
export type SidebarNavVisibility = 'always' | 'active' | 'never';

export interface SidebarNavEntry {
  id: SidebarNavItemId;
  visibility: SidebarNavVisibility;
}

export const SIDEBAR_NAV_ACTIVITY_ITEMS: ReadonlySet<SidebarNavItemId> = new Set([
  'review',
  'reminders',
]);

/** The layout before anyone customizes it. Reminders keeps its old rule: it
 *  shows while a reminder can still fire. */
export const SIDEBAR_NAV_DEFAULTS: readonly SidebarNavEntry[] = [
  { id: 'customize', visibility: 'always' },
  { id: 'apps', visibility: 'always' },
  { id: 'review', visibility: 'always' },
  { id: 'reminders', visibility: 'active' },
  { id: 'files', visibility: 'always' },
];

function isItemId(value: unknown): value is SidebarNavItemId {
  return (SIDEBAR_NAV_ITEM_IDS as readonly unknown[]).includes(value);
}

function isVisibilityFor(id: SidebarNavItemId, value: unknown): value is SidebarNavVisibility {
  if (value === 'always' || value === 'never') return true;
  return value === 'active' && SIDEBAR_NAV_ACTIVITY_ITEMS.has(id);
}

/**
 * Saved layout → a complete, valid one. Unknown ids and duplicates drop, a bad
 * visibility falls back to the default, and a row added after the layout was
 * saved appears at its default position.
 */
export function normalizeSidebarNav(saved: unknown): SidebarNavEntry[] {
  const out: SidebarNavEntry[] = [];
  if (Array.isArray(saved)) {
    for (const entry of saved) {
      const id = (entry as Partial<SidebarNavEntry> | null)?.id;
      if (!isItemId(id) || out.some((e) => e.id === id)) continue;
      const fallback = SIDEBAR_NAV_DEFAULTS.find((d) => d.id === id)!.visibility;
      const visibility = (entry as Partial<SidebarNavEntry>).visibility;
      out.push({ id, visibility: isVisibilityFor(id, visibility) ? visibility : fallback });
    }
  }
  SIDEBAR_NAV_DEFAULTS.forEach((entry, index) => {
    if (!out.some((e) => e.id === entry.id)) out.splice(Math.min(index, out.length), 0, { ...entry });
  });
  return out;
}

/** Moves one row up (`-1`) or down (`+1`); the keyboard path of the drag. */
export function moveSidebarNavItem(
  items: readonly SidebarNavEntry[],
  id: SidebarNavItemId,
  delta: -1 | 1,
): SidebarNavEntry[] {
  const from = items.findIndex((e) => e.id === id);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= items.length) return [...items];
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/** `kortix.` is an app prefix, so sign-out sweeps it
 *  (`persisted-store-coverage.test.ts`). */
const STORAGE_KEY = 'kortix.sidebarNav';

interface SidebarNavState {
  items: SidebarNavEntry[];
  /** The Customize sidebar modal. Not persisted. */
  customizeOpen: boolean;
  /** Replaces the whole layout; normalized, so a partial or bad list is safe. */
  setItems: (items: SidebarNavEntry[]) => void;
  move: (id: SidebarNavItemId, delta: -1 | 1) => void;
  setVisibility: (id: SidebarNavItemId, visibility: SidebarNavVisibility) => void;
  reset: () => void;
  setCustomizeOpen: (open: boolean) => void;
}

export const useSidebarNavStore = create<SidebarNavState>()(
  persist(
    (set) => ({
      items: normalizeSidebarNav(null),
      customizeOpen: false,
      setItems: (items) => set({ items: normalizeSidebarNav(items) }),
      move: (id, delta) => set((state) => ({ items: moveSidebarNavItem(state.items, id, delta) })),
      setVisibility: (id, visibility) =>
        set((state) => ({
          items: state.items.map((e) =>
            e.id === id && isVisibilityFor(id, visibility) ? { id, visibility } : e,
          ),
        })),
      reset: () => set({ items: normalizeSidebarNav(null) }),
      setCustomizeOpen: (customizeOpen) => set({ customizeOpen }),
    }),
    {
      name: STORAGE_KEY,
      storage: createSafeJSONStorage(),
      version: 1,
      partialize: (state) => ({ items: state.items }),
      merge: (persisted, current) => ({
        ...current,
        items: normalizeSidebarNav((persisted as { items?: unknown } | undefined)?.items),
      }),
    },
  ),
);

registerPersistedStore(STORAGE_KEY, () => resetPersistedStore(useSidebarNavStore));

export function openCustomizeSidebar() {
  useSidebarNavStore.getState().setCustomizeOpen(true);
}
