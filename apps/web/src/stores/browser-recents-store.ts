'use client';

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { createSafeJSONStorage } from '@/lib/storage/managed-storage';

export interface BrowserRecent {
  /** Canonical visited URL, e.g. http://localhost:3000/debug/tools */
  url: string;
  /** Last visit timestamp (ms epoch) */
  visitedAt: number;
}

const MAX_RECENTS = 8;

/**
 * Canonical form used for dedupe and display: requires an http(s) scheme and
 * a host, strips trailing slashes so `/` and `` are the same entry.
 */
export function normalizeRecentUrl(url: string): string {
  const trimmed = url.trim();
  if (!/^https?:\/\/[^/\s]+/i.test(trimmed)) return '';
  return trimmed.replace(/\/+$/, '');
}

/** What the recents list renders: URL without the scheme noise. */
export function recentDisplayLabel(url: string): string {
  return url.replace(/^https?:\/\//i, '');
}

interface BrowserRecentsState {
  recents: BrowserRecent[];
  addRecent: (url: string) => void;
  removeRecent: (url: string) => void;
  clearRecents: () => void;
}

export const useBrowserRecentsStore = create<BrowserRecentsState>()(
  persist(
    (set, get) => ({
      recents: [],

      addRecent: (url) => {
        const normalized = normalizeRecentUrl(url);
        if (!normalized) return;
        const rest = get().recents.filter((r) => r.url !== normalized);
        set({
          recents: [{ url: normalized, visitedAt: Date.now() }, ...rest].slice(0, MAX_RECENTS),
        });
      },

      removeRecent: (url) => {
        const normalized = normalizeRecentUrl(url);
        set({ recents: get().recents.filter((r) => r.url !== normalized) });
      },

      clearRecents: () => set({ recents: [] }),
    }),
    {
      name: 'kortix-browser-recents',
      storage: createSafeJSONStorage(),
    },
  ),
);
