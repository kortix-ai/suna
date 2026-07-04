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

import { useNewProjectSession } from '@/hooks/projects/use-new-project-session';
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
  const closeCustomize = useCustomizeStore((s) => s.close);
  const [pending, setPending] = useState(false);
  const newSession = useNewProjectSession(projectId);

  const start = useCallback(
    (prompt: string) => {
      // Guard re-entry: ignore extra clicks while a session is being minted so
      // we don't fire two creates (and blow the concurrent-session limit).
      if (pending) return;
      setPending(true);
      // Optimistic, identical to the project-home composer: mint the session,
      // stash the seed prompt, close the overlay, and drop into the instant shell
      // — which shows the prompt + inline boot status and auto-sends it once the
      // runtime is ready (the hook persists + bounces on a terminal failure).
      // Leave `pending` true: we're navigating away and the overlay is closing,
      // so flipping it back would only flash the idle button.
      newSession({
        onNavigate: (sessionId) => {
          // NOT converted to the SDK's `writeStartStash` (kept on the legacy
          // `project_pending_prompt` key): `sessionId` is the route/Kortix
          // session id here, not the OpenCode pin the session page resolves
          // later. `sessions/[sessionId]/page.tsx` forwards this exact raw
          // string onto the resolved pin via `migrateLegacyStash`, which only
          // understands this legacy shape at the source key — writing the
          // canonical stash under this id instead would go unread once the
          // pin resolves to a different id. Same situation as the
          // project-home composer's producer (see its onNavigate for the full
          // trace).
          sessionStorage.setItem(`project_pending_prompt:${sessionId}`, prompt);
          closeCustomize();
        },
      });
    },
    [pending, newSession, closeCustomize],
  );

  return { start, pending };
}
