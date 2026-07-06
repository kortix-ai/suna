'use client';

/**
 * useRunUpgrade — start any agent-led upgrade session from Customize: mint a
 * fresh session, stash the given prompt as its first message, close the
 * overlay, and drop the user into the thread. The generic engine behind both
 * the registry entries in `upgrade-defs.ts` and the one-off prompt runner;
 * `useMigrateToV2` is the v2-specific wrapper kept for its button.
 *
 * Deliberately does NOT pass `agent_name` — the session boots the project's
 * default agent (the one with git/CR powers).
 */

import { useCallback, useState } from 'react';

import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
import { useCustomizeStore } from '@/stores/customize-store';
import { writeStartStash, type StartStash } from '@kortix/sdk/react';

/** Pure — the exact stash payload an upgrade session is seeded with. */
export function buildUpgradeStash(prompt: string): StartStash {
  return { prompt, agent: null, model: null, variant: null };
}

export interface RunUpgrade {
  /** Mint + navigate to a session seeded with `prompt`. Ignored while a
   *  session is already being created. */
  start: (prompt: string) => void;
  pending: boolean;
}

export function useRunUpgrade(projectId: string): RunUpgrade {
  const closeCustomize = useCustomizeStore((s) => s.close);
  const [pending, setPending] = useState(false);
  const newSession = useNewProjectSession(projectId);

  const start = useCallback(
    (prompt: string) => {
      if (pending || !prompt.trim()) return;
      setPending(true);
      newSession({
        onNavigate: (sessionId) => {
          writeStartStash(sessionId, buildUpgradeStash(prompt));
          closeCustomize();
        },
      });
    },
    [pending, newSession, closeCustomize],
  );

  return { start, pending };
}
