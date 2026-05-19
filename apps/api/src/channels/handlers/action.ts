import type { Chat } from 'chat';
import { and, eq } from 'drizzle-orm';
import { chatThreads, projectSessions } from '@kortix/db';
import { db } from '../../shared/db';

const ACTION_RE = /^plan\.(approve|revise|reject):(.+)$/;

export function registerActionHandler(bot: Chat) {
  bot.onAction(async (event) => {
    const match = ACTION_RE.exec(event.actionId);
    if (!match) return;
    const [, kind, sessionId] = match;

    const [thread] = await db
      .select()
      .from(chatThreads)
      .where(eq(chatThreads.sessionId, sessionId!))
      .limit(1);
    if (!thread || !event.thread) return;

    if (kind === 'approve') {
      await db
        .update(projectSessions)
        .set({
          metadata: { plan_decision: 'approve', plan_decided_by: event.user?.userId ?? null },
          updatedAt: new Date(),
        })
        .where(eq(projectSessions.sessionId, sessionId!));
      await event.thread.post(`Approved by <@${event.user?.userId}>. Asking the agent to commit & open a PR.`);
    } else if (kind === 'revise') {
      await event.thread.post(
        `<@${event.user?.userId}> reply in-thread with the revision you'd like, and I'll re-plan.`,
      );
    } else if (kind === 'reject') {
      await db
        .update(projectSessions)
        .set({
          status: 'stopped',
          metadata: { plan_decision: 'reject', plan_decided_by: event.user?.userId ?? null },
          updatedAt: new Date(),
        })
        .where(and(eq(projectSessions.sessionId, sessionId!)));
      await event.thread.post(`Rejected by <@${event.user?.userId}>. Session stopped.`);
    }
  });
}
