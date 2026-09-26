/**
 * DROP AN AGENT THE PROJECT DOES NOT DECLARE FROM A TURN-START BODY.
 *
 * INC-2026-09-15. A turn-start body (`/session/:id/prompt_async|message|command`)
 * names the agent to run, and three things follow that name verbatim: the
 * session token's grant (`remintGrantForAgentSwitch`), the prompt's secret env
 * (`syncSandboxEnvForPrompt`) and the runtime itself. An agent of a DIFFERENT
 * project reached all three for ~50 sessions of unrelated
 * projects, and every one of them lost its CLI and connector access.
 *
 * The name is checked against the session's OWN project manifest before any of
 * that runs. An undeclared name is removed from the body, so the turn runs as
 * the session's own agent (OpenCode's `default_agent`) — the same thing a body
 * with no agent does — and the event is logged with everything needed to find
 * the sender. Removal, not refusal: the user's message is still delivered.
 *
 * Pure apart from the injected `isLaunchable` and `log`, so every branch is
 * asserted without a sandbox.
 */

import {
  DEFAULT_AGENT_SENTINEL,
  bodyWithoutPromptAgent,
  requestedPromptAgent,
} from './pre-prompt-env-sync';

export interface UndeclaredPromptAgentEvent {
  projectId: string;
  sessionId: string;
  sandboxId: string;
  path: string;
  sessionAgent: string;
  requestedAgent: string;
  sandboxAuthored: boolean;
  userId: string | null;
  userAgent: string | null;
  reason: 'undeclared' | 'unverifiable';
}

export interface DropUndeclaredPromptAgentInput {
  body: ArrayBuffer | undefined;
  headers: Headers;
  projectId: string;
  sessionId: string;
  sandboxId: string;
  path: string;
  /** `project_sessions.agent_name` — always launchable, never re-checked. */
  sessionAgent: string;
  sandboxAuthored: boolean;
  userId: string | null;
  userAgent: string | null;
  isLaunchable: (agentName: string) => Promise<boolean>;
  log: (event: UndeclaredPromptAgentEvent) => void;
}

export interface DropUndeclaredPromptAgentResult {
  body: ArrayBuffer | undefined;
  /** The agent the body still names after the check, or null. */
  requestedAgent: string | null;
  /** The name that was removed, or null when nothing was. */
  droppedAgent: string | null;
}

export async function dropUndeclaredPromptAgent(
  input: DropUndeclaredPromptAgentInput,
): Promise<DropUndeclaredPromptAgentResult> {
  const requestedAgent = requestedPromptAgent(input.body, input.headers);
  if (
    !requestedAgent ||
    requestedAgent === DEFAULT_AGENT_SENTINEL ||
    requestedAgent === input.sessionAgent
  ) {
    return { body: input.body, requestedAgent, droppedAgent: null };
  }

  let reason: UndeclaredPromptAgentEvent['reason'] | null = null;
  try {
    if (!(await input.isLaunchable(requestedAgent))) reason = 'undeclared';
  } catch {
    reason = 'unverifiable';
  }
  if (!reason) return { body: input.body, requestedAgent, droppedAgent: null };

  input.log({
    projectId: input.projectId,
    sessionId: input.sessionId,
    sandboxId: input.sandboxId,
    path: input.path,
    sessionAgent: input.sessionAgent,
    requestedAgent,
    sandboxAuthored: input.sandboxAuthored,
    userId: input.userId,
    userAgent: input.userAgent,
    reason,
  });
  return {
    body: bodyWithoutPromptAgent(input.body, input.headers),
    requestedAgent: null,
    droppedAgent: requestedAgent,
  };
}
