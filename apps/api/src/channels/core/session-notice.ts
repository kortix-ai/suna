/**
 * The session-addressed half of the conversation core (conversation.ts holds the
 * inbound half). It tells the chat a session talks in about an outcome the agent
 * cannot report: its run ended in an error, or its sandbox did not start.
 *
 * The chat is the session's newest `chat_threads` row on a platform in
 * SESSION_PORTS, while the project's install still names the bot that bound it.
 * No such row posts nothing: a web, CLI, trigger, Slack, Teams or Email session;
 * a chat that sent `/new` (forgetChatThread drops its row); a disconnected or
 * replaced bot (the install row is gone). `metadata.telegram` is never read: it
 * outlives `/new`.
 */
import { chatInstalls, chatThreads } from '@kortix/db';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { registerSessionFailureNotifier } from '../../shared/session-failure-notifier';
import type { ChannelPlatform, ChannelPort, SessionNotice } from './conversation';

/**
 * The ports a session can reach. Lazy: projects/routes imports this module, and a
 * port module imports the core and the session lifecycle. Slack and Teams render
 * through their live turn (channels/turn-relay.ts). Email is absent on purpose: it
 * sends no status mail to a sender (email/session.ts).
 */
const SESSION_PORTS: Partial<Record<ChannelPlatform, () => Promise<ChannelPort>>> = {
  telegram: async () => (await import('../telegram/session')).telegramPort,
};
const SESSION_PLATFORMS = Object.keys(SESSION_PORTS);

/** Tell the session's chat an outcome. Never throws: a notice must not fail the turn end or the provisioning cleanup that sends it. */
export async function notifySessionChannel(notice: SessionNotice): Promise<void> {
  try {
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
      .where(and(eq(chatThreads.sessionId, notice.sessionId), inArray(chatThreads.platform, SESSION_PLATFORMS)))
      .orderBy(desc(chatThreads.lastMessageAt))
      .limit(1);
    if (!row) return;
    const platform = row.platform as ChannelPlatform;
    const load = SESSION_PORTS[platform];
    if (!load) return;
    await (await load()).notify({ ...row, platform }, notice);
  } catch (error) {
    logger.warn('[channel] session notice failed', { sessionId: notice.sessionId, kind: notice.kind, error: String(error) });
  }
}

/**
 * The provisioning-failure notifier (shared/session-failure-notifier.ts).
 * - `failure.transient`: `/start` and a queued prompt re-attempt it
 *   (session-open-provision.ts `retryTransientProvisionFailure`), so the session
 *   may still start: say nothing.
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
  if (failure?.transient) return;
  await notifySessionChannel({ kind: 'start_failed', sessionId, reason: failure ? message : null });
}

registerSessionFailureNotifier(notifyStartFailure);
