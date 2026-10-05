import { and, desc, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { chatPendingAuthMessages } from '@kortix/db';
import { db } from '../../shared/db';
import type { TeamsActivity } from './types';

const PENDING_AUTH_TTL_MS = 10 * 60 * 1000;

export async function createPendingTeamsAuthMessage(input: {
  projectId: string;
  tenantId: string;
  teamsUserId: string;
  activity: TeamsActivity;
}): Promise<string | null> {
  if (!input.tenantId || !input.teamsUserId) return null;
  try {
    await db.delete(chatPendingAuthMessages).where(lt(chatPendingAuthMessages.expiresAt, new Date()));
    const rows = await db
      .insert(chatPendingAuthMessages)
      .values({
        projectId: input.projectId,
        platform: 'teams',
        workspaceId: input.tenantId,
        platformUserId: input.teamsUserId,
        envelope: {},
        event: input.activity as unknown as Record<string, unknown>,
        expiresAt: new Date(Date.now() + PENDING_AUTH_TTL_MS),
      })
      .returning({ pendingId: chatPendingAuthMessages.pendingId });
    return rows[0]?.pendingId ?? null;
  } catch (err) {
    console.warn('[teams-auth] failed to store pending Teams message', err);
    return null;
  }
}

/**
 * The display name on the Teams message a login link was issued for, without
 * consuming it. Used by the consent screen to name the account being linked.
 */
export async function peekPendingTeamsAuthSenderName(input: {
  pendingId: string | undefined;
  tenantId: string;
  teamsUserId: string;
}): Promise<string | null> {
  if (!input.pendingId || !input.tenantId || !input.teamsUserId) return null;
  try {
    const [row] = await db
      .select({ event: chatPendingAuthMessages.event })
      .from(chatPendingAuthMessages)
      .where(
        and(
          eq(chatPendingAuthMessages.pendingId, input.pendingId),
          eq(chatPendingAuthMessages.workspaceId, input.tenantId),
          eq(chatPendingAuthMessages.platformUserId, input.teamsUserId),
          gt(chatPendingAuthMessages.expiresAt, new Date()),
          isNotNull(chatPendingAuthMessages.projectId),
        ),
      )
      .limit(1);
    const name = (row?.event as unknown as TeamsActivity | undefined)?.from?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
    return null;
  }
}

/**
 * The newest message this Teams user parked while unlinked, if one still waits.
 *
 * In a channel or group chat the sign-in link is not shown (login-card.ts), so
 * the user connects through `/login` in a one-to-one chat. That link carries
 * this id, so connecting there still runs what they sent in the channel.
 */
export async function latestPendingTeamsAuthMessageId(input: {
  tenantId: string;
  teamsUserId: string;
}): Promise<string | null> {
  if (!input.tenantId || !input.teamsUserId) return null;
  try {
    const [row] = await db
      .select({ pendingId: chatPendingAuthMessages.pendingId })
      .from(chatPendingAuthMessages)
      .where(
        and(
          eq(chatPendingAuthMessages.platform, 'teams'),
          eq(chatPendingAuthMessages.workspaceId, input.tenantId),
          eq(chatPendingAuthMessages.platformUserId, input.teamsUserId),
          gt(chatPendingAuthMessages.expiresAt, new Date()),
          isNotNull(chatPendingAuthMessages.projectId),
        ),
      )
      .orderBy(desc(chatPendingAuthMessages.expiresAt))
      .limit(1);
    return row?.pendingId ?? null;
  } catch (err) {
    console.warn('[teams-auth] failed to look up a parked Teams message', err);
    return null;
  }
}

export async function consumePendingTeamsAuthMessage(input: {
  pendingId: string | undefined;
  tenantId: string;
  teamsUserId: string;
}): Promise<{ projectId: string; activity: TeamsActivity } | null> {
  if (!input.pendingId || !input.tenantId || !input.teamsUserId) return null;
  try {
    const [row] = await db
      .select({
        projectId: chatPendingAuthMessages.projectId,
        event: chatPendingAuthMessages.event,
      })
      .from(chatPendingAuthMessages)
      .where(
        and(
          eq(chatPendingAuthMessages.pendingId, input.pendingId),
          eq(chatPendingAuthMessages.workspaceId, input.tenantId),
          eq(chatPendingAuthMessages.platformUserId, input.teamsUserId),
          gt(chatPendingAuthMessages.expiresAt, new Date()),
          isNotNull(chatPendingAuthMessages.projectId),
        ),
      )
      .limit(1);
    if (!row?.projectId) return null;
    await db.delete(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.pendingId, input.pendingId));
    return { projectId: row.projectId, activity: row.event as unknown as TeamsActivity };
  } catch (err) {
    console.warn('[teams-auth] failed to consume pending Teams message', err);
    return null;
  }
}

/**
 * Park a message that arrived before its conversation was routed to a project
 * (the project-picker flow). Unlike the auth-resume pending message, there is
 * no project yet — it is chosen when the user clicks. Reuses the same table.
 */
export async function createPendingTeamsPickerMessage(input: {
  tenantId: string;
  teamsUserId: string;
  activity: TeamsActivity;
}): Promise<string | null> {
  if (!input.tenantId) return null;
  try {
    await db.delete(chatPendingAuthMessages).where(lt(chatPendingAuthMessages.expiresAt, new Date()));
    const rows = await db
      .insert(chatPendingAuthMessages)
      .values({
        projectId: null,
        platform: 'teams',
        workspaceId: input.tenantId,
        platformUserId: input.teamsUserId || '',
        envelope: { picker: true },
        event: input.activity as unknown as Record<string, unknown>,
        expiresAt: new Date(Date.now() + PENDING_AUTH_TTL_MS),
      })
      .returning({ pendingId: chatPendingAuthMessages.pendingId });
    return rows[0]?.pendingId ?? null;
  } catch (err) {
    console.warn('[teams-webhook] failed to store pending picker message', err);
    return null;
  }
}

/**
 * Consume a parked picker message by id + tenant. Anyone in the conversation
 * may pick, but only there: a pick from another conversation would replay
 * this sender's message where they never sent it.
 */
export async function consumePendingTeamsPickerMessage(input: {
  pendingId: string | undefined;
  tenantId: string;
  conversationId: string;
}): Promise<TeamsActivity | null> {
  if (!input.pendingId || !input.tenantId) return null;
  try {
    // One statement: two replicas racing on the same click cannot both replay.
    const [row] = await db
      .delete(chatPendingAuthMessages)
      .where(
        and(
          eq(chatPendingAuthMessages.pendingId, input.pendingId),
          eq(chatPendingAuthMessages.workspaceId, input.tenantId),
          isNull(chatPendingAuthMessages.projectId),
          gt(chatPendingAuthMessages.expiresAt, new Date()),
          sql`${chatPendingAuthMessages.event}->'conversation'->>'id' = ${input.conversationId}`,
        ),
      )
      .returning({ event: chatPendingAuthMessages.event });
    return (row?.event as unknown as TeamsActivity | undefined) ?? null;
  } catch (err) {
    console.warn('[teams-webhook] failed to consume pending picker message', err);
    return null;
  }
}
