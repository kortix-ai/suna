'use client';

/**
 * useConfigureThread — start an agent-led "configure" session from Customize.
 *
 * Project config (agents, skills, commands, …) lives in the repo and is
 * read-only from the UI — the only way to change it is through a session that
 * edits the files on a branch and opens a change request. So "Create new" and
 * "Edit" here don't write files directly: they spin up a fresh session seeded
 * with a prompt, close the Customize overlay, and drop you into the thread
 * (the session auto-sends the stashed prompt once its runtime is ready, same
 * as the project-home composer). The agent then asks what you want and opens a
 * CR you can review + merge.
 */

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useQueryClient } from '@tanstack/react-query';

import { createProjectSession } from '@/lib/projects-client';
import { toast } from '@/lib/toast';
import { useCustomizeStore } from '@/stores/customize-store';

export type ConfigureKind = 'agent' | 'skill' | 'command';

const NEW_PROMPTS: Record<ConfigureKind, string> = {
  agent:
    'I want to configure a new agent for this project. Ask me what it should ' +
    'specialize in and how it should behave, then create its config at ' +
    '`.kortix/opencode/agents/<name>.md` and open a change request so I can review and merge it.',
  skill:
    'I want to add a new skill to this project. Ask me what capability it ' +
    'should provide and when it should trigger, then scaffold ' +
    '`.kortix/opencode/skills/<name>/SKILL.md` and open a change request so I can review and merge it.',
  command:
    'I want to create a new slash command for this project. Ask me what it ' +
    'should do, then add it at `.kortix/opencode/commands/<name>.md` and open a ' +
    'change request so I can review and merge it.',
};

export function newConfigPrompt(kind: ConfigureKind): string {
  return NEW_PROMPTS[kind];
}

export function editConfigPrompt(kind: ConfigureKind, name: string, path: string): string {
  return (
    `I want to update the "${name}" ${kind} (its config lives at \`${path}\`). ` +
    `Ask me what I'd like to change, then make the edit and open a change request so I can review and merge it.`
  );
}

export interface ConfigureThread {
  /** Spin up a configure session for `prompt`, then close Customize + navigate. */
  start: (prompt: string) => void;
  /**
   * True while a session is being created. Creating one is a network round-trip
   * (same as the project-home composer), so callers should show a spinner +
   * disable their trigger — otherwise the button feels dead until we navigate.
   */
  pending: boolean;
}

export function useConfigureThread(projectId: string): ConfigureThread {
  const router = useRouter();
  const queryClient = useQueryClient();
  const closeCustomize = useCustomizeStore((s) => s.close);
  const [pending, setPending] = useState(false);

  const start = useCallback(
    async (prompt: string) => {
      // Guard re-entry: ignore extra clicks while a session is being minted so
      // we don't fire two creates (and blow the concurrent-session limit).
      if (pending) return;
      setPending(true);
      try {
        const session = await createProjectSession(projectId);
        // The active-session chat reads this and auto-sends once the runtime
        // is ready (same contract the project-home composer uses).
        sessionStorage.setItem(`project_pending_prompt:${session.session_id}`, prompt);
        queryClient.invalidateQueries({ queryKey: ['project-sessions', projectId] });
        closeCustomize();
        router.push(`/projects/${projectId}/sessions/${session.session_id}`);
        // Leave `pending` true on success — we're navigating away and the
        // overlay is closing; flipping it back would flash the idle button.
      } catch (err) {
        setPending(false);
        if ((err as any)?.code === 'concurrent_session_limit') return;
        toast.error(err instanceof Error ? err.message : 'Failed to start session');
      }
    },
    [projectId, router, queryClient, closeCustomize, pending],
  );

  return { start, pending };
}
