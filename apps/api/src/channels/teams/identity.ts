import { and, eq, isNull } from 'drizzle-orm';
import { accountMembers, chatUserIdentities, projectAccessRequests, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { authorize } from '../../iam';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { notifyProjectAccessRequestManagers } from '../../projects/lib/access-requests';
import { lookupEmailsByUserIds } from '../../projects/lib/access';
import { sendCard } from '../teams-api';
import { buildConnectAccountCard, buildRequestAccessCard } from './cards';
import { buildTeamsLoginUrl } from './login';
import { createPendingTeamsAuthMessage } from './auth-resume';
import type { TeamsActivity, TeamsConversationRef } from './types';

const PLATFORM = 'teams';

export type TeamsActor = { userId: string } | { reason: 'unlinked' | 'not_member' };

export function teamsUserId(activity: TeamsActivity): string | null {
  return activity.from?.aadObjectId ?? activity.from?.id ?? null;
}

function conversationRef(activity: TeamsActivity): TeamsConversationRef | null {
  if (!activity.serviceUrl || !activity.conversation?.id) return null;
  return {
    serviceUrl: activity.serviceUrl,
    conversationId: activity.conversation.id,
    botId: activity.recipient?.id,
    fromId: activity.from?.id,
    tenantId: activity.conversation.tenantId ?? activity.channelData?.tenant?.id,
  };
}

export async function resolveTeamsActor(
  tenantId: string,
  userId: string,
  accountId: string,
  projectId: string,
): Promise<TeamsActor> {
  if (!tenantId || !userId) return { reason: 'unlinked' };

  const [link] = await db
    .select({ userId: chatUserIdentities.userId })
    .from(chatUserIdentities)
    .where(
      and(
        eq(chatUserIdentities.platform, PLATFORM),
        eq(chatUserIdentities.workspaceId, tenantId),
        eq(chatUserIdentities.platformUserId, userId),
        isNull(chatUserIdentities.revokedAt),
      ),
    )
    .limit(1);
  if (!link) return { reason: 'unlinked' };

  if (!(await isAccountMember(link.userId, accountId))) return { reason: 'not_member' };
  const verdict = await authorize(link.userId, accountId, PROJECT_ACTIONS.PROJECT_WRITE, {
    type: 'project',
    id: projectId,
  });
  if (!verdict.allowed) return { reason: 'not_member' };
  return { userId: link.userId };
}

export async function isAccountMember(userId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  return !!row;
}

export async function lookupTeamsIdentity(
  tenantId: string,
  userId: string,
): Promise<{ userId: string } | null> {
  const [row] = await db
    .select({ userId: chatUserIdentities.userId })
    .from(chatUserIdentities)
    .where(
      and(
        eq(chatUserIdentities.platform, PLATFORM),
        eq(chatUserIdentities.workspaceId, tenantId),
        eq(chatUserIdentities.platformUserId, userId),
        isNull(chatUserIdentities.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function linkTeamsIdentity(input: {
  tenantId: string;
  teamsUserId: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(chatUserIdentities)
    .values({
      platform: PLATFORM,
      workspaceId: input.tenantId,
      platformUserId: input.teamsUserId,
      userId: input.userId,
    })
    .onConflictDoUpdate({
      target: [
        chatUserIdentities.platform,
        chatUserIdentities.workspaceId,
        chatUserIdentities.platformUserId,
      ],
      set: { userId: input.userId, linkedAt: new Date(), revokedAt: null },
    });
}

export async function revokeTeamsIdentity(tenantId: string, userId: string): Promise<boolean> {
  const rows = await db
    .update(chatUserIdentities)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(chatUserIdentities.platform, PLATFORM),
        eq(chatUserIdentities.workspaceId, tenantId),
        eq(chatUserIdentities.platformUserId, userId),
        isNull(chatUserIdentities.revokedAt),
      ),
    )
    .returning({ identityId: chatUserIdentities.identityId });
  return rows.length > 0;
}

export async function postTeamsIdentityPrompt(input: {
  projectId: string;
  tenantId: string;
  activity: TeamsActivity;
  reason: 'unlinked' | 'not_member';
}): Promise<void> {
  const ref = conversationRef(input.activity);
  if (!ref) return;
  const userId = teamsUserId(input.activity);
  if (!userId) return;

  if (input.reason === 'unlinked') {
    const pendingId = await createPendingTeamsAuthMessage({
      projectId: input.projectId,
      tenantId: input.tenantId,
      teamsUserId: userId,
      activity: input.activity,
    });
    const loginUrl = buildTeamsLoginUrl({
      tenantId: input.tenantId,
      teamsUserId: userId,
      ...(pendingId ? { pendingId } : {}),
    });
    await sendCard(ref, buildConnectAccountCard(loginUrl));
    return;
  }
  await sendCard(ref, buildRequestAccessCard(input.projectId));
}

export type TeamsAccessRequestOutcome =
  | { status: 'created' | 'pending' | 'already-member'; requesterUserId: string; accountId: string }
  | { status: 'no-identity' | 'no-project' };

export async function createTeamsAccessRequest(input: {
  tenantId: string;
  teamsUserId: string;
  projectId: string;
}): Promise<TeamsAccessRequestOutcome> {
  const identity = await lookupTeamsIdentity(input.tenantId, input.teamsUserId);
  if (!identity) return { status: 'no-identity' };

  const [project] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, input.projectId))
    .limit(1);
  if (!project) return { status: 'no-project' };

  const base = { requesterUserId: identity.userId, accountId: project.accountId };
  if (await isAccountMember(identity.userId, project.accountId)) {
    const verdict = await authorize(identity.userId, project.accountId, PROJECT_ACTIONS.PROJECT_WRITE, {
      type: 'project',
      id: input.projectId,
    });
    if (verdict.allowed) return { status: 'already-member', ...base };
  }

  const [existing] = await db
    .select({ requestId: projectAccessRequests.requestId })
    .from(projectAccessRequests)
    .where(
      and(
        eq(projectAccessRequests.projectId, input.projectId),
        eq(projectAccessRequests.requesterUserId, identity.userId),
        eq(projectAccessRequests.status, 'pending'),
      ),
    )
    .limit(1);
  if (existing) return { status: 'pending', ...base };

  const email = (await lookupEmailsByUserIds([identity.userId]).catch(() => null))?.get(identity.userId);
  await db.insert(projectAccessRequests).values({
    accountId: project.accountId,
    projectId: input.projectId,
    requesterUserId: identity.userId,
    requesterEmail: email || identity.userId,
    message: 'Requested from Microsoft Teams. Approve as Editor so they can run Kortix from Teams.',
  });
  return { status: 'created', ...base };
}

export async function notifyAdminsOfTeamsAccessRequest(input: {
  projectId: string;
  accountId: string;
  requesterUserId: string;
}): Promise<void> {
  await notifyProjectAccessRequestManagers({
    accountId: input.accountId,
    projectId: input.projectId,
    requesterUserId: input.requesterUserId,
  }).catch((err) => console.warn('[teams-auth] notify managers failed', err));
}
