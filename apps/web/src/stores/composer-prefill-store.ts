'use client';

/**
 * Composer prefill store — one-shot prompt handoff.
 *
 * Lets surfaces outside the composer (the command palette, a "try this" deep
 * link) seed the project-home composer with a prompt. The composer reads on
 * mount and immediately clears, so the prefill only applies once. Scoped
 * per-project so prefills don't leak across projects.
 *
 * A prefill fills the box. Only `submit: true` also sends it, and only the
 * desktop Quick Entry sets that: a prompt the person typed into the app's own
 * bar (`components/desktop/desktop-quick-entry.tsx`). A URL (`?q=`) never
 * sends, because anyone can write a link. The onboarding hand-off that used to
 * auto-send its kickoff prompt now opens the first chat instead
 * (`first-chat-store.ts`).
 */

import { create } from 'zustand';

interface ComposerPrefill {
  text: string;
  /** Send once it lands, exactly as if the person pressed Enter. */
  submit?: boolean;
}

interface ComposerPrefillState {
  /** projectId → prefill. Cleared once consumed. */
  prefillByProject: Record<string, ComposerPrefill>;
  setPrefill: (projectId: string, prompt: string, options?: { submit?: boolean }) => void;
  /** Read AND clear in one step — the prompt should only land once. */
  consume: (projectId: string) => ComposerPrefill | null;
}

export const useComposerPrefillStore = create<ComposerPrefillState>((set, get) => ({
  prefillByProject: {},
  setPrefill: (projectId, prompt, options) =>
    set((s) => ({
      prefillByProject: {
        ...s.prefillByProject,
        [projectId]: { text: prompt, ...(options?.submit ? { submit: true } : {}) },
      },
    })),
  consume: (projectId) => {
    const value = get().prefillByProject[projectId];
    if (!value) return null;
    set((s) => {
      const next = { ...s.prefillByProject };
      delete next[projectId];
      return { prefillByProject: next };
    });
    return value;
  },
}));
