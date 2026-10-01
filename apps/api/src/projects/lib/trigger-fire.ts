import { projectLlmGatewayEnabled } from '../../llm-gateway/enablement';
import { toOpencodeModelRef } from '../../llm-gateway/resolution/effective';
import type { PromptOverridesWire } from '../session-lifecycle/store';
import { projectSessions, projectTriggerRuntime } from '@kortix/db';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { createSession, drainSessionLifecycleQueue, enqueueContinueSessionCommand, resolveAgentRunAttribution, resolveProjectAutomationActor } from '../session-lifecycle';
import type { GitTriggerSpec } from '../triggers';
import type { ProjectRow, RequestAuditContext } from './serializers';
import { renderSessionKey } from './trigger-payload';
import { keepRunFailure } from '../trigger-execution-store';
import { TRIGGER_REUSE_RETIRED_AT } from './trigger-run-outcome';
import { disableSessionReminder, reminderPromptText } from './session-reminders';
import type { TriggerFireSource } from './trigger-webhook-auth';

/**
 * Find a user we can attribute trigger-spawned sessions to. Git-backed
 * triggers don't have a `created_by` like the DB-backed ones do — we pick
 * the account's first owner as a stable, audit-friendly stand-in.
 */

export async function resolveGitTriggerActor(accountId: string): Promise<string | null> {
  return resolveProjectAutomationActor(accountId);
}

/**
 * Resolve the identity a trigger's automated session PROVISIONS as — the
 * account-member stand-in `createProjectSession` needs for the provisioning/
 * authorization actor (concurrency cap, secret-visibility subject, the
 * standing-role fallback an unactivated agent SA relies on — see
 * `resolveActingActor` in iam/engine-v2.ts). This is intentionally NOT the
 * run's recorded identity. The create-session action applies the trigger's
 * access policy and records the agent's service account after the row exists.
 * This keeps attribution and authorization on separate fields.
 * What a run can actually ACCESS is governed by the AGENT's declared scope in
 * kortix.yaml's `agents:` map (secrets + connectors), applied when the session
 * env is built — not by this stand-in.
 */
export async function resolveTriggerActor(project: ProjectRow): Promise<string | null> {
  return resolveProjectAutomationActor(project.accountId);
}

/**
 * Preserve the internal attribution helper for callers that create trigger
 * sessions outside the durable create-session action. The primary trigger
 * fire path does not call this helper. Its action applies attribution and the
 * complete access policy in one transaction.
 */
export async function attributeFiredTriggerSession(input: {
  project: ProjectRow;
  sessionId: string;
  agentName: string;
}): Promise<void> {
  const serviceAccountId = await resolveAgentRunAttribution({
    accountId: input.project.accountId,
    projectId: input.project.projectId,
    agentName: input.agentName,
  });
  if (!serviceAccountId) return;
  try {
    await db
      .update(projectSessions)
      .set({ createdBy: serviceAccountId })
      .where(eq(projectSessions.sessionId, input.sessionId));
  } catch (err) {
    console.warn('[triggers] failed to attribute fired session to agent service account', {
      sessionId: input.sessionId,
      agentName: input.agentName,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function getGitTriggerRuntime(projectId: string, slug: string) {
  const [row] = await db
    .select()
    .from(projectTriggerRuntime)
    .where(
      and(eq(projectTriggerRuntime.projectId, projectId), eq(projectTriggerRuntime.slug, slug)),
    )
    .limit(1);
  return row ?? null;
}

export async function markGitTriggerFired(
  projectId: string,
  slug: string,
  when: Date,
  status: 'fired' | 'queued' = 'fired',
) {
  await db
    .insert(projectTriggerRuntime)
    .values({
      projectId,
      slug,
      lastFiredAt: when,
      lastStatus: status,
      lastError: null,
      lastAttemptAt: when,
      updatedAt: when,
    })
    .onConflictDoUpdate({
      target: [projectTriggerRuntime.projectId, projectTriggerRuntime.slug],
      set: {
        lastFiredAt: when,
        ...keepRunFailure(status),
        lastAttemptAt: when,
        updatedAt: when,
      },
    });
}

/**
 * Record a failed attempt (fire error or parse error) WITHOUT advancing
 * `last_fired_at`, so the trigger is still due and retries next sweep — but the
 * reason is now visible in the triggers API/UI instead of vanishing into a log.
 */
export async function markGitTriggerAttemptFailed(
  projectId: string,
  slug: string,
  when: Date,
  error: string,
) {
  const lastError = error.slice(0, 1000);
  await db
    .insert(projectTriggerRuntime)
    .values({
      projectId,
      slug,
      lastStatus: 'failed',
      lastError,
      lastAttemptAt: when,
      updatedAt: when,
    })
    .onConflictDoUpdate({
      target: [projectTriggerRuntime.projectId, projectTriggerRuntime.slug],
      set: { lastStatus: 'failed', lastError, lastAttemptAt: when, updatedAt: when },
    });
}

/**
 * Find the canonical session to reuse for a `session_mode = "reuse"` trigger:
 * the most recent NON-failed session this trigger created. Sessions are matched
 * via the `trigger_slug` + `trigger_kind` we stamp into `project_sessions.metadata`
 * at fire time (no extra column / migration needed). Failed sessions are skipped
 * so a dead run is abandoned in favor of a freshly-created canonical session.
 */
export async function findReusableTriggerSession(
  projectId: string,
  slug: string,
): Promise<{ sessionId: string } | null> {
  const [row] = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, projectId),
        ne(projectSessions.status, 'failed'),
        sql`${projectSessions.metadata} ->> 'trigger_slug' = ${slug}`,
        sql`${projectSessions.metadata} ->> 'trigger_kind' = 'git'`,
        // Same soft-delete guard as the keyed lookup above.
        sql`${projectSessions.metadata} ->> 'deletedAt' IS NULL`,
        // A session whose history no longer fits the model, even after
        // compaction, fails every run. recordTriggerRunEnd retires it.
        sql`${projectSessions.metadata} ->> ${TRIGGER_REUSE_RETIRED_AT} IS NULL`,
      ),
    )
    .orderBy(desc(projectSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * The `session_mode = "keyed"` analogue of {@link findReusableTriggerSession}:
 * the most recent non-failed session this trigger created *for this key*. Uses
 * the same `project_sessions.metadata` stamping trick, so keyed routing needs
 * no extra column and no migration.
 *
 * The key is matched exactly and is caller-supplied data (a chat id, a customer
 * id) — it goes through a bound parameter, never string interpolation.
 */
export async function findKeyedTriggerSession(
  projectId: string,
  slug: string,
  sessionKey: string,
): Promise<{ sessionId: string } | null> {
  const [row] = await db
    .select({ sessionId: projectSessions.sessionId })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.projectId, projectId),
        ne(projectSessions.status, 'failed'),
        sql`${projectSessions.metadata} ->> 'trigger_slug' = ${slug}`,
        sql`${projectSessions.metadata} ->> 'trigger_kind' = 'git'`,
        sql`${projectSessions.metadata} ->> 'trigger_session_key' = ${sessionKey}`,
        // deleteSession() is a SOFT delete: it stamps metadata.deletedAt and
        // leaves the row 'stopped'. Selecting one would bind this key to a
        // session that can never run again — and because a keyed trigger keeps
        // resolving to the same session, every later message for that chat
        // would be swallowed silently rather than starting a new one.
        sql`${projectSessions.metadata} ->> 'deletedAt' IS NULL`,
        sql`${projectSessions.metadata} ->> ${TRIGGER_REUSE_RETIRED_AT} IS NULL`,
      ),
    )
    .orderBy(desc(projectSessions.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Durable prompt hand-off into an EXISTING session (`session_mode` pinned /
 * reuse). The direct in-process continueSession() call this replaces was the
 * silent-loss hole: 'pending' (runtime never ready inside the deadline) was
 * TERMINAL on that path — no durable row, no retry, no error log, prompt gone,
 * session showing "queued" forever. Enqueue a durable continue_session command
 * instead: the scheduler's drain tick executes it with retry/backoff, and a
 * dead-letter ships a real error AND parks the session 'failed' (see
 * store.markCommandFailed) so the next fire self-heals via a fresh session.
 * The immediate drain kick keeps the happy path feeling instant.
 *
 * Only liveness is pre-checked here (mirrors continueSession's own guards) —
 * a missing/failed/deleted session must keep falling through to the create
 * path exactly like the old direct call's 'no-session'/'failed' outcomes.
 */
/**
 * A trigger's `model` is a wire ref (`codex/gpt-5.6-luna`, `kortix/glm-5.2`).
 * A FRESH session bakes it into the session (`opencode_model`); a re-prompted
 * session must carry it on the prompt itself, or the prompt silently runs on
 * whatever default the session was created with — on prod that was a July
 * session pinned to a managed model the account can no longer use.
 *
 * The one place a stored ref becomes the runtime's `{providerID, modelID}`:
 * with the LLM gateway every model is the `kortix` provider's; without it the
 * ref is the native `provider/model`, and a managed id has no provider.
 */
export function triggerModelOverride(
  model: string | null | undefined,
  gatewayEnabled = true,
): PromptOverridesWire | undefined {
  const trimmed = (model ?? '').trim();
  if (!trimmed) return undefined;
  const ref = gatewayEnabled ? toOpencodeModelRef(trimmed) : trimmed.replace(/^kortix\//, '');
  const slash = ref.indexOf('/');
  if (slash <= 0 || slash === ref.length - 1) return undefined;
  return { model: { providerID: ref.slice(0, slash), modelID: ref.slice(slash + 1) } };
}

async function enqueueTriggerPrompt(input: {
  project: ProjectRow;
  sessionId: string;
  actor: string;
  text: string;
  source: TriggerFireSource;
  triggerSlug: string;
  idempotencyKey?: string | null;
  /** The trigger's configured model; carried on the prompt for a re-prompted session. */
  model?: string | null;
}): Promise<'queued' | 'no-session' | 'failed'> {
  // Scoped to the trigger's own project and account. A pinned `session_id` is
  // manifest text, so a session of any other project is "no session" here and
  // the fire falls through to the trigger's own reuse/create path.
  const [session] = await db
    .select({ status: projectSessions.status, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(
      and(
        eq(projectSessions.sessionId, input.sessionId),
        eq(projectSessions.projectId, input.project.projectId),
        eq(projectSessions.accountId, input.project.accountId),
      ),
    )
    .limit(1);
  if (!session) return 'no-session';
  if (session.status === 'failed') return 'failed';
  const sessionMeta = (session.metadata ?? {}) as Record<string, unknown>;
  if (typeof sessionMeta.deletedAt === 'string') return 'no-session';

  await enqueueContinueSessionCommand({
    source: `trigger:${input.source}`,
    projectId: input.project.projectId,
    accountId: input.project.accountId,
    sessionId: input.sessionId,
    actorUserId: input.actor,
    text: input.text,
    triggerSlug: input.triggerSlug,
    // Same per-due-slot key the create path uses — a fire the sweep timed out
    // on but that actually enqueued isn't duplicated when the next tick retries.
    idempotencyKey: input.idempotencyKey ?? null,
    overrides: triggerModelOverride(input.model, projectLlmGatewayEnabled(input.project.metadata)),
  });
  // Fast path only — the scheduler's 60s drain tick is the delivery guarantee.
  drainSessionLifecycleQueue({ limit: 1 }).catch(() => {});
  return 'queued';
}

/**
 * Fire a git-backed trigger. Triggers are file-defined (kortix.yaml), so there
 * is no DB trigger/event row — the project_sessions row carries `trigger_slug`
 * in metadata so audits can still reconstruct the firing path.
 */

export async function fireGitTrigger(input: {
  spec: GitTriggerSpec;
  project: ProjectRow;
  payload: Record<string, unknown>;
  renderedPrompt: string;
  source: TriggerFireSource;
  idempotencyKey?: string | null;
  request?: RequestAuditContext;
}): Promise<{
  status: 'fired' | 'queued' | 'failed';
  sessionId?: string;
  commandId?: string;
  error?: string;
  /** Machine-readable failure code when `createSession` rejected the fire
   *  (e.g. `insufficient_credits`, `subscription_required`, `no_account`). */
  errorCode?: string;
  reason?: string;
  deduped?: boolean;
}> {
  const { spec, project, payload, renderedPrompt, source } = input;
  // The session's owning identity (created_by / billing / audit). Automated runs
  // never impersonate a picked human — the agent's declared scope governs access.
  // See resolveTriggerActor().
  const actor = await resolveTriggerActor(project);
  if (!actor) {
    return { status: 'failed', error: 'No account owner available to own the session' };
  }

  if (spec.reminder) return fireSessionReminder(input, actor);

  const sessionKey = renderSessionKey(spec, payload);
  const queuedSessionId = await queueExistingTriggerSession(input, actor, sessionKey);
  if (queuedSessionId) {
    return { status: 'queued', sessionId: queuedSessionId, reason: 'prompt queued for delivery' };
  }
  return createGitTriggerSession(input, actor, sessionKey);
}

/**
 * A session reminder re-prompts its own session and nothing else. Unlike a pinned
 * trigger it never falls back to a fresh session: a check-in without the
 * session's context is noise. A gone session switches the reminder off instead.
 */
async function fireSessionReminder(
  input: Parameters<typeof fireGitTrigger>[0],
  actor: string,
): ReturnType<typeof fireGitTrigger> {
  const { spec, project } = input;
  const sessionId = spec.pinnedSessionId;
  const outcome = sessionId
    ? await enqueueTriggerPrompt({
        project, sessionId, actor, text: reminderPromptText(spec), source: 'reminder',
        triggerSlug: spec.slug, model: null,
        idempotencyKey: input.idempotencyKey ?? null,
      })
    : 'no-session';
  if (outcome === 'queued') {
    return { status: 'queued', sessionId: sessionId!, reason: 'prompt queued for delivery' };
  }
  await disableSessionReminder(project.projectId, spec.slug, new Date());
  return {
    status: 'failed',
    error: 'The reminder session is deleted or failed, so the reminder is now paused',
    errorCode: 'reminder_session_gone',
  };
}

async function queueExistingTriggerSession(
  input: Parameters<typeof fireGitTrigger>[0],
  actor: string,
  sessionKey: string | null,
): Promise<string | null> {
  const { spec, project, renderedPrompt, source } = input;
  const queue = async (sessionId: string) =>
    enqueueTriggerPrompt({
      project, sessionId, actor, text: renderedPrompt, source,
      triggerSlug: spec.slug, model: spec.model,
      idempotencyKey: input.idempotencyKey ?? null,
    });

  // Session pinning — when a trigger opts into `session_mode = "pinned"`, always
  // re-prompt the EXACT session the user chose (`spec.pinnedSessionId`), not
  // "whatever this trigger last created" (that's `reuse`). If the pinned session
  // is gone/unresumable we degrade gracefully: fall through to the `reuse` block
  // (the trigger's own last session), then to a brand-new session.
  if (spec.sessionMode === 'pinned' && spec.pinnedSessionId) {
    const outcome = await queue(spec.pinnedSessionId);
    if (outcome === 'queued') return spec.pinnedSessionId;
    // outcome === 'no-session' | 'failed' → pinned session is gone/unusable;
    // fall through to the reuse/create fallback below.
  }

  // Session reuse — when a trigger opts into `session_mode = "reuse"`, re-prompt
  // the canonical session this trigger already created (resuming its sandbox +
  // opencode root) so ONE long-lived session accumulates context across fires,
  // instead of minting a brand-new session every time. If no reusable session
  // exists yet, or the last one is gone/failed, we fall through to createSession
  // below and that fresh session becomes the canonical one for next time. Also
  // the graceful-degradation path for a `pinned` trigger whose pin is dead.
  // Session keying — `session_mode = "keyed"` is `reuse` bucketed by a value
  // rendered from the payload, so one trigger drives one session PER chat /
  // customer / repo. A key that renders empty falls through to a fresh session
  // rather than blending every keyless delivery into a shared one.
  if (sessionKey) {
    const keyed = await findKeyedTriggerSession(project.projectId, spec.slug, sessionKey);
    if (keyed) {
      const outcome = await queue(keyed.sessionId);
      if (outcome === 'queued') return keyed.sessionId;
      // Unusable session for this key → fall through and create a fresh one,
      // which becomes the canonical session for the key going forward.
    }
  }

  if (spec.sessionMode === 'reuse' || spec.sessionMode === 'pinned') {
    const reusable = await findReusableTriggerSession(project.projectId, spec.slug);
    if (reusable) {
      const outcome = await queue(reusable.sessionId);
      if (outcome === 'queued') {
        // The prompt is durably queued (drain retries until delivered or
        // dead-letters loudly) — treat as a successful fire so the scheduler
        // records last_fired_at and doesn't immediately create a dupe.
        return reusable.sessionId;
      }
      // outcome === 'no-session' | 'failed' → canonical session is unusable;
      // fall through to create a fresh one below.
    }
  }
  return null;
}

async function createGitTriggerSession(
  input: Parameters<typeof fireGitTrigger>[0],
  actor: string,
  sessionKey: string | null,
): ReturnType<typeof fireGitTrigger> {
  const { spec, project, payload, renderedPrompt, source } = input;
  const sessionResult = await createSession({
    source: `trigger:${source}`,
    project,
    userId: actor,
    requestingPrincipalType: 'human',
    enforceAccountCap: false,
    // Fail closed until the post-create action resolves the trigger's current
    // account-local policy. Queued creates resolve it when the worker runs.
    visibility: 'private',
    request: input.request,
    queuePolicy: 'on_backpressure',
    idempotencyKey: input.idempotencyKey ?? null,
    body: {
      agent_name: spec.agent,
      initial_prompt: renderedPrompt,
      // A trigger-level model pins this run's session to that model, taking
      // precedence over the agent/account/platform default chain. Omitted
      // (null) leaves resolution to that chain — see GitTriggerSpec.model.
      ...(spec.model ? { opencode_model: spec.model } : {}),
      metadata: {
        trigger_source: source,
        trigger_kind: 'git',
        trigger_slug: spec.slug,
        trigger_type: spec.type,
        // Stamped so findKeyedTriggerSession can route the NEXT delivery for
        // this key back into this session.
        ...(sessionKey ? { trigger_session_key: sessionKey } : {}),
      },
    },
    metadata: {
      trigger_source: source,
      trigger_kind: 'git',
      trigger_slug: spec.slug,
      trigger_type: spec.type,
      ...(sessionKey ? { trigger_session_key: sessionKey } : {}),
      payload_summary: summarizeTriggerPayload(payload),
    },
    postCreate: [
      {
        type: 'apply_trigger_session_access',
        triggerSlug: spec.slug,
      },
    ],
  });

  if (sessionResult.status === 'queued' || sessionResult.status === 'pending') {
    return {
      status: 'queued',
      commandId: sessionResult.commandId,
      sessionId: sessionResult.sessionId,
      reason: sessionResult.reason,
      deduped: sessionResult.deduped,
    };
  }
  if (sessionResult.error) {
    // `body.code` is the machine-readable rejection reason (billing gate carries
    // `insufficient_credits` / `subscription_required` / `no_account`). Preserve
    // it so a credit blackout is distinguishable from a transient fire failure,
    // and so `executeTriggerExecution` can treat a permanent rejection as
    // terminal instead of retrying it five times.
    const code = typeof sessionResult.error.body.code === 'string'
      ? sessionResult.error.body.code
      : undefined;
    return {
      status: 'failed',
      error: String(sessionResult.error.body.error ?? 'Failed to create trigger session'),
      errorCode: code,
    };
  }
  const firedSessionId = sessionResult.sessionId ?? sessionResult.row?.sessionId;
  return {
    status: 'fired',
    sessionId: firedSessionId,
    commandId: sessionResult.commandId,
    deduped: sessionResult.deduped,
  };
}

export function summarizeTriggerPayload(payload: Record<string, unknown>): Record<string, unknown> {
  // Strip the rendered body from session metadata — sessions already get the
  // prompt through the authenticated first-turn claim, and we don't want a
  // second copy in trigger metadata.
  const { rendered_body: _r, ...rest } = payload as Record<string, unknown>;
  return rest;
}
