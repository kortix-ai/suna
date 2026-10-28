'use client';

/**
 * Composer prefill store — one-shot prompt handoff.
 *
 * Lets surfaces outside the composer (the command palette, a "try this" deep
 * link) seed the project-home composer with a prompt. The composer reads on
 * mount and immediately clears, so the prefill only applies once. Scoped
 * per-project so prefills don't leak across projects.
 *
 * A prefill fills the box. Only `submit: true` also sends it, and only two
 * callers set that, each for a prompt the person typed into Kortix's own
 * composer: the desktop Quick Entry bar (`components/desktop/desktop-quick-entry.tsx`)
 * and the Kortix in Chrome side panel (`features/chrome/panel/chrome-panel-home.tsx`).
 * A URL (`?q=`) never
 * sends, because anyone can write a link. The onboarding hand-off that used to
 * auto-send its kickoff prompt now opens the first chat instead
 * (`first-chat-store.ts`).
 */

import type { AttachedFile } from '../../session/composer/types';
import type { SessionPromptOverrides } from '@kortix/sdk';
import { create } from 'zustand';

interface ComposerPrefill {
  text: string;
  /**
   * Send once it lands, exactly as if the person pressed Enter. `'when-ready'`
   * waits until the composer can send (models and entitlements loaded, Send
   * enabled): an image for a model that cannot read one then stays in the box,
   * where the composer says why.
   */
  submit?: boolean | 'when-ready';
  /** Files to attach (desktop Quick Entry screenshots and files). */
  files?: AttachedFile[];
  /** The agent, model and effort to select before it lands (desktop Quick Entry). */
  options?: SessionPromptOverrides;
}

type PrefillExtras = Omit<ComposerPrefill, 'text'>;

interface ComposerPrefillState {
  /** projectId → prefill. Cleared once consumed. */
  prefillByProject: Record<string, ComposerPrefill>;
  setPrefill: (projectId: string, prompt: string, extras?: PrefillExtras) => void;
  /** Read AND clear in one step — the prompt should only land once. */
  consume: (projectId: string) => ComposerPrefill | null;
}

export const useComposerPrefillStore = create<ComposerPrefillState>((set, get) => ({
  prefillByProject: {},
  setPrefill: (projectId, prompt, extras) =>
    set((s) => ({
      prefillByProject: {
        ...s.prefillByProject,
        [projectId]: {
          text: prompt,
          ...(extras?.submit ? { submit: true } : {}),
          ...(extras?.files?.length ? { files: extras.files } : {}),
          ...(extras?.options ? { options: extras.options } : {}),
        },
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
