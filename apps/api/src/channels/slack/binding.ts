import { and, eq } from 'drizzle-orm';
import { chatChannelBindings } from '@kortix/db';
import { db } from '../../shared/db';

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
