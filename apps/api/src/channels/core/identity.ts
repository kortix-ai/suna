import { and, eq, isNull } from 'drizzle-orm';
import { accountMembers, chatUserIdentities, projectAccessRequests, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { authorize } from '../../iam';
import { actorForUser } from '../../iam/actor';
import { PROJECT_ACTIONS } from '../../iam/actions';
import { lookupEmailsByUserIds } from '../../projects/lib/access';

/**
 * The chat identity link: which Kortix user a person on a chat platform acts
 * as, and whether that user may act in a project.
 *
 * A chat webhook carries no Kortix credential. It acts AS the Kortix user the
 * chat identity is linked to (`/login` in Slack or Teams writes the link), so
 * every inbound action is authorized here, through one resolver, whatever the
 * platform.
 */
export type ChatPlatform = 'slack' | 'teams';

/** A person on a chat platform: the workspace (Slack team, Teams tenant) and their id there. */
export interface ChatUser {
  platform: ChatPlatform;
  workspaceId: string;
  platformUserId: string;
}

export function chatUser(platform: ChatPlatform, workspaceId: string, platformUserId: string): ChatUser {
  return { platform, workspaceId, platformUserId };
}

export type ChatActor = { userId: string } | { reason: 'unlinked' | 'not_member' };

function linkRow(user: ChatUser) {
  return and(
    eq(chatUserIdentities.platform, user.platform),
    eq(chatUserIdentities.workspaceId, user.workspaceId),
    eq(chatUserIdentities.platformUserId, user.platformUserId),
    isNull(chatUserIdentities.revokedAt),
  );
}

/** The Kortix user behind a live link, or null. */
export async function lookupChatIdentity(user: ChatUser): Promise<{ userId: string } | null> {
  const [row] = await db
    .select({ userId: chatUserIdentities.userId })
    .from(chatUserIdentities)
    .where(linkRow(user))
    .limit(1);
  return row ?? null;
}

/**
 * Link `user` to `userId`. A re-link (same chat user, new Kortix user)
 * replaces the mapping and clears any revocation.
 */
export async function linkChatIdentity(user: ChatUser, userId: string): Promise<void> {
  await db
    .insert(chatUserIdentities)
    .values({
      platform: user.platform,
      workspaceId: user.workspaceId,
      platformUserId: user.platformUserId,
      userId,
    })
    .onConflictDoUpdate({
      target: [chatUserIdentities.platform, chatUserIdentities.workspaceId, chatUserIdentities.platformUserId],
      set: { userId, linkedAt: new Date(), revokedAt: null },
    });
}

export async function revokeChatIdentity(user: ChatUser): Promise<boolean> {
  const rows = await db
    .update(chatUserIdentities)
    .set({ revokedAt: new Date() })
    .where(linkRow(user))
    .returning({ identityId: chatUserIdentities.identityId });
  return rows.length > 0;
}

/** The chat user a Kortix user is linked as in a workspace (to DM them), or null. */
export async function lookupChatUserForKortixUser(
  platform: ChatPlatform,
  workspaceId: string,
  userId: string,
): Promise<string | null> {
  const [row] = await db
    .select({ platformUserId: chatUserIdentities.platformUserId })
    .from(chatUserIdentities)
    .where(
      and(
        eq(chatUserIdentities.platform, platform),
        eq(chatUserIdentities.workspaceId, workspaceId),
        eq(chatUserIdentities.userId, userId),
        isNull(chatUserIdentities.revokedAt),
      ),
    )
    .limit(1);
  return row?.platformUserId ?? null;
}

export async function isAccountMember(userId: string, accountId: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(and(eq(accountMembers.userId, userId), eq(accountMembers.accountId, accountId)))
    .limit(1);
  return !!row;
}

/**
 * The Kortix user `user` acts as in `project`, when the link is live, the
 * user is a member of the project's account, and IAM allows `action` on the
 * project. `action` defaults to starting work (`project.write`); channel
 * settings ask for `project.connector.write` (see core/settings.ts).
 */
export async function resolveChatActor(
  user: ChatUser,
  project: { projectId: string; accountId: string },
  action: string = PROJECT_ACTIONS.PROJECT_WRITE,
): Promise<ChatActor> {
  if (!user.workspaceId || !user.platformUserId) return { reason: 'unlinked' };
  const link = await lookupChatIdentity(user);
  if (!link) return { reason: 'unlinked' };
  if (!(await isAccountMember(link.userId, project.accountId))) return { reason: 'not_member' };
  // Role-only is the honest classification: the webhook has no token of its own.
  const verdict = await authorize(actorForUser(link.userId, project.accountId), action, {
    type: 'project',
    id: project.projectId,
  });
  if (!verdict.allowed) return { reason: 'not_member' };
  return { userId: link.userId };
}

/** `resolveChatActor` for a project known only by id. A missing project is `not_member`. */
export async function resolveProjectChatActor(
  user: ChatUser,
  projectId: string,
  action: string = PROJECT_ACTIONS.PROJECT_WRITE,
): Promise<ChatActor> {
  const [project] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return { reason: 'not_member' };
  return resolveChatActor(user, { projectId, accountId: project.accountId }, action);
}

export type ChatAccessRequestOutcome =
  | { status: 'created' | 'pending' | 'already-member'; requesterUserId: string; accountId: string }
  | { status: 'no-identity' | 'no-project' };

const ACCESS_REQUEST_MESSAGE: Record<ChatPlatform, string> = {
  slack: 'Requested from Slack. Approve so they can run Kortix from Slack.',
  teams: 'Requested from Microsoft Teams. Approve so they can run Kortix from Teams.',
};

/**
 * File (or find the pending) project access request for a linked chat user,
 * in the same table the web "Request access" flow uses. Idempotent: a second
 * request while one is pending answers `pending`.
 */
export async function createChatAccessRequest(user: ChatUser, projectId: string): Promise<ChatAccessRequestOutcome> {
  const identity = await lookupChatIdentity(user);
  if (!identity) return { status: 'no-identity' };

  const [project] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return { status: 'no-project' };

  const base = { requesterUserId: identity.userId, accountId: project.accountId };
  if (await isAccountMember(identity.userId, project.accountId)) {
    // A member without project.write for this project still goes through the
    // review queue instead of silently failing.
    const verdict = await authorize(
      actorForUser(identity.userId, project.accountId),
      PROJECT_ACTIONS.PROJECT_WRITE,
      { type: 'project', id: projectId },
    );
    if (verdict.allowed) return { status: 'already-member', ...base };
  }

  const [existing] = await db
    .select({ requestId: projectAccessRequests.requestId })
    .from(projectAccessRequests)
    .where(
      and(
        eq(projectAccessRequests.projectId, projectId),
        eq(projectAccessRequests.requesterUserId, identity.userId),
        eq(projectAccessRequests.status, 'pending'),
      ),
    )
    .limit(1);
  if (existing) return { status: 'pending', ...base };

  const email = (await lookupEmailsByUserIds([identity.userId]).catch(() => null))?.get(identity.userId);
  await db.insert(projectAccessRequests).values({
    accountId: project.accountId,
    projectId,
    requesterUserId: identity.userId,
    requesterEmail: email || identity.userId,
    message: ACCESS_REQUEST_MESSAGE[user.platform],
  });
  return { status: 'created', ...base };
}
