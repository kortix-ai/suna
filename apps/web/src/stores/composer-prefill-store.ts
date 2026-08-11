'use client';

/**
 * Composer prefill store — one-shot prompt handoff.
 *
 * Lets surfaces outside the composer (the onboarding wizard, the command
 * palette, a "try this" deep link) seed the workspace-home composer with a
 * prompt. The composer reads on mount and immediately clears, so the prefill
 * only applies once. Scoped per-workspace so prefills do not leak across
 * workspaces.
 */

import { create } from 'zustand';

interface ComposerPrefillState {
  /** workspaceId → prompt text. Cleared once consumed. */
  prefillByWorkspace: Record<string, string>;
  setPrefill: (workspaceId: string, prompt: string) => void;
  /** Read AND clear in one step — the prompt should only land once. */
  consume: (workspaceId: string) => string | null;
}

export const useComposerPrefillStore = create<ComposerPrefillState>(
  (set, get) => ({
    prefillByWorkspace: {},
    setPrefill: (workspaceId, prompt) =>
      set((s) => ({
        prefillByWorkspace: { ...s.prefillByWorkspace, [workspaceId]: prompt },
      })),
    consume: (workspaceId) => {
      const value = get().prefillByWorkspace[workspaceId];
      if (!value) return null;
      set((s) => {
        const next = { ...s.prefillByWorkspace };
        delete next[workspaceId];
        return { prefillByWorkspace: next };
      });
      return value;
    },
  }),
);
