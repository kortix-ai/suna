'use client';

/**
 * Composer prefill store — one-shot prompt handoff.
 *
 * Lets surfaces outside the composer (the command palette, a "try this" deep
 * link) seed the project-home composer with a prompt. The composer reads on
 * mount and immediately clears, so the prefill only applies once. Scoped
 * per-project so prefills don't leak across projects.
 *
 * It only ever fills the box. Nothing here sends: the onboarding hand-off that
 * used to auto-send its kickoff prompt now opens the first chat instead
 * (`first-chat-store.ts`).
 */

import { create } from 'zustand';

interface ComposerPrefill {
  text: string;
}

interface ComposerPrefillState {
  /** projectId → prefill. Cleared once consumed. */
  prefillByProject: Record<string, ComposerPrefill>;
  setPrefill: (projectId: string, prompt: string) => void;
  /** Read AND clear in one step — the prompt should only land once. */
  consume: (projectId: string) => ComposerPrefill | null;
}

export const useComposerPrefillStore = create<ComposerPrefillState>((set, get) => ({
  prefillByProject: {},
  setPrefill: (projectId, prompt) =>
    set((s) => ({
      prefillByProject: { ...s.prefillByProject, [projectId]: { text: prompt } },
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
