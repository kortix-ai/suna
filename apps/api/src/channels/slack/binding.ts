import { and, eq, inArray } from 'drizzle-orm';
import { chatChannelBindings, chatThreads, projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { bindChatThread, findChatThread } from '../core/threads';
import { provenSlackWorkspaces } from './inbound';

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

/** Who owns a Slack thread after a bind attempt. Wire shape for the agent. */
export type SlackThreadBinding =
  | { bound: true; thread_ts: string; session_id: string; rebound_from?: string }
  | {
      bound: false;
      thread_ts: string;
      reason:
        | 'thread_bound_to_another_session'
        | 'thread_owned_by_another_user'
        | 'thread_owned_by_another_project'
        | 'workspace_unknown';
      /** The owning session, only when it is in the caller's project. */
      owner_session_id?: string;
    };

/**
 * Bind a Slack thread to a session, so a human reply in the thread is
 * delivered into that session instead of spawning a new one. First mapping
 * wins: a thread that already belongs to another session keeps it, unless
 * `force` moves it. `force` moves a thread only between two sessions of the
 * same project created by the same user: taking over another person's thread
 * would route their replies (a DM with the bot, say) into your session.
 *
 * The workspace is one the project's install proved (`chat_installs`): the
 * caller's `workspaceId` only when it is one of them, else the channel's
 * binding, else the newest install. Never the `SLACK_TEAM_ID` secret, which
 * the generic secrets API lets a project manager overwrite: a thread row in
 * another workspace would route that workspace's replies into this project.
 * Where a thread may be bound is decided before this runs
 * (connectors/channel-write-scope.ts).
 */
export async function bindSlackThreadToSession(input: {
  projectId: string;
  sessionId: string;
  channel: string;
  threadTs: string;
  workspaceId?: string | null;
  force?: boolean;
}): Promise<SlackThreadBinding> {
  const { projectId, sessionId, channel, threadTs } = input;
  const proven = await provenSlackWorkspaces(projectId);
  const wanted = input.workspaceId || (await resolveWorkspaceIdForChannel(projectId, channel)) || proven[0];
  const workspaceId = wanted && proven.includes(wanted) ? wanted : null;
  if (!workspaceId) return { bound: false, thread_ts: threadTs, reason: 'workspace_unknown' };
  const key = { platform: 'slack', workspaceId, threadId: threadTs };
  const owner = await bindChatThread({ ...key, projectId, sessionId });
  if (owner?.sessionId === sessionId) return { bound: true, thread_ts: threadTs, session_id: sessionId };
  if (!owner) return { bound: false, thread_ts: threadTs, reason: 'thread_bound_to_another_session' };
  if (owner.projectId !== projectId) {
    return { bound: false, thread_ts: threadTs, reason: 'thread_owned_by_another_project' };
  }
  if (!input.force) {
    return { bound: false, thread_ts: threadTs, reason: 'thread_bound_to_another_session', owner_session_id: owner.sessionId };
  }
  const creators = await db
    .select({ sessionId: projectSessions.sessionId, createdBy: projectSessions.createdBy })
    .from(projectSessions)
    .where(inArray(projectSessions.sessionId, [sessionId, owner.sessionId]));
  const createdBy = (id: string) => creators.find((r) => r.sessionId === id)?.createdBy ?? null;
  const mine = createdBy(sessionId);
  if (!mine || mine !== createdBy(owner.sessionId)) {
    return { bound: false, thread_ts: threadTs, reason: 'thread_owned_by_another_user', owner_session_id: owner.sessionId };
  }
  // Compare-and-set on the owner we read: a concurrent rebind wins cleanly.
  const [moved] = await db
    .update(chatThreads)
    .set({ sessionId, lastMessageAt: new Date() })
    .where(
      and(
        eq(chatThreads.platform, 'slack'),
        eq(chatThreads.workspaceId, workspaceId),
        eq(chatThreads.threadId, threadTs),
        eq(chatThreads.sessionId, owner.sessionId),
      ),
    )
    .returning({ sessionId: chatThreads.sessionId });
  if (!moved) {
    const now = await findChatThread(key);
    return { bound: false, thread_ts: threadTs, reason: 'thread_bound_to_another_session', owner_session_id: now?.sessionId };
  }
  return { bound: true, thread_ts: threadTs, session_id: sessionId, rebound_from: owner.sessionId };
}
