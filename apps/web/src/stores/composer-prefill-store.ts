'use client';

/**
 * Composer prefill store — one-shot prompt handoff.
 *
 * Lets surfaces outside the composer (the onboarding wizard, the command
 * palette, a "try this" deep link) seed the project-home composer with a
 * prompt. The composer reads on mount and immediately clears, so the prefill
 * only applies once. Scoped per-project so prefills don't leak across
 * projects.
 *
 * `autoSend` is narrow to ONE caller: the onboarding wizard's finish step,
 * which needs the first message to actually go out the moment the user
 * clicks "Open project" — a prefilled box still waiting on a second click
 * would not be the "auto-started first chat" that flow promises. Every other
 * caller (the `?q=` deep link, the command palette) omits it and keeps the
 * existing prefill-only behavior; `project-home.tsx` is the only reader and
 * branches on the flag there.
 */

import { create } from 'zustand';

interface ComposerPrefill {
  text: string;
  /** Send `text` immediately on consumption instead of just filling the box. */
  autoSend?: boolean;
}

interface ComposerPrefillState {
  /** projectId → prefill. Cleared once consumed. */
  prefillByProject: Record<string, ComposerPrefill>;
  setPrefill: (projectId: string, prompt: string, options?: { autoSend?: boolean }) => void;
  /** Read AND clear in one step — the prompt should only land once. */
  consume: (projectId: string) => ComposerPrefill | null;
}

export const useComposerPrefillStore = create<ComposerPrefillState>(
  (set, get) => ({
    prefillByProject: {},
    setPrefill: (projectId, prompt, options) =>
      set((s) => ({
        prefillByProject: {
          ...s.prefillByProject,
          [projectId]: { text: prompt, autoSend: options?.autoSend },
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
  }),
);
