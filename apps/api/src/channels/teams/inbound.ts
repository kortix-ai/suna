import { and, eq } from 'drizzle-orm';
import { chatChannelBindings, chatInstalls, projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { resolveConversationProject } from './binding';
import type { TeamsActivity } from './types';

/**
 * What the Bot Framework token on an inbound Teams activity proved.
 *
 * The token is signed by Microsoft, but it covers only its own claims (issuer,
 * audience = the bot's app id, service URL). It does not cover the activity
 * body, so the tenant, conversation and sender in the body are only as
 * trustworthy as whoever could obtain a token for that audience:
 *
 *  - `managed`: the audience is the Kortix app. Only Bot Framework holds
 *    tokens for it, so the body is Microsoft's.
 *  - `project`: the audience is a per-project (bring-your-own) app id that the
 *    project admin registered. What the activity may reach comes from the
 *    install record instead: the project in the webhook path, and the tenants
 *    that install proved (`chat_installs`, written only by the install paths).
 */
export type TeamsInbound =
  | { kind: 'managed' }
  | { kind: 'project'; projectId: string; tenantId: string };

export const MANAGED_TEAMS_INBOUND: TeamsInbound = { kind: 'managed' };

export function tenantOfActivity(activity: TeamsActivity): string | null {
  return activity.conversation?.tenantId ?? activity.channelData?.tenant?.id ?? null;
}

/** The Teams tenants a project's install was proven for. */
export async function provenTeamsTenants(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ workspaceId: chatInstalls.workspaceId })
    .from(chatInstalls)
    .where(and(eq(chatInstalls.platform, 'teams'), eq(chatInstalls.projectId, projectId)));
  return rows.map((r) => r.workspaceId).filter(Boolean);
}

/**
 * Confine a per-project activity to its proven tenant. Returns null when the
 * activity names a tenant the install did not prove (the caller refuses it).
 */
export async function scopeProjectTeamsActivity(
  projectId: string,
  activity: TeamsActivity,
): Promise<TeamsInbound | null> {
  const tenantId = tenantOfActivity(activity);
  if (!tenantId) return null;
  const tenants = await provenTeamsTenants(projectId);
  if (!tenants.some((t) => t.toLowerCase() === tenantId.toLowerCase())) return null;
  return { kind: 'project', projectId, tenantId };
}

export function inboundAllowsTeamsProject(inbound: TeamsInbound, projectId: string | null | undefined): boolean {
  if (!projectId) return false;
  return inbound.kind === 'managed' || inbound.projectId === projectId;
}

/**
 * The project a conversation runs for this inbound scope. The managed bot
 * resolves it from the tenant's bindings and installs. A per-project bot runs
 * only its own project, and declines a conversation another project is bound
 * to rather than taking it over.
 */
export async function conversationProjectFor(
  inbound: TeamsInbound,
  tenantId: string,
  conversationId: string,
): Promise<string | null> {
  if (inbound.kind === 'managed') return resolveConversationProject(tenantId, conversationId);
  const [binding] = await db
    .select({ projectId: chatChannelBindings.projectId })
    .from(chatChannelBindings)
    .where(
      and(
        eq(chatChannelBindings.platform, 'teams'),
        eq(chatChannelBindings.workspaceId, tenantId),
        eq(chatChannelBindings.channelId, conversationId),
      ),
    )
    .limit(1);
  if (binding?.projectId && binding.projectId !== inbound.projectId) return null;
  return inbound.projectId;
}

/** Does `sessionId` belong to a project `inbound` may act on? */
export async function teamsSessionInScope(inbound: TeamsInbound, sessionId: string): Promise<boolean> {
  if (inbound.kind === 'managed') return true;
  const [row] = await db
    .select({ projectId: projectSessions.projectId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  return inboundAllowsTeamsProject(inbound, row?.projectId);
}
