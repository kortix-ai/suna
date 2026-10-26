/**
 * The conversation core: how one admitted chat message reaches a session.
 *
 * A chat platform plugs in as a `ChannelPort` (what the platform does at each
 * step) and hands the core one `ChannelMessage` per inbound message (which
 * conversation, which project, which persisted keys). The adapter keeps what
 * only its platform has: webhook verification and intake, the sender gate,
 * commands, typing, the prompt text and the copy of every notice.
 *
 *   a known thread       → a follow-up into its session
 *   its session is gone  → forget the thread, start a new session ("revived")
 *   a new thread         → claim the first create, start one session bound to it;
 *                          a racing message waits for that session and follows up
 *
 * Telegram and Email run on it. Slack and Teams still route themselves.
 */
import { chatEventDedup, projects } from '@kortix/db';
import { and, eq, sql } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { createSession, deliverThroughQueue, resolveProjectAutomationActor } from '../../projects/surface';
import { db } from '../../shared/db';
import { type ChatThreadKey, dropChatThread, findChatThread, touchChatThread } from './threads';

type CreateCommand = Parameters<typeof createSession>[0];
type CreateError = NonNullable<Awaited<ReturnType<typeof createSession>>['error']>;

/** One admitted inbound message: built by the adapter after its own sender gate and commands. */
export interface ChannelMessage {
  /** The conversation (`chat_threads` key, unique across projects). */
  thread: ChatThreadKey;
  projectId: string;
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
    claim: string;
  };
}

/** What one chat platform does at each step of the core. */
export interface ChannelPort<M extends ChannelMessage> {
  /** The session `source`, `metadata.source` and `chat_threads.platform`. */
  source: CreateCommand['source'];
  /** The text the session receives for this message. `revived`: the thread's earlier session is gone. */
  prompt(message: M, kind: 'new' | 'revived' | 'follow-up'): string;
  /** Runs before a follow-up reaches an existing session; false drops the message. */
  beforeFollowUp?(message: M, sessionId: string): Promise<boolean>;
  /** How the thread's session starts, or null to drop the message (the adapter logs why). */
  planCreate(message: M, project: CreateCommand['project']): Promise<ChannelSessionPlan | null>;
  /** Tell the sender an outcome the agent will not report itself. The adapter owns the copy and may stay silent. */
  notify(message: M, notice: ChannelNotice): Promise<void>;
}

export type ChannelSessionPlan = Pick<CreateCommand, 'body' | 'visibility' | 'metadata' | 'extraEnvVars' | 'mayManageSystemConnections'> & {
  /** Who the session runs as. Omitted: the project's automation actor. */
  userId?: string;
};

export type ChannelNotice =
  /** The thread's session refused the message (a failed session), on the last attempt. */
  | { kind: 'follow_up_failed' }
  /** The create went to the lifecycle queue; its drain binds the thread and delivers the prompt. */
  | { kind: 'create_pending' }
  /** Another message's create still holds the thread, on the last attempt. */
  | { kind: 'create_in_flight' }
  | { kind: 'create_failed'; error: CreateError };

export type ChannelRoute =
  | { kind: 'followed_up'; sessionId: string }
  | { kind: 'created'; sessionId: string }
  | { kind: 'pending' }
  | { kind: 'failed' }
  | { kind: 'dropped' };

/** Up to 8 s for a racing message's create to bind the thread. */
const WAIT_POLL_MS = 250;
const WAIT_POLLS = 32;
/** A claim outlives a create that never finishes (a crash) by at most this long. */
const CLAIM_TTL_MS = 10 * 60_000;

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
 * on `finalAttempt`: the sender is told there instead (a transport without
 * retries passes `finalAttempt: true`).
 */
export async function routeChannelMessage<M extends ChannelMessage>(
  port: ChannelPort<M>,
  message: M,
  run: { finalAttempt: boolean },
): Promise<ChannelRoute> {
  const existing = await findChatThread(message.thread);
  if (existing) {
    const followed = await followUp(port, message, existing.sessionId, run);
    if (followed) return followed;
    await dropChatThread(message.thread);
  }

  const [project] = await db.select().from(projects).where(eq(projects.projectId, message.projectId)).limit(1);
  const plan = project ? await port.planCreate(message, project) : null;
  if (!project || !plan) return { kind: 'dropped' };
  const userId = plan.userId ?? (await lifecycle.resolveProjectAutomationActor(project.accountId));
  if (!userId) {
    logger.warn('[channel] no automation actor for the project', { source: port.source, projectId: project.projectId });
    return { kind: 'dropped' };
  }

  const claim = await claimThreadCreate(message.keys.claim);
  if (!claim) {
    const sessionId = await waitForThreadSession(message.thread);
    if (sessionId) return (await followUp(port, message, sessionId, run)) ?? { kind: 'dropped' };
    if (!run.finalAttempt) throw new Error(`${port.source} thread create in flight`);
    await port.notify(message, { kind: 'create_in_flight' });
    return { kind: 'failed' };
  }

  const { userId: _planUser, body, metadata, ...rest } = plan;
  let result: Awaited<ReturnType<typeof createSession>>;
  try {
    result = await lifecycle.createSession({
      ...rest,
      source: port.source,
      project,
      userId,
      requestingPrincipalType: 'human',
      body: { base_ref: project.defaultBranch, ...body },
      metadata: { source: port.source, ...metadata },
      queuePolicy: 'on_backpressure',
      idempotencyKey: message.keys.create,
      postCreate: [
        { type: 'bind_chat_thread', ...message.thread },
        { type: 'deliver_prompt', source: port.source, text: port.prompt(message, existing ? 'revived' : 'new'), userId },
      ],
    });
  } catch (error) {
    // Free the thread so the transport's retry creates under the same key,
    // instead of waiting for a thread this attempt may never bind.
    await releaseThreadCreate(message.keys.claim, claim);
    throw error;
  }

  if (result.sessionId && !result.error) {
    // The create bound the thread: later messages find it, so the claim is spent.
    await releaseThreadCreate(message.keys.claim, claim);
    return { kind: 'created', sessionId: result.sessionId };
  }
  if (!result.error || result.requeued) {
    // ponytail: the claim stays until the drain's create; a session that dies
    // before the claim expires blocks a new one for up to CLAIM_TTL_MS.
    await port.notify(message, { kind: 'create_pending' });
    return { kind: 'pending' };
  }
  // Final for this message: free the thread so a corrected re-send starts at once.
  logger.warn('[channel] session create failed', { source: port.source, projectId: project.projectId, status: result.error.status });
  await releaseThreadCreate(message.keys.claim, claim);
  await port.notify(message, { kind: 'create_failed', error: result.error });
  return { kind: 'failed' };
}

/** Forget a conversation (a `/new` command): the next message starts a new session. */
export async function forgetChatThread(thread: ChatThreadKey, claimKey: string): Promise<void> {
  await dropChatThread(thread);
  // Its create claim too, or the next message waits on it. A create still in
  // flight may then race that message: two sessions, for a reset the sender asked for.
  await db.delete(chatEventDedup).where(eq(chatEventDedup.eventId, claimKey));
}

/** Null when the session is gone, so the caller starts a new one. */
async function followUp<M extends ChannelMessage>(
  port: ChannelPort<M>,
  message: M,
  sessionId: string,
  run: { finalAttempt: boolean },
): Promise<ChannelRoute | null> {
  if (port.beforeFollowUp && !(await port.beforeFollowUp(message, sessionId))) return { kind: 'dropped' };
  const delivery = await lifecycle.deliverThroughQueue({
    source: port.source,
    idempotencyKey: message.keys.followUp,
    projectId: message.projectId,
    sessionId,
    text: port.prompt(message, 'follow-up'),
  });
  if (delivery === 'delivered' || delivery === 'queued') {
    await touchChatThread(message.thread);
    return { kind: 'followed_up', sessionId };
  }
  if (delivery === 'no-session') return null;
  if (!run.finalAttempt) throw new Error(`${port.source} follow-up ${delivery}`);
  await port.notify(message, { kind: 'follow_up_failed' });
  return { kind: 'failed' };
}

/**
 * Claim the first create of a thread. An expired claim (a create that never
 * finished) is taken over in the same statement. Returns the owner token for
 * `releaseThreadCreate`, or null while another create holds it.
 */
async function claimThreadCreate(key: string): Promise<Date | null> {
  const expiresAt = new Date(Date.now() + CLAIM_TTL_MS);
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

async function waitForThreadSession(thread: ChatThreadKey): Promise<string | null> {
  for (let poll = 0; ; poll++) {
    const row = await findChatThread(thread);
    if (row) return row.sessionId;
    if (poll === WAIT_POLLS) return null;
    await lifecycle.sleep(WAIT_POLL_MS);
  }
}
