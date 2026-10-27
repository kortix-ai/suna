/**
 * The conversation core: how one admitted chat message reaches a session.
 *
 * A chat platform plugs in as a `ChannelPort`: what the platform does for the
 * core, addressed by a `ChannelTarget` (one conversation). The adapter hands
 * the core one `ChannelMessage` per inbound message: its target, its persisted
 * keys, the follow-up text and how a new session would start. The adapter
 * keeps what only its platform has: webhook verification and intake, the
 * sender gate, commands, typing, prompts and the wording of every notice.
 *
 *   a known thread       → a follow-up into its session
 *   its session is gone  → forget the thread, start a new session ("revived")
 *   a new thread         → claim the first create, start one session bound to it;
 *                          a racing message waits for that session and follows up
 *
 * Telegram and Email run on it. Slack and Teams still route themselves.
 * Session-addressed notices (a failed run, a failed start) go through session-notice.ts.
 */
import { chatEventDedup } from '@kortix/db';
import type { CHANNEL_PLATFORMS } from '@kortix/manifest-schema';
import { and, eq, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { createSession, deliverThroughQueue, resolveProjectAutomationActor } from '../../projects/surface';
import { db } from '../../shared/db';
import type { TurnErrorInfo } from '../slack/errors';
import { type ChatThreadKey, dropChatThread, findChatThread, touchChatThread } from './threads';

type CreateError = NonNullable<Awaited<ReturnType<typeof createSession>>['error']>;

/** `chat_threads.platform` = `metadata.source` = the lifecycle `source` of a channel session. */
export type ChannelPlatform = (typeof CHANNEL_PLATFORMS)[number];

/** One conversation, and the inbound message an answer anchors to. */
export interface ChannelTarget extends ChatThreadKey {
  platform: ChannelPlatform;
  /** Follow-ups are confined to it; ports read the install's secrets with it. */
  projectId: string;
  /**
   * The inbound message a notice answers (a Telegram `message_id`, an email id).
   * Absent on a target found from a session (session-notice.ts): `chat_threads`
   * keeps no message id, so that notice is posted unanchored.
   */
  messageId?: string;
}

/** An outcome the agent will not report itself. The port words it, or stays silent. */
export type ChannelNotice =
  /** The create went to the lifecycle queue; its drain binds the thread and delivers the prompt. */
  | { kind: 'create_pending' }
  /** Last attempt: another message's create still holds the thread. */
  | { kind: 'create_in_flight' }
  /** The create failed for good; the thread is free again. */
  | { kind: 'create_failed'; error: CreateError }
  /** Last attempt: the thread's session refused the message (a failed session). */
  | { kind: 'follow_up_failed' }
  /** Session-addressed: a root turn closed in a non-abort error that no Slack or Teams turn carried. */
  | { kind: 'run_failed'; sessionId: string; error?: TurnErrorInfo }
  /**
   * Session-addressed: the session's sandbox failed to start for a reason a retry
   * does not clear, and the session is `failed`. `reason`: the classified
   * user-facing cause, or null when only internal text exists.
   */
  | { kind: 'start_failed'; sessionId: string; reason: string | null };

/** The notices a port receives with a target found from a session (session-notice.ts). */
export type SessionNotice = Extract<ChannelNotice, { sessionId: string }>;

/** What one chat platform does for the core. */
export interface ChannelPort {
  /** Tell the conversation an outcome. Send errors are logged, not thrown. */
  notify(target: ChannelTarget, notice: ChannelNotice): Promise<void>;
  /** Runs before every follow-up into an existing session; false drops the message (the port logs why). */
  prepareFollowUp?(target: ChannelTarget, thread: { sessionId: string; projectId: string }): Promise<boolean>;
}

/** One verified, deduped, sender-gated inbound message. */
export interface ChannelMessage {
  target: ChannelTarget;
  /**
   * Persisted strings, supplied by the adapter so the core never changes one.
   * The lifecycle keeps both idempotency keys forever: a new format for a
   * message already in flight delivers it twice.
   */
  keys: {
    /** `deliverThroughQueue` idempotency key of this message. */
    followUp: string;
    /** `createSession` idempotency key of this message. */
    create: string;
    /** `chat_event_dedup` key that lets one message per thread create its session. */
    createClaim: string;
  };
  followUp: { text: string };
  /** How the thread's session starts. `revived`: its earlier session is gone. Null drops the message (the adapter logs why). */
  plan(revived: boolean): Promise<ChannelSessionPlan | null>;
}

export interface ChannelSessionPlan {
  project: Parameters<typeof createSession>[0]['project'];
  /** Who the session runs as. Omitted: the project's automation actor. */
  userId?: string;
  visibility: 'project' | 'private';
  /** The core adds `base_ref` first. */
  body: Record<string, unknown>;
  /** The platform block; the core adds `source` first. */
  metadata: Record<string, unknown>;
  extraEnvVars?: Record<string, string>;
  mayManageSystemConnections?: boolean;
  /** The first prompt, delivered once the session is bound to the thread. */
  prompt: string;
}

/** Up to 8 s for a racing message's create to bind the thread. */
const CREATE_WAIT_POLL_MS = 250;
const CREATE_WAIT_POLLS = 32;
/** A claim outlives a create that never finishes (a crash) by at most this long. */
const CREATE_CLAIM_TTL_MS = 10 * 60_000;

const defaultLifecycle = {
  createSession,
  deliverThroughQueue,
  resolveProjectAutomationActor,
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
};
let lifecycle = defaultLifecycle;

export function setChannelLifecycleForTest(overrides: Partial<typeof defaultLifecycle>): void {
  lifecycle = { ...defaultLifecycle, ...overrides };
}

export function resetChannelLifecycleForTest(): void {
  lifecycle = defaultLifecycle;
}

/**
 * Route one admitted message. Throws to ask the transport for a retry, never
 * on `finalAttempt`: the conversation is told there instead (a transport
 * without retries passes `finalAttempt: true`).
 */
export async function routeChannelMessage(
  port: ChannelPort,
  message: ChannelMessage,
  run: { finalAttempt: boolean },
): Promise<void> {
  const { target, keys } = message;
  const existing = await findChatThread(target);
  if (existing) {
    if ((await followUp(port, message, existing, run)) !== 'no-session') return;
    // Its session is gone, or it belongs to another project. Drop only that
    // mapping: a racing message may have bound a new session since our read.
    await dropChatThread(target, existing.sessionId);
  }

  const plan = await message.plan(existing !== null);
  if (!plan) return;
  const userId = plan.userId ?? (await lifecycle.resolveProjectAutomationActor(plan.project.accountId));
  if (!userId) {
    logger.warn('[channel] no automation actor for the project', { platform: target.platform, projectId: target.projectId });
    return;
  }

  const claim = await claimThreadCreate(keys.createClaim);
  if (!claim) {
    const thread = await waitForThreadSession(target);
    if (thread) {
      await followUp(port, message, thread, run);
      return;
    }
    if (!run.finalAttempt) throw new Error(`${target.platform} thread create in flight`);
    logger.warn('[channel] a racing create never bound the thread', { platform: target.platform, projectId: target.projectId });
    await port.notify(target, { kind: 'create_in_flight' });
    return;
  }
  // A racing message may have bound the thread and released its claim between
  // our lookup and our claim (a create binds before it releases): follow up
  // into that session instead of starting a second one.
  const bound = await findChatThread(target);
  if (bound) {
    await releaseThreadCreate(keys.createClaim, claim);
    await followUp(port, message, bound, run);
    return;
  }

  let result: Awaited<ReturnType<typeof createSession>>;
  try {
    result = await lifecycle.createSession({
      source: target.platform,
      project: plan.project,
      userId,
      requestingPrincipalType: 'human',
      body: { base_ref: plan.project.defaultBranch, ...plan.body },
      visibility: plan.visibility,
      metadata: { source: target.platform, ...plan.metadata },
      ...(plan.extraEnvVars ? { extraEnvVars: plan.extraEnvVars } : {}),
      ...(plan.mayManageSystemConnections ? { mayManageSystemConnections: true } : {}),
      queuePolicy: 'on_backpressure',
      idempotencyKey: keys.create,
      postCreate: [
        { type: 'bind_chat_thread', platform: target.platform, workspaceId: target.workspaceId, threadId: target.threadId },
        { type: 'deliver_prompt', source: target.platform, text: plan.prompt, userId },
      ],
    });
  } catch (error) {
    // Free the thread so the transport's retry creates under the same key,
    // instead of waiting for a thread this attempt never bound.
    await releaseThreadCreate(keys.createClaim, claim);
    throw error;
  }

  if (result.sessionId && !result.error) {
    // The create bound the thread: later messages find it, so the claim is spent.
    await releaseThreadCreate(keys.createClaim, claim);
    return;
  }
  if (!result.error || result.requeued) {
    // ponytail: the claim stays until it expires; the drain binds the thread but
    // never releases it, so a session that dies within 10 min of a queued create
    // blocks a new one until then. Fix: a release post-create action.
    await port.notify(target, { kind: 'create_pending' });
    return;
  }
  // Final for this message: free the thread so a corrected re-send starts at once.
  logger.warn('[channel] session create failed', {
    platform: target.platform,
    projectId: target.projectId,
    status: result.error.status,
    code: result.error.body.code,
  });
  await releaseThreadCreate(keys.createClaim, claim);
  await port.notify(target, { kind: 'create_failed', error: result.error });
}

/** Forget a conversation (a `/new` command): the next message starts a new session. */
export async function forgetChatThread(target: ChannelTarget, createClaim: string): Promise<void> {
  await dropChatThread(target);
  // Its create claim too, or the next message waits on it. A create still in
  // flight may then race that message: two sessions, for a reset the sender asked for.
  await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, createClaim));
}

async function followUp(
  port: ChannelPort,
  { target, keys, followUp: { text } }: ChannelMessage,
  thread: { sessionId: string; projectId: string },
  run: { finalAttempt: boolean },
): Promise<Awaited<ReturnType<typeof deliverThroughQueue>> | 'refused'> {
  if (port.prepareFollowUp && !(await port.prepareFollowUp(target, thread))) return 'refused';
  const outcome = await lifecycle.deliverThroughQueue({
    source: target.platform,
    idempotencyKey: keys.followUp,
    projectId: target.projectId,
    sessionId: thread.sessionId,
    text,
  });
  if (outcome === 'delivered' || outcome === 'queued') await touchChatThread(target);
  if (outcome === 'failed') {
    if (!run.finalAttempt) throw new Error(`${target.platform} follow-up failed`);
    logger.warn('[channel] the thread session refused the message', { platform: target.platform, sessionId: thread.sessionId });
    await port.notify(target, { kind: 'follow_up_failed' });
  }
  return outcome;
}

/**
 * Claim the first create of a thread. An expired claim (a create that never
 * finished) is taken over in the same statement. Returns the owner token for
 * `releaseThreadCreate`, or null while another create holds it. A DB error
 * throws: no create runs unclaimed.
 */
async function claimThreadCreate(key: string): Promise<Date | null> {
  const expiresAt = new Date(Date.now() + CREATE_CLAIM_TTL_MS);
  const rows = await db
    .insert(chatEventDedup)
    .values({ eventId: key, expiresAt })
    .onConflictDoUpdate({
      target: chatEventDedup.eventId,
      set: { expiresAt },
      setWhere: sql`${chatEventDedup.expiresAt} < now()`,
    })
    .returning({ eventId: chatEventDedup.eventId });
  return rows.length > 0 ? expiresAt : null;
}

/** Release only our own claim: after a takeover, the row belongs to the new owner. */
async function releaseThreadCreate(key: string, token: Date): Promise<void> {
  await db.delete(chatEventDedup).where(and(eq(chatEventDedup.eventId, key), eq(chatEventDedup.expiresAt, token)));
}

async function waitForThreadSession(thread: ChatThreadKey): Promise<{ sessionId: string; projectId: string } | null> {
  for (let poll = 0; ; poll++) {
    const row = await findChatThread(thread);
    if (row) return row;
    if (poll === CREATE_WAIT_POLLS) return null;
    await lifecycle.sleep(CREATE_WAIT_POLL_MS);
  }
}
