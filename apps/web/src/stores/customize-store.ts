'use client';

/**
 * Customize overlay store.
 *
 * Customize is a full-screen overlay that floats over whatever project page is
 * active (a session, the project home, …) instead of a route that swaps the
 * content area and spawns a tab. Keeping the open/section state here lets every
 * trigger — the sidebar button, project-home tiles, the command palette, the
 * sandbox alert, deep-link routes — open the same surface without navigating,
 * so you never lose your place. ESC / backdrop closes it and you're exactly
 * where you were.
 */

import { create } from 'zustand';

import type { CustomizeSection } from '@/lib/customize-sections';

interface CustomizeState {
  open: boolean;
  /** The currently-shown section. Persists between opens so reopening returns
   *  you to the last section you were on. */
  section: CustomizeSection;
  /** Open the overlay. Pass a section to jump straight to it; omit to resume
   *  wherever you left off. */
  openCustomize: (section?: CustomizeSection) => void;
  setSection: (section: CustomizeSection) => void;
  close: () => void;
}

export const useCustomizeStore = create<CustomizeState>((set) => ({
  open: false,
  section: 'agents',
  openCustomize: (section) =>
    set((s) => ({ open: true, section: section ?? s.section })),
  setSection: (section) => set({ section }),
  close: () => set({ open: false }),
}));
