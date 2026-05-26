'use client';

/**
 * Composer prefill store — one-shot prompt handoff.
 *
 * Lets surfaces outside the composer (the onboarding wizard, the command
 * palette, a "try this" deep link) seed the project-home composer with a
 * prompt. The composer reads on mount and immediately clears, so the prefill
 * only applies once. Scoped per-project so prefills don't leak across
 * projects.
 */

import { create } from 'zustand';

interface ComposerPrefillState {
  /** projectId → prompt text. Cleared once consumed. */
  prefillByProject: Record<string, string>;
  setPrefill: (projectId: string, prompt: string) => void;
  /** Read AND clear in one step — the prompt should only land once. */
  consume: (projectId: string) => string | null;
}

export const useComposerPrefillStore = create<ComposerPrefillState>(
  (set, get) => ({
    prefillByProject: {},
    setPrefill: (projectId, prompt) =>
      set((s) => ({
        prefillByProject: { ...s.prefillByProject, [projectId]: prompt },
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
  }),
);
