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

/** Sub-tab to land on inside the LLM → Providers panel when deep-linking there.
 *  "Add provider" (catalog) is the primary surface, so it's the default. */
export type LlmProvidersTab = 'catalog' | 'connected' | 'models';

/** Sub-tab to land on inside the Members section when deep-linking there.
 *  "People" is the primary surface, so it's the default. */
export type MembersTab = 'people' | 'invite';

/** One-shot deep link into the Models Connect flow: opens the Connect modal
 *  directly on this method's form ("Connect Claude Code" → the Claude
 *  subscription form). The nonce makes each request distinct so the panel
 *  reacts even when it is already mounted. */
export interface LlmProvidersConnectRequest {
  kind: string;
  nonce: number;
}

interface CustomizeOptions {
  /** When jumping to `llm-providers`, which Providers sub-tab to open. */
  llmProvidersTab?: LlmProvidersTab;
  /** When jumping to `llm-providers`, open the Connect modal on this method. */
  llmProvidersConnectKind?: string;
  /** When jumping to `members`, which sub-tab to open (e.g. straight to Invite). */
  membersTab?: MembersTab;
}

interface CustomizeState {
  open: boolean;
  /** The currently-shown section. Persists between opens so reopening returns
   *  you to the last section you were on. */
  section: CustomizeSection;
  /** Which Providers sub-tab the LLM panel should land on. Reset to "catalog"
   *  (Add provider) on every open unless a trigger explicitly asks otherwise. */
  llmProvidersTab: LlmProvidersTab;
  /** Pending Connect-modal deep link, cleared on every open without one. */
  llmProvidersConnect: LlmProvidersConnectRequest | null;
  /** Which sub-tab the Members section should land on. Reset to "people" on
   *  every open unless a trigger explicitly asks otherwise (e.g. Invite). */
  membersTab: MembersTab;
  /** Open the overlay. Pass a section to jump straight to it; omit to resume
   *  wherever you left off. */
  openCustomize: (section?: CustomizeSection, opts?: CustomizeOptions) => void;
  setSection: (section: CustomizeSection) => void;
  close: () => void;
}

export const useCustomizeStore = create<CustomizeState>((set) => ({
  open: false,
  section: 'agents',
  llmProvidersTab: 'catalog',
  llmProvidersConnect: null,
  membersTab: 'people',
  openCustomize: (section, opts) =>
    set((s) => ({
      open: true,
      section: section ?? s.section,
      llmProvidersTab: opts?.llmProvidersTab ?? 'catalog',
      llmProvidersConnect: opts?.llmProvidersConnectKind
        ? { kind: opts.llmProvidersConnectKind, nonce: Date.now() }
        : null,
      membersTab: opts?.membersTab ?? 'people',
    })),
  setSection: (section) => set({ section }),
  close: () => set({ open: false }),
}));
