/**
 * The session-addressed half of the conversation core (conversation.ts holds the
 * inbound half). It tells the chat a session talks in about an outcome the agent
 * cannot report: its run ended in an error, or its sandbox did not start (or is
 * still being retried).
 *
 * The chat is the session's newest `chat_threads` row on a platform whose
 * adapter registered a port, while the project's install still names the
 * workspace that bound it. No such row reaches nothing: a session no chat
 * started, a chat that was reset (forgetChatThread drops its row), a removed or
 * replaced install. Session metadata is never read: it outlives a reset. A
 * platform that renders through a live turn (channels/turn-relay.ts), or that
 * must not message its sender, registers no port.
 */
import { chatEventDedup, chatInstalls, chatThreads } from '@kortix/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { registerSessionFailureNotifier } from '../../shared/session-failure-notifier';
import type { ChannelPlatform, ChannelPort, ChannelTarget, SessionNotice } from './conversation';

// replica-local: ports are code; each adapter registers its own at import.
const SESSION_PORTS = new Map<ChannelPlatform, ChannelPort>();

/** A platform's port for session-addressed notices. */
export function registerSessionPort(platform: ChannelPlatform, port: ChannelPort): void {
  SESSION_PORTS.set(platform, port);
}

/** How long a once-per-session notice stays claimed: longer than any retry ladder. */
const ONCE_TTL_MS = 24 * 60 * 60_000;

/**
 * Tell the session's chat an outcome. `once`: a key that lets the notice reach
 * the chat once (claimed only when the session has a chat). Never throws: a
 * notice must not fail the turn end or the provisioning cleanup that sends it.
 */
export async function notifySessionChannel(notice: SessionNotice, opts: { once?: string } = {}): Promise<void> {
  try {
    const chat = await findSessionChat(notice.sessionId);
    if (!chat) return;
    // A turn another surface prompted (the web, a reminder) is not the chat's to hear.
    if (notice.kind === 'run_failed' && notice.promptSource && notice.promptSource !== chat.target.platform) return;
    if (opts.once && !(await claimOnce(opts.once))) return;
    await chat.port.notify(chat.target, notice);
  } catch (error) {
    logger.warn('[channel] session notice failed', { sessionId: notice.sessionId, kind: notice.kind, error: String(error) });
  }
}

/** The session's chat and its port, or null (see the header). */
async function findSessionChat(sessionId: string): Promise<{ target: ChannelTarget; port: ChannelPort } | null> {
  const [row] = await db
    .select({
      platform: chatThreads.platform,
      workspaceId: chatThreads.workspaceId,
      threadId: chatThreads.threadId,
      projectId: chatThreads.projectId,
    })
    .from(chatThreads)
    .innerJoin(
      chatInstalls,
      and(
        eq(chatInstalls.platform, chatThreads.platform),
        eq(chatInstalls.workspaceId, chatThreads.workspaceId),
        eq(chatInstalls.projectId, chatThreads.projectId),
      ),
    )
    .where(and(eq(chatThreads.sessionId, sessionId), inArray(chatThreads.platform, [...SESSION_PORTS.keys()])))
    .orderBy(desc(chatThreads.lastMessageAt))
    .limit(1);
  const port = row ? SESSION_PORTS.get(row.platform as ChannelPlatform) : undefined;
  return row && port ? { target: { ...row, platform: row.platform as ChannelPlatform }, port } : null;
}

async function claimOnce(key: string): Promise<boolean> {
  const rows = await db
    .insert(chatEventDedup)
    .values({ eventId: key, expiresAt: new Date(Date.now() + ONCE_TTL_MS) })
    .onConflictDoNothing({ target: chatEventDedup.eventId })
    .returning({ eventId: chatEventDedup.eventId });
  return rows.length > 0;
}

/**
 * The provisioning-failure notifier (shared/session-failure-notifier.ts).
 * - `failure.transient`: `/start` and a queued prompt re-attempt it
 *   (session-open-provision.ts `retryTransientProvisionFailure`), so the session
 *   may still start. Say so once: every retry fails through here again, and the
 *   retries give up silently after a few minutes.
 * - `failure` set: `message` is the classified user-facing reason
 *   (platform/services/sandbox-provisioning-error.ts).
 * - `failure` absent: the kick-off path (projects/lib/session-create.ts); `message`
 *   is raw internal text and is not posted.
 */
export async function notifyStartFailure(
  sessionId: string,
  message: string,
  failure?: { transient: boolean },
): Promise<void> {
  if (failure?.transient) {
    await notifySessionChannel({ kind: 'start_retrying', sessionId, reason: message }, { once: `channel:start-retrying:${sessionId}` });
    return;
  }
  await notifySessionChannel({ kind: 'start_failed', sessionId, reason: failure ? message : null });
}

registerSessionFailureNotifier(notifyStartFailure);
