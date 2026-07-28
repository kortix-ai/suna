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

import { serverErrorBody } from './api-error-body';

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

/** A refused agent switch, with the agents the server named. */
export interface AgentSwitchRefusal {
  message: string;
  /** The agent the message asked for — the one that needs a new session. */
  requestedAgent: string | null;
  /** The agent this session's sandbox is provisioned for. */
  expectedAgent: string | null;
}

/** The `{...}` payload embedded in a runtime error's message text.
 *
 *  The refusal is raised by the sandbox proxy on the prompt itself, so it
 *  reaches a host as a generic runtime error whose message carries the JSON
 *  body rather than as a structured API error. Read both shapes, or the one
 *  refusal that CANNOT be retried renders as an ordinary "send failed". */
function embeddedErrorBody(text: unknown): { code?: unknown; error?: unknown } | null {
  if (typeof text !== 'string') return null;
  const start = text.indexOf('{');
  if (start < 0) return null;
  try {
    const parsed: unknown = JSON.parse(text.slice(start));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Recognise a send that was refused because the message named an agent whose
 * secret grant differs from the one this session booted with.
 *
 * Returns null for every other failure: the caller offers "start a new session"
 * ONLY here, because that is the only resolution — retrying the same send fails
 * identically, forever.
 */
export function agentSwitchRefusal(
  error: { message?: string; cause?: unknown } | null | undefined,
): AgentSwitchRefusal | null {
  if (!error) return null;
  const cause = error.cause as { message?: unknown } | undefined;

  // Same refusal, two envelopes: a structured API error, or the JSON body
  // carried inside a runtime error's message text. `fields` is the body
  // itself, which is where the agent names live.
  const candidates: Array<{ code?: unknown; error?: unknown; fields: Record<string, unknown> }> =
    [];
  const structured = serverErrorBody(cause);
  if (structured) candidates.push({ ...structured, fields: structured.raw ?? {} });
  for (const text of [cause?.message, error.message]) {
    const parsed = embeddedErrorBody(text);
    if (parsed) candidates.push({ ...parsed, fields: parsed as Record<string, unknown> });
  }

  for (const candidate of candidates) {
    if (classifyAgentSwitch(candidate).kind !== 'needs_new_session') continue;
    return {
      message: stringOrNull(candidate.error) ?? 'That agent needs a new session.',
      requestedAgent: stringOrNull(candidate.fields.requested_agent),
      expectedAgent: stringOrNull(candidate.fields.expected_agent),
    };
  }
  return null;
}
