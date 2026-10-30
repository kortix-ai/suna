import { servableProjectCatalog } from '../../llm-gateway/models/servable-catalog';
import { toOpencodeModelRef } from '../../llm-gateway/resolution/effective';
import type { PromptOverridesWire } from '../session-lifecycle/store';
import { projectSessions, projectTriggerRuntime } from '@kortix/db';
import { privateSpaceMemberIds } from '../../shared/space-access';
import { liveTriggerSpace, triggerRunSpace } from './trigger-space';
import { and, desc, eq, ne, sql } from 'drizzle-orm';
import { db } from '../../shared/db';
import { createSession, drainSessionLifecycleQueue, enqueueContinueSessionCommand, resolveProjectAutomationActor } from '../session-lifecycle';
import type { GitTriggerSpec } from '../triggers';
import type { ProjectRow, RequestAuditContext } from './serializers';
import { renderSessionKey } from './trigger-payload';
import { keepRunFailure } from '../trigger-execution-store';
import { TRIGGER_REUSE_RETIRED_AT } from './trigger-run-outcome';
import { disableSessionReminder, reminderPromptText } from './session-reminders';
import { accountMemberRow } from '../../iam/membership-read';
import type { TriggerFireSource } from './trigger-webhook-auth';
import { claimTriggerCreate, releaseTriggerCreate, triggerCreateKey } from './trigger-create-claim';
import { alertTriggerAutoPaused, alertTriggerThrottled, clearTriggerAlert } from './trigger-alerts';
import { autoPauseTrigger, readTriggerAutoPause, triggerAutoPauseReason, triggerRunCapVerdict } from './trigger-run-caps';
import { triggerChecksOverlap, triggerOverlapReason } from './trigger-overlap';

/**
 * Find a user we can attribute trigger-spawned sessions to. Git-backed
 * triggers don't have a `created_by` like the DB-backed ones do — we pick
 * the account's first owner as a stable, audit-friendly stand-in.
 */

/**
 * Resolve the identity a trigger's automated session PROVISIONS as — the
 * account-member stand-in `createProjectSession` needs for the provisioning/
 * authorization actor (secret-visibility subject, the
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
 * A trigger from the project's config (kortix.yaml) never posts into a private
 * channel: whoever may change the config, inside the channel or not, would
 * decide what runs there and where its output goes.
 */
export const PRIVATE_CHANNEL_TRIGGER = {
  error:
    'A trigger from the project config cannot post into a private channel: anyone who edits the config would decide what runs there. ' +
    'Move the trigger to a public channel, or set a reminder in the private thread.',
  errorCode: 'private_channel_trigger',
} as const;

/** A reminder into a private channel whose author is no longer in it. */
export const REMINDER_AUTHOR_NOT_IN_CHANNEL = {
  error: 'This reminder posts into a private channel, and the person who set it is no longer a member of that channel.',
  errorCode: 'reminder_author_not_in_channel',
} as const;

/**
 * Who a reminder acts as when its session is in `spaceId` (a reminder is set
 * through the API by someone who can open the session, so its prompt is that
 * person's, not the project config's). A public channel, a DM or no space:
 * `actor`, unchanged. A private channel: `actor` when they are a member, else
 * the reminder's owner (`owner_user_id`, who set it) while they are a member
 * of the channel and the account, else null: the fire fails with
 * {@link REMINDER_AUTHOR_NOT_IN_CHANNEL}. Never anyone else.
 */
export async function privateChannelRunActor(
  project: Pick<ProjectRow, 'projectId' | 'accountId'>,
  slug: string,
  spaceId: string | null,
  actor: string,
): Promise<string | null> {
  const members = await privateSpaceMemberIds(spaceId);
  if (!members || members.has(actor)) return actor;
  const [runtime] = await db
    .select({ ownerUserId: projectTriggerRuntime.ownerUserId })
    .from(projectTriggerRuntime)
    .where(and(eq(projectTriggerRuntime.projectId, project.projectId), eq(projectTriggerRuntime.slug, slug)))
    .limit(1);
  const owner = runtime?.ownerUserId;
  if (!owner || !members.has(owner)) return null;
  return (await accountMemberRow(project.accountId, owner))[0] ? owner : null;
}

export async function markGitTriggerFired(
  projectId: string,
  slug: string,
  when: Date,
  status: 'fired' | 'queued' = 'fired',
  opts: { endsAlert?: boolean } = {},
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
  // Only a fire that reached a session ends a fire failure streak (KRTX-1742).
  // A queued prompt or create has not reached one yet: its delivery ends it
  // (markTriggerRuntimeDelivered, or the drain's create). A caller that shows
  // a queued handoff as `fired` passes `endsAlert: false`.
  if (opts.endsAlert ?? status === 'fired') await clearTriggerAlert({ projectId, slug, source: 'fire' });
}

/**
 * Failure codes that describe the account (no usable model, no credits, no
 * subscription, no billing account), not a server fault. A fire route answers
 * them `402 { error, code }`, the billing gate's convention.
 */
export const ACCOUNT_STATE_FIRE_CODES: ReadonlySet<string> = new Set([
  'no_usable_model',
  'insufficient_credits',
  'subscription_required',
  'no_account',
]);

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
 * every model is the `kortix` provider's.
 */
export function triggerModelOverride(model: string | null | undefined): PromptOverridesWire | undefined {
  const trimmed = (model ?? '').trim();
  if (!trimmed) return undefined;
  const ref = toOpencodeModelRef(trimmed);
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
  /** `actor` is a person whose deferred prompt this is: the turn acts as them. */
  bindTurnIdentity?: boolean;
}): Promise<'queued' | 'deduped' | 'no-session' | 'failed' | 'not-in-channel' | 'private-channel'> {
  // Scoped to the trigger's own project and account. A pinned `session_id` is
  // manifest text, so a session of any other project is "no session" here and
  // the fire falls through to the trigger's own reuse/create path.
  const [session] = await db
    .select({ status: projectSessions.status, metadata: projectSessions.metadata, spaceId: projectSessions.spaceId })
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
  // The session's own channel decides, not the trigger's (a moved trigger
  // re-prompts an older run). A config trigger never prompts a private
  // channel's thread; a reminder does, as a member of it.
  let actor = input.actor;
  if (await privateSpaceMemberIds(session.spaceId)) {
    if (input.source !== 'reminder') return 'private-channel';
    const member = await privateChannelRunActor(input.project, input.triggerSlug, session.spaceId, input.actor);
    if (!member) return 'not-in-channel';
    actor = member;
  }

  const { deduped } = await enqueueContinueSessionCommand({
    source: `trigger:${input.source}`,
    projectId: input.project.projectId,
    accountId: input.project.accountId,
    sessionId: input.sessionId,
    actorUserId: actor,
    text: input.text,
    triggerSlug: input.triggerSlug,
    // Same per-due-slot key the create path uses — a fire the sweep timed out
    // on but that actually enqueued isn't duplicated when the next tick retries.
    idempotencyKey: input.idempotencyKey ?? null,
    overrides: triggerModelOverride(input.model),
    ...(input.bindTurnIdentity ? { bindTurnIdentity: true } : {}),
  });
  // The same delivery again: its prompt is already queued or delivered (KRTX-1735).
  if (deduped) return 'deduped';
  // Fast path only — the 1 s lifecycle worker is the delivery guarantee. Targeted
  // when the fire has a key: an untargeted kick delivers whichever row is oldest.
  drainSessionLifecycleQueue(
    input.idempotencyKey ? { idempotencyKey: input.idempotencyKey, burst: false } : { limit: 1 },
  ).catch(() => {});
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
  /** A person fired it (manual fire, replay): the run caps do not apply. */
  deliberate?: boolean;
}): Promise<{
  /** `skipped`: a run cap or an auto-pause (KRTX-1721) held it; `reason` says which. */
  status: 'fired' | 'queued' | 'failed' | 'skipped';
  sessionId?: string;
  commandId?: string;
  error?: string;
  /** Machine-readable failure code when `createSession` rejected the fire
   *  (e.g. `insufficient_credits`, `subscription_required`, `no_account`) or
   *  the model gate refused it (`no_usable_model`). */
  errorCode?: string;
  reason?: string;
  deduped?: boolean;
  /** A failed create went back to the lifecycle queue: the drain owns its outcome. */
  requeued?: boolean;
  /** A failed fire that a later attempt can fix (a 429 or 5xx). */
  retryable?: boolean;
}> {
  const { spec, project, payload } = input;
  // Run caps (KRTX-1721) bound what automation starts, before any session or
  // prompt work. A person's fire is never held, but it counts toward the cap.
  if (!input.deliberate) {
    const now = new Date();
    const { pausedReason, resumedAt } = await readTriggerAutoPause(project.projectId, spec.slug);
    if (pausedReason) return { status: 'skipped', reason: pausedReason };
    const held = await triggerRunCapVerdict({ projectId: project.projectId, slug: spec.slug, caps: spec, now, resumedAt });
    if (held?.sustained) {
      const reason = triggerAutoPauseReason(spec);
      if (await autoPauseTrigger(project.projectId, spec.slug, reason, now)) {
        alertTriggerAutoPaused({ projectId: project.projectId, accountId: project.accountId, slug: spec.slug, reason, pausedAt: now });
        return { status: 'skipped', reason };
      }
    }
    if (held) {
      alertTriggerThrottled({ projectId: project.projectId, accountId: project.accountId, slug: spec.slug, reason: held.reason, now });
      return { status: 'skipped', reason: held.reason };
    }
    // Overlap (KRTX-1721): a fresh run waits for the previous one to finish.
    if (triggerChecksOverlap(spec)) {
      const overlap = await triggerOverlapReason({ projectId: project.projectId, slug: spec.slug, now });
      if (overlap) return { status: 'skipped', reason: overlap };
    }
  }
  // An App target is a call to the App, not a session: no actor, model or prompt.
  if (spec.target?.app) return fireAppTarget(input, spec.target);
  // The session's owning identity (created_by / billing / audit). Automated runs
  // never impersonate a picked human — the agent's declared scope governs access.
  // See resolveTriggerActor().
  const automation = await resolveTriggerActor(project);
  if (!automation) {
    return { status: 'failed', error: 'No account owner available to own the session', retryable: false };
  }
  // A config trigger never runs into a private channel (PRIVATE_CHANNEL_TRIGGER).
  const runSpace = spec.reminder ? null : triggerRunSpace(await liveTriggerSpace(project.projectId, spec.slug), spec.agent);
  if (runSpace?.kind === 'channel' && runSpace.visibility === 'private') {
    return { status: 'failed', ...PRIVATE_CHANNEL_TRIGGER, retryable: false };
  }
  const actor = automation;

  if (spec.reminder) return fireSessionReminder(input, actor);

  const sessionKey = renderSessionKey(spec, payload);
  const queued = await queueExistingTriggerSession(input, actor, sessionKey);
  if (queued) {
    return { status: 'queued', sessionId: queued.sessionId, deduped: queued.deduped, reason: 'prompt queued for delivery' };
  }
  const createKey = triggerCreateKey({
    projectId: project.projectId,
    slug: spec.slug,
    sessionKey,
    sessionMode: spec.sessionMode,
  });
  if (!createKey) return createGitTriggerSession(input, actor, sessionKey);

  // One creator per key. A delivery that loses waits for the winner's session
  // (up to 15 s) and prompts it; if none appears it creates, as before.
  if (!(await claimTriggerCreate(createKey))) {
    for (let attempt = 0; attempt < CREATE_WAIT_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, CREATE_WAIT_POLL_MS));
      const joined = await queueExistingTriggerSession(input, actor, sessionKey);
      if (joined) {
        return { status: 'queued', sessionId: joined.sessionId, deduped: joined.deduped, reason: 'prompt queued for delivery' };
      }
    }
    return createGitTriggerSession(input, actor, sessionKey);
  }
  let result: Awaited<ReturnType<typeof createGitTriggerSession>> | undefined;
  try {
    result = await createGitTriggerSession(input, actor, sessionKey);
    return result;
  } finally {
    // A create that only queued has no session row yet: keep the claim until it
    // expires so deliveries during backpressure do not each queue another create.
    if (result?.status !== 'queued') await releaseTriggerCreate(createKey);
  }
}

/**
 * Who an agent's reminder (no `promptAuthorUserId`) runs as, for its prompt
 * and for a successor session: the session's creator while they are a member.
 * The account owner was the fallback, and the proxy refuses the owner on a
 * member's private session, so every fire of such a reminder dead-lettered. A
 * creator who is not a member (left the account, or a service account) falls
 * back to the owner.
 */
async function memberSessionCreator(project: ProjectRow, sessionId: string): Promise<string | null> {
  const [session] = await db
    .select({ createdBy: projectSessions.createdBy })
    .from(projectSessions)
    .where(and(eq(projectSessions.sessionId, sessionId), eq(projectSessions.accountId, project.accountId)))
    .limit(1);
  const createdBy = session?.createdBy;
  return createdBy && (await accountMemberRow(project.accountId, createdBy))[0] ? createdBy : null;
}

const CREATE_WAIT_ATTEMPTS = 15;
const CREATE_WAIT_POLL_MS = 1_000;

/**
 * A session reminder re-prompts its own session. A deleted session switches
 * the reminder off. A failed session hands the reminder to a successor session
 * (fireReminderSuccessor), which picks up the work its predecessor kept in Files.
 */
/** `target: { app }`: wake the App and send the payload to its path (apps/app-call.ts). */
async function fireAppTarget(
  input: Parameters<typeof fireGitTrigger>[0],
  target: NonNullable<GitTriggerSpec['target']>,
): ReturnType<typeof fireGitTrigger> {
  const { callAppTarget } = await import('../../apps/app-call');
  const result = await callAppTarget({
    projectId: input.project.projectId,
    app: target.app,
    method: target.method,
    path: target.path,
    // A target's own payload (fixed arguments, a one-off run's body) replaces the fire's.
    payload: target.payload ?? input.payload,
    headers: {
      'x-kortix-trigger': input.spec.slug,
      'x-kortix-trigger-source': input.source,
      ...(input.idempotencyKey ? { 'x-kortix-delivery-id': input.idempotencyKey } : {}),
    },
  });
  return result.ok
    ? { status: 'fired' }
    : { status: 'failed', error: result.error ?? 'App call failed', retryable: result.retryable };
}

async function fireSessionReminder(
  input: Parameters<typeof fireGitTrigger>[0],
  actor: string,
): ReturnType<typeof fireGitTrigger> {
  const { spec, project } = input;
  const sessionId = spec.pinnedSessionId;
  const author = spec.reminder?.promptAuthorUserId;
  // A person's reminder runs as that person. Once they leave the account it
  // has no one to run as: it pauses instead of firing as someone who no longer
  // has access (KRTX-1722).
  if (author && !(await accountMemberRow(project.accountId, author))[0]) {
    await disableSessionReminder(project.projectId, spec.slug, new Date());
    return {
      status: 'failed',
      error: "The reminder's author is no longer a member of this account, so the reminder is now paused",
      errorCode: 'reminder_author_left',
      retryable: false,
    };
  }
  const runAs = author ?? (sessionId ? await memberSessionCreator(project, sessionId) : null) ?? actor;
  const outcome = sessionId
    ? await enqueueTriggerPrompt({
        project, sessionId, actor: runAs, text: reminderPromptText(spec), source: 'reminder',
        triggerSlug: spec.slug, model: null,
        idempotencyKey: input.idempotencyKey ?? null,
        bindTurnIdentity: !!author,
      })
    : 'no-session';
  if (outcome === 'queued' || outcome === 'deduped') {
    return { status: 'queued', sessionId: sessionId!, deduped: outcome === 'deduped', reason: 'prompt queued for delivery' };
  }
  if (outcome === 'not-in-channel') return { status: 'failed', ...REMINDER_AUTHOR_NOT_IN_CHANNEL, retryable: false };
  // A failed box is not a decision to stop; a deleted session is. The reminder
  // carries on in a successor session, so work kept in Files outlives a box.
  if (outcome === 'failed' && sessionId) return fireReminderSuccessor(input, runAs, sessionId);
  await disableSessionReminder(project.projectId, spec.slug, new Date());
  return {
    status: 'failed',
    error: 'The reminder session is deleted or failed, so the reminder is now paused',
    errorCode: 'reminder_session_gone',
    retryable: false,
  };
}

/**
 * The reminder's session failed: start a successor that inherits its sharing
 * (as its child), hand it the reminder text, pin the reminder to it, and move
 * the failed session's chat threads to it so replies there reach it.
 */
async function fireReminderSuccessor(
  input: Parameters<typeof fireGitTrigger>[0],
  actor: string,
  failedSessionId: string,
): ReturnType<typeof fireGitTrigger> {
  const { spec, project } = input;
  const result = await createSession({
    source: 'trigger:reminder',
    project,
    userId: actor,
    requestingPrincipalType: 'human',
    callerSessionId: failedSessionId,
    request: input.request,
    queuePolicy: 'on_backpressure',
    idempotencyKey: input.idempotencyKey ?? null,
    body: {
      agent_name: spec.agent,
      initial_prompt:
        `${reminderPromptText(spec)}\n\n` +
        `This reminder belonged to session ${failedSessionId}, which failed. You continue its work: ` +
        'read what it kept in Files (/drives) before you act.',
      metadata: { reminder_successor_of: failedSessionId },
    },
    metadata: { reminder_successor_of: failedSessionId, trigger_slug: spec.slug },
    postCreate: [{ type: 'repin_reminder', reminderId: spec.slug }, { type: 'adopt_chat_threads', fromSessionId: failedSessionId }],
  });
  const successorId = result.sessionId ?? result.row?.sessionId;
  if (result.error || (result.status !== 'queued' && result.status !== 'pending' && !successorId)) {
    return {
      status: 'failed',
      error: String(result.error?.body.error ?? 'The reminder session failed and no successor session could start'),
      errorCode: 'reminder_successor_failed',
      retryable: result.retryable === true,
    };
  }
  if (result.status === 'queued' || result.status === 'pending') {
    // Paused until the queued create runs and its repin re-arms it: a fire in
    // between would find the failed session again and start a second successor.
    await disableSessionReminder(project.projectId, spec.slug, new Date());
    return { status: 'queued', sessionId: successorId, commandId: result.commandId, reason: result.reason };
  }
  return { status: 'fired', sessionId: successorId, commandId: result.commandId };
}

async function queueExistingTriggerSession(
  input: Parameters<typeof fireGitTrigger>[0],
  actor: string,
  sessionKey: string | null,
): Promise<{ sessionId: string; deduped: boolean } | null> {
  const { spec, project, renderedPrompt, source } = input;
  // The session the prompt went to, or null when that session is unusable.
  const queue = async (sessionId: string) => {
    const outcome = await enqueueTriggerPrompt({
      project, sessionId, actor, text: renderedPrompt, source,
      triggerSlug: spec.slug, model: spec.model,
      idempotencyKey: input.idempotencyKey ?? null,
    });
    return outcome === 'queued' || outcome === 'deduped' ? { sessionId, deduped: outcome === 'deduped' } : null;
  };

  // Session pinning — when a trigger opts into `session_mode = "pinned"`, always
  // re-prompt the EXACT session the user chose (`spec.pinnedSessionId`), not
  // "whatever this trigger last created" (that's `reuse`). If the pinned session
  // is gone/unresumable we degrade gracefully: fall through to the `reuse` block
  // (the trigger's own last session), then to a brand-new session.
  if (spec.sessionMode === 'pinned' && spec.pinnedSessionId) {
    const pinned = await queue(spec.pinnedSessionId);
    if (pinned) return pinned;
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
      const queuedKeyed = await queue(keyed.sessionId);
      if (queuedKeyed) return queuedKeyed;
      // Unusable session for this key → fall through and create a fresh one,
      // which becomes the canonical session for the key going forward.
    }
  }

  if (spec.sessionMode === 'reuse' || spec.sessionMode === 'pinned') {
    const reusable = await findReusableTriggerSession(project.projectId, spec.slug);
    if (reusable) {
      const queuedReuse = await queue(reusable.sessionId);
      if (queuedReuse) {
        // The prompt is durably queued (drain retries until delivered or
        // dead-letters loudly) — treat as a successful fire so the scheduler
        // records last_fired_at and doesn't immediately create a dupe.
        return queuedReuse;
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
  // A fire the account cannot run mints a session that dies on its first turn
  // ("requires a paid plan") while the caller keeps a 202 + a session id that
  // points at nothing (dogfood journey trig-webhook). Gate on the same catalog
  // the chat composer gates on: zero enabled models = nothing to run. Only
  // the fresh-create path gates — reminders and re-prompts of an existing
  // session keep their semantics.
  const catalog = await servableProjectCatalog({
    projectId: project.projectId,
    accountId: project.accountId,
    // The run executes as this actor (the account owner), so its personal
    // keys count exactly as the gateway will count them for the session.
    principalUserId: actor,
  });
  if (!Object.values(catalog.models).some((model) => model.enabled)) {
    return {
      status: 'failed',
      error: 'No usable model for this account. Connect a provider key or upgrade the plan, then fire again.',
      errorCode: 'no_usable_model',
    };
  }
  const sessionResult = await createSession({
    source: `trigger:${source}`,
    project,
    userId: actor,
    requestingPrincipalType: 'human',
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
        // The trigger's name at fire time: a channel thread shows it as the author.
        trigger_name: spec.name,
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
      trigger_name: spec.name,
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
      // A requeued create may still start a session; its run links to it by command.
      commandId: sessionResult.commandId,
      requeued: sessionResult.requeued === true,
      retryable: sessionResult.retryable === true,
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
