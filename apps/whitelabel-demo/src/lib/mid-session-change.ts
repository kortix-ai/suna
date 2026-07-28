/**
 * What can actually change once a session is running — and what cannot.
 *
 * These three overrides look alike from the outside and behave completely
 * differently, which is exactly the sort of thing a reference app should make
 * legible rather than let people discover in production:
 *
 * - MODEL — changeable. `PUT /sessions/{id}/model` re-points the running runtime.
 *   Restarts it, so the in-flight turn ends.
 * - AGENT — changeable PER PROMPT: each message names the agent it runs. But a
 *   switch to an agent with a DIFFERENT secrets grant is refused
 *   (409 AGENT_SWITCH_REQUIRES_NEW_SESSION), because re-scoping now cannot
 *   un-read what the session's original agent already pulled into the box.
 * - SECRETS — NOT changeable, by design. `secrets_allowlist` is written once at
 *   create and there is no update path anywhere. The server comments are blunt
 *   about why: a mutable allowlist "would leave the session permanently
 *   unbootable" if it were narrowed below what the box already needs.
 */

export type MidSessionCapability = 'changeable' | 'per_prompt' | 'fixed_at_create';

export const MID_SESSION_CAPABILITIES = {
  model: 'changeable',
  agent: 'per_prompt',
  secrets: 'fixed_at_create',
} as const satisfies Record<string, MidSessionCapability>;

export type AgentSwitchOutcome =
  | { kind: 'ok' }
  | { kind: 'needs_new_session'; message: string }
  | { kind: 'grant_unresolved'; message: string }
  | { kind: 'unknown'; message: string };

interface UpstreamError {
  code?: unknown;
  error?: unknown;
}

/**
 * Classify a prompt rejected because of the agent it asked to run.
 *
 * `AGENT_SWITCH_REQUIRES_NEW_SESSION` is not a failure to retry — retrying with
 * the same agent will always fail. The only resolution is a new session, so the
 * UI must offer that rather than a retry button.
 *
 * `AGENT_SECRET_GRANT_UNRESOLVED` is the opposite: the sandbox is fine and only
 * our ability to VERIFY entitlement failed, so retrying IS correct (503).
 */
export function classifyAgentSwitch(body: UpstreamError | null): AgentSwitchOutcome {
  const code = typeof body?.code === 'string' ? body.code : '';
  const message =
    typeof body?.error === 'string' && body.error.trim().length > 0
      ? body.error
      : 'The agent could not be switched.';

  if (code === 'AGENT_SWITCH_REQUIRES_NEW_SESSION') {
    return { kind: 'needs_new_session', message };
  }
  if (code === 'AGENT_SECRET_GRANT_UNRESOLVED') {
    return { kind: 'grant_unresolved', message };
  }
  if (code) return { kind: 'unknown', message };
  return { kind: 'ok' };
}
