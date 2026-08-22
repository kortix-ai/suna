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
 *   proxy re-scopes secret delivery plus the connector and Kortix-CLI token
 *   grant before it forwards the prompt.
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
  | { kind: 'grant_unresolved'; message: string }
  | { kind: 'unknown'; message: string };

interface UpstreamError {
  code?: unknown;
  error?: unknown;
}

/**
 * Classify a prompt rejected because of the agent it asked to run.
 *
 * `AGENT_SECRET_GRANT_UNRESOLVED` means the sandbox is fine and only our ability
 * to VERIFY entitlement failed, so retrying IS correct (503).
 */
export function classifyAgentSwitch(body: UpstreamError | null): AgentSwitchOutcome {
  const code = typeof body?.code === 'string' ? body.code : '';
  const message =
    typeof body?.error === 'string' && body.error.trim().length > 0
      ? body.error
      : 'The agent could not be switched.';

  if (code === 'AGENT_SECRET_GRANT_UNRESOLVED') {
    return { kind: 'grant_unresolved', message };
  }
  if (code) return { kind: 'unknown', message };
  return { kind: 'ok' };
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}
