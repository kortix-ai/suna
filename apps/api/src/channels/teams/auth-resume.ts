import { and, eq, gt, lt } from 'drizzle-orm';
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
        ),
      )
      .limit(1);
    const name = (row?.event as unknown as TeamsActivity | undefined)?.from?.name;
    return typeof name === 'string' && name.trim() ? name.trim() : null;
  } catch {
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
        ),
      )
      .limit(1);
    if (!row) return null;
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
        projectId: '',
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

/** Consume a parked picker message by id + tenant (anyone in the conversation may pick). */
export async function consumePendingTeamsPickerMessage(input: {
  pendingId: string | undefined;
  tenantId: string;
}): Promise<TeamsActivity | null> {
  if (!input.pendingId || !input.tenantId) return null;
  try {
    const [row] = await db
      .select({ event: chatPendingAuthMessages.event })
      .from(chatPendingAuthMessages)
      .where(
        and(
          eq(chatPendingAuthMessages.pendingId, input.pendingId),
          eq(chatPendingAuthMessages.workspaceId, input.tenantId),
          gt(chatPendingAuthMessages.expiresAt, new Date()),
        ),
      )
      .limit(1);
    if (!row) return null;
    await db.delete(chatPendingAuthMessages).where(eq(chatPendingAuthMessages.pendingId, input.pendingId));
    return row.event as unknown as TeamsActivity;
  } catch (err) {
    console.warn('[teams-webhook] failed to consume pending picker message', err);
    return null;
  }
}
