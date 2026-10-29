'use client';

/**
 * useRunUpgrade — start any agent-led upgrade session from Customize: mint a
 * fresh session, stash the given prompt as its first message, close the
 * overlay, and drop the user into the thread. The engine behind the registry
 * entries in `upgrade-defs.ts`, the one-off prompt runner and the sidebar
 * upgrade alert.
 *
 * Deliberately does NOT pass `agent_name` — the session boots the project's
 * default agent (the one with git/CR powers).
 */

import type { PendingSessionPrompt } from '@kortix/sdk';
import { useConfigureThread } from '../use-configure-thread';

/** Durable session-create payload; no model or agent override. */
export function pendingUpgradePrompt(prompt: string): PendingSessionPrompt {
  return { text: prompt, agent: null, model: null, variant: null };
}

export interface RunUpgrade {
  start: (prompt: string) => void;
  pending: boolean;
}

export function useRunUpgrade(projectId: string): RunUpgrade {
  const configure = useConfigureThread(projectId);
  return {
    pending: configure.pending,
    start: (prompt) => {
      if (prompt.trim()) configure.start(pendingUpgradePrompt(prompt));
    },
  };
}
