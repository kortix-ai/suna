import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, chatThreads } from '@kortix/db';
import { db } from '../../shared/db';

/**
 * Bind a Slack thread to a session so later replies in that thread route back into
 * the session (the platform's `follow_up` path keys off a `chat_threads` row via
 * `threadIsOwned`). This is the exact write the inbound `bind_chat_thread`
 * post-create action performs — factored out here so a run that created a thread
 * out of band (e.g. a webhook/cron trigger posting an approval request) can register
 * its own thread on demand via `slack bind-thread`.
 */
export async function bindChatThread(input: {
  projectId: string;
  workspaceId: string;
  threadId: string;
  sessionId: string;
  platform?: string;
}): Promise<void> {
  await db
    .insert(chatThreads)
    .values({
      projectId: input.projectId,
      platform: input.platform ?? 'slack',
      workspaceId: input.workspaceId,
      threadId: input.threadId,
      sessionId: input.sessionId,
    })
    .onConflictDoNothing({
      target: [chatThreads.platform, chatThreads.workspaceId, chatThreads.threadId],
    });
}

/**
 * Resolve the Slack workspace/team id for a channel from its project binding
 * (`chat_channel_bindings`). Returns null when the channel isn't bound to the
 * project yet.
 */
export async function resolveWorkspaceIdForChannel(
  projectId: string,
  channelId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ workspaceId: chatChannelBindings.workspaceId })
    .from(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, 'slack'),
        eq(chatChannelBindings.projectId, projectId),
        eq(chatChannelBindings.channelId, channelId),
      ),
    )
    .limit(1);
  return row?.workspaceId ?? null;
}
