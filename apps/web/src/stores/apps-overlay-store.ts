'use client';

/**
 * Apps overlay store.
 *
 * Mirrors `useCustomizeStore` for the Apps surface. The Apps button in the
 * project sidebar opens this overlay over whatever page is active so the user
 * doesn't lose their session/place. The overlay shows the project's
 * `[[apps]]` entries with deploy status, lets you add/edit/remove apps, and
 * trigger deploys/stops/logs against the Freestyle backend.
 */

import { create } from 'zustand';

type Section = 'list' | 'create' | 'edit' | 'logs';

interface AppsOverlayState {
  open: boolean;
  section: Section;
  /** Slug of the app the current `edit` / `logs` section is bound to. */
  selectedSlug: string | null;
  openApps: (opts?: { section?: Section; slug?: string | null }) => void;
  setSection: (section: Section, slug?: string | null) => void;
  close: () => void;
}

export const useAppsOverlayStore = create<AppsOverlayState>((set) => ({
  open: false,
  section: 'list',
  selectedSlug: null,
  openApps: (opts) =>
    set(() => ({
      open: true,
      section: opts?.section ?? 'list',
      selectedSlug: opts?.slug ?? null,
    })),
  setSection: (section, slug = null) => set({ section, selectedSlug: slug }),
  close: () => set({ open: false, section: 'list', selectedSlug: null }),
}));
