/**
 * What can actually change once a session is running — and what cannot.
 *
 * These three overrides look alike from the outside and behave completely
 * differently, which is exactly the sort of thing a reference app should make
 * legible rather than let people discover in production:
 *
 * - MODEL — changeable. `PUT /sessions/{id}/model` re-points the running runtime.
 *   Restarts it, so the in-flight turn ends.
 * - AGENT — changeable PER PROMPT: each message names the agent it runs. The
 *   proxy re-scopes secret delivery and the server-side token grant before it
 *   forwards the prompt. An optional strict operator lock can still return
 *   409 AGENT_SWITCH_REQUIRES_NEW_SESSION for a secret-grant boundary.
 * - SECRETS and CONNECTOR BINDINGS — changeable, with SET semantics:
 *   `PUT /projects/{id}/sessions/{sid}/scope` REPLACES the list with the one
 *   sent, and it takes effect from the next prompt (the per-prompt env sync
 *   already re-resolves and re-pushes the whole set).
 *
 *   The two differ in one way the UI must not blur:
 *     - connector bindings are resolved server-side at CALL time, so a change is
 *       effective immediately and completely;
 *     - a dropped SECRET stops being DELIVERED from the next prompt, but the
 *       value the agent already read is still in its context and in any shell it
 *       already started. That is why the response carries `retroactive: false`
 *       — reporting a plain success there would be false assurance, and false
 *       assurance is how a live credential gets left in place.
 */

import { serverErrorBody } from './api-error-body';

export type MidSessionCapability = 'changeable' | 'per_prompt' | 'fixed_at_create';

export const MID_SESSION_CAPABILITIES = {
  model: 'changeable',
  agent: 'per_prompt',
  // Both were 'fixed_at_create' until the /scope route existed. The old comment
  // justified it with "a mutable allowlist would leave the session permanently
  // unbootable" — an argument about BOOT that had hardened into a refusal to
  // change anything at all.
  secrets: 'changeable',
  connections: 'changeable',
  // Genuinely create-only, and the honest reason is different from the one the
  // secrets entry used to give: `runtime_context` is handed to the run at boot
  // and there is no route to replace it. Listed so `fixed_at_create` stays a
  // real state the UI can render rather than a dead branch.
  runtime_context: 'fixed_at_create',
} as const satisfies Record<string, MidSessionCapability>;

export type ModelChangeOutcome =
  | { kind: 'applied'; message: string; detail?: string }
  | { kind: 'stored'; message: string; detail?: string }
  | { kind: 'half_applied'; message: string; detail?: string };

/**
 * Classify what a model change actually achieved.
 *
 * THREE outcomes, not two. `PUT .../model` writes the row first, then pushes to
 * the live sandbox — so `appliedLive: false` covers two opposite situations:
 *
 * - no live sandbox to push to: the stored value IS the mechanism, and the next
 *   start reads it. A success.
 * - a push that was required and FAILED (`pushFailed`): the row is written but
 *   the RUNNING harness still answers from the old model.
 *
 * This UI reported both as `toast.success('… saved — applies when this session
 * next starts')`. For the second case that is false on two counts: the session
 * is running now, and it is running the OLD model. A user told the model changed
 * whose next answer comes from the previous one has been lied to.
 */
export function classifyModelChange(result: {
  model?: string | null;
  appliedLive?: boolean;
  pushFailed?: boolean;
  detail?: string;
}): ModelChangeOutcome {
  const model = stringOrNull(result.model) ?? 'The model';
  if (result.pushFailed) {
    return {
      kind: 'half_applied',
      message: `${model} was saved, but this session is still running the previous model. Restart it to pick up the change.`,
      ...(result.detail ? { detail: result.detail } : {}),
    };
  }
  if (result.appliedLive) return { kind: 'applied', message: `Now running ${model}` };
  return { kind: 'stored', message: `${model} saved — applies when this session next starts` };
}

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
 * `AGENT_SWITCH_REQUIRES_NEW_SESSION` is only emitted when an operator enables
 * the optional strict grant lock. Retrying with the same agent will always fail.
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
  /** The agent the message asked for. */
  requestedAgent: string | null;
  /** The agent this session started with. */
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
 * Recognise a send refused by an operator's strict immutable-grant policy.
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
