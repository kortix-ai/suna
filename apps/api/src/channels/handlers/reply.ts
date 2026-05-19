import type { Chat } from 'chat';
import { and, eq } from 'drizzle-orm';
import { chatThreads, projectSessions, projects, type Project } from '@kortix/db';
import { db } from '../../shared/db';
import { resolveChannel } from '../bindings';
import { spawnChannelSession } from '../spawn';
import { streamAgentResponse } from '../agent-bridge';
import { waitForSessionReady } from '../stream';
import { workspaceIdFromRaw } from '../workspace';

const RUNNING_STATUSES = new Set(['running', 'provisioning', 'queued', 'branching']);

export function registerReplyHandler(bot: Chat) {
  bot.onSubscribedMessage(async (thread, message) => {
    if (message.author?.isMe) return;
    if (message.isMention === false && !thread.channel?.isDM) {
    }
    const workspaceId = workspaceIdFromRaw(message.raw);
    const resolved = await resolveChannel('slack', workspaceId, thread.channelId);
    if (!resolved) return;

    const existing = await loadExistingSession(
      'slack',
      workspaceId,
      thread.id,
      resolved.project.projectId,
    );

    if (existing && existing.sessionStatus && RUNNING_STATUSES.has(existing.sessionStatus)) {
      await thread.startTyping();
      const ready = await waitForSessionReady(existing.sessionId);
      if (ready.status !== 'ready') {
        await thread.post(`Session no longer reachable: ${ready.error ?? ready.status}`);
        return;
      }
      await thread.post(
        streamAgentResponse(
          existing.sessionId,
          resolved.project.accountId,
          message.text,
          resolved.spec.agent,
        ),
      );
      await db
        .update(chatThreads)
        .set({ lastMessageAt: new Date() })
        .where(eq(chatThreads.rowId, existing.threadRowId));
      return;
    }

    await thread.startTyping();
    const spawn = await spawnChannelSession({
      project: resolved.project,
      spec: resolved.spec,
      workspaceId,
      channelId: thread.channelId,
      threadId: thread.id,
      authorUserId: message.author?.userId ?? null,
      messageText: message.text,
      event: 'subscribed',
    });
    if (spawn.status === 'failed') {
      await thread.post(`Couldn't continue: ${spawn.error}`);
      return;
    }
    if (spawn.status === 'skipped') return;
    const ready = await waitForSessionReady(spawn.sessionId!);
    if (ready.status !== 'ready') {
      await thread.post(`Session didn't come up: ${ready.error ?? ready.status}`);
      return;
    }
    await thread.post(
      streamAgentResponse(
        spawn.sessionId!,
        resolved.project.accountId,
        message.text,
        resolved.spec.agent,
      ),
    );
  });
}

interface ExistingSession {
  threadRowId: string;
  sessionId: string;
  sessionStatus: string | null;
  project: Project;
}

async function loadExistingSession(
  platform: 'slack',
  workspaceId: string,
  threadId: string,
  projectId: string,
): Promise<ExistingSession | null> {
  const [row] = await db
    .select({
      threadRowId: chatThreads.rowId,
      sessionId: chatThreads.sessionId,
      sessionStatus: projectSessions.status,
      project: projects,
    })
    .from(chatThreads)
    .innerJoin(projects, eq(projects.projectId, chatThreads.projectId))
    .leftJoin(projectSessions, eq(projectSessions.sessionId, chatThreads.sessionId))
    .where(
      and(
        eq(chatThreads.platform, platform),
        eq(chatThreads.workspaceId, workspaceId),
        eq(chatThreads.threadId, threadId),
        eq(chatThreads.projectId, projectId),
      ),
    )
    .limit(1);
  if (!row?.sessionId) return null;
  return {
    threadRowId: row.threadRowId,
    sessionId: row.sessionId,
    sessionStatus: row.sessionStatus,
    project: row.project,
  };
}
