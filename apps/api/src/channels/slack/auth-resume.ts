import type { Effect } from 'effect';
import { and, eq, gt, lt } from 'drizzle-orm';
import { chatPendingAuthMessages } from '@kortix/db';
import { sharedDb as db } from '../../shared/effect';
import { respondViaUrl } from './util';
import type { SlackEnvelope, SlackEvent } from './types';

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export async function createPendingSlackAuthMessage(input: {
  projectId: string;
  teamId: string;
  slackUserId: string;
  envelope: SlackEnvelope;
  event: SlackEvent;
}): Promise<string | null> {
  if (!input.teamId || !input.slackUserId) return null;
  try {
    const now = new Date();
    await db.delete(chatPendingAuthMessages).where(lt(chatPendingAuthMessages.expiresAt, now));
    const rows = await db
      .insert(chatPendingAuthMessages)
      .values({
        projectId: input.projectId,
        platform: 'slack',
        workspaceId: input.teamId,
        platformUserId: input.slackUserId,
        envelope: input.envelope as unknown as Record<string, unknown>,
        event: input.event as unknown as Record<string, unknown>,
        expiresAt: new Date(Date.now() + PENDING_AUTH_TTL_MS),
      })
      .returning({ pendingId: chatPendingAuthMessages.pendingId });
    return rows[0]?.pendingId ?? null;
  } catch (err) {
    console.warn('[slack-auth] failed to store pending Slack message', err);
    return null;
  }
}

export async function consumePendingSlackAuthMessage(input: {
  pendingId: string | undefined;
  teamId: string;
  slackUserId: string;
}): Promise<{ projectId: string; envelope: SlackEnvelope; event: SlackEvent; slackResponseUrl: string | null } | null> {
  if (!input.pendingId || !input.teamId || !input.slackUserId) return null;
  try {
    const [row] = await db
      .select({
        projectId: chatPendingAuthMessages.projectId,
        envelope: chatPendingAuthMessages.envelope,
        event: chatPendingAuthMessages.event,
        slackResponseUrl: chatPendingAuthMessages.slackResponseUrl,
      })
      .from(chatPendingAuthMessages)
      .where(and(
        eq(chatPendingAuthMessages.pendingId, input.pendingId),
        eq(chatPendingAuthMessages.workspaceId, input.teamId),
        eq(chatPendingAuthMessages.platformUserId, input.slackUserId),
        gt(chatPendingAuthMessages.expiresAt, new Date()),
      ))
      .limit(1);
    if (!row) return null;
    await db
      .delete(chatPendingAuthMessages)
      .where(eq(chatPendingAuthMessages.pendingId, input.pendingId));
    return {
      projectId: row.projectId,
      envelope: row.envelope as unknown as SlackEnvelope,
      event: row.event as unknown as SlackEvent,
      slackResponseUrl: row.slackResponseUrl ?? null,
    };
  } catch (err) {
    console.warn('[slack-auth] failed to consume pending Slack message', err);
    return null;
  }
}

export async function attachPendingSlackAuthResponseUrl(input: {
  pendingId: string | undefined;
  teamId: string;
  slackUserId: string;
  responseUrl: string | undefined;
}): Promise<boolean> {
  if (!input.pendingId || !input.teamId || !input.slackUserId || !input.responseUrl) return false;
  try {
    const rows = await db
      .update(chatPendingAuthMessages)
      .set({ slackResponseUrl: input.responseUrl })
      .where(and(
        eq(chatPendingAuthMessages.pendingId, input.pendingId),
        eq(chatPendingAuthMessages.workspaceId, input.teamId),
        eq(chatPendingAuthMessages.platformUserId, input.slackUserId),
        gt(chatPendingAuthMessages.expiresAt, new Date()),
      ))
      .returning({ pendingId: chatPendingAuthMessages.pendingId });
    return rows.length > 0;
  } catch (err) {
    console.warn('[slack-auth] failed to attach Slack auth response_url', err);
    return false;
  }
}

export async function replaceSlackAuthPromptConnected(
  responseUrl: string | null | undefined,
  opts?: { hasAccess?: boolean },
): Promise<void> {
  const hasAccess = opts?.hasAccess !== false;
  const text = hasAccess
    ? '*Slack connected.*\nKortix is picking up your message now.'
    : '*Slack connected.*\nYour Kortix account still needs access to this project. Head back to Slack and request access to continue.';
  await respondViaUrl(responseUrl ?? undefined, {
    response_type: 'ephemeral',
    replace_original: true,
    text: hasAccess
      ? 'Slack connected. Kortix is picking up your message now.'
      : 'Slack connected. Request project access in Slack to continue.',
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text,
        },
      },
    ],
  });
}
