import { and, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import {
  accountMembers,
  accounts,
  chatEventDedup,
  chatInstalls,
  chatUserIdentities,
  projectAccessRequests,
  projects,
} from '@kortix/db';
import { db } from '../../shared/db';
import { authorize } from '../../iam';
import { mfaGateBlocks } from '../../iam/authorize';
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

/** The Kortix user behind a live link, or null. `mfaVerified`: the link was made after a second factor. */
export async function lookupChatIdentity(user: ChatUser): Promise<{ userId: string; mfaVerified: boolean } | null> {
  const [row] = await db
    .select({ userId: chatUserIdentities.userId, mfaVerifiedAt: chatUserIdentities.mfaVerifiedAt })
    .from(chatUserIdentities)
    .where(linkRow(user))
    .limit(1);
  return row ? { userId: row.userId, mfaVerified: Boolean(row.mfaVerifiedAt) } : null;
}

export type ChatLinkResult = { ok: true } | { ok: false; reason: 'linked_to_other' };

/**
 * Link `user` to `userId`. Linking again as the same Kortix user refreshes the
 * link, and a revoked link can be taken by anyone who proves the chat identity.
 * A live link to ANOTHER Kortix user is never replaced: that person runs
 * `/logout` in the chat first. A sign-in link links whoever opens it, so
 * replacing live links let anyone holding one take over a linked identity
 * (2026-09-29 permissions audit). `mfaVerified` records whether the Kortix
 * session making the link had passed a second factor.
 */
export async function linkChatIdentity(
  user: ChatUser,
  userId: string,
  opts: { mfaVerified?: boolean } = {},
): Promise<ChatLinkResult> {
  const now = new Date();
  const rows = await db
    .insert(chatUserIdentities)
    .values({
      platform: user.platform,
      workspaceId: user.workspaceId,
      platformUserId: user.platformUserId,
      userId,
      mfaVerifiedAt: opts.mfaVerified ? now : null,
    })
    .onConflictDoUpdate({
      target: [chatUserIdentities.platform, chatUserIdentities.workspaceId, chatUserIdentities.platformUserId],
      set: {
        userId,
        linkedAt: now,
        revokedAt: null,
        // A refresh without MFA (a Slack reinstall) keeps a live link's stamp.
        mfaVerifiedAt: opts.mfaVerified
          ? now
          : sql`case when ${chatUserIdentities.revokedAt} is null then ${chatUserIdentities.mfaVerifiedAt} end`,
      },
      // One statement, so two racing links cannot both replace a live link.
      setWhere: or(isNotNull(chatUserIdentities.revokedAt), eq(chatUserIdentities.userId, userId)),
    })
    .returning({ identityId: chatUserIdentities.identityId });
  return rows.length > 0 ? { ok: true } : { ok: false, reason: 'linked_to_other' };
}

/**
 * Spend a sign-in link: true the first time its `nonce` is claimed, false
 * after. The claim lives until the link expires (`exp`), so a link works once.
 */
export async function claimChatLoginToken(platform: ChatPlatform, nonce: string, exp: number): Promise<boolean> {
  const rows = await db
    .insert(chatEventDedup)
    .values({ eventId: `login:${platform}:${nonce}`, expiresAt: new Date(exp) })
    .onConflictDoNothing({ target: chatEventDedup.eventId })
    .returning({ eventId: chatEventDedup.eventId });
  return rows.length > 0;
}

export type ChatLoginOutcome =
  | { ok: true; hasAccess: boolean; fresh: boolean }
  | { ok: false; reason: 'mfa_required' | 'used' | 'linked_to_other' };

/**
 * Complete a `/login` link for the signed-in `userId`. Both bind routes run
 * this after they verify the link and find the workspace's `accountIds`.
 *
 * 1. An account the person is a member of requires MFA, and this Kortix
 *    session has not passed it: refuse BEFORE the link is spent, so the person
 *    verifies in the web app (the `account_mfa_required` step-up) and clicks
 *    again. A link made without MFA would not pass the account's gate in chat.
 * 2. Spend the link. A spent link is refused, except to the person it
 *    already linked (a page reload), which changes nothing.
 * 3. Link, but never over a live link to someone else.
 *
 * `fresh` is false for the reload case: nothing new happened, so callers
 * resume no parked message.
 */
export async function completeChatLogin(input: {
  user: ChatUser;
  userId: string;
  login: { nonce: string; exp: number };
  accountIds: string[];
  mfaAal: string | undefined;
  tokenId: string | null | undefined;
}): Promise<ChatLoginOutcome> {
  const member = await Promise.all(input.accountIds.map((a) => isAccountMember(input.userId, a)));
  const memberAccountIds = input.accountIds.filter((_, i) => member[i]);
  const hasAccess = memberAccountIds.length > 0;
  if (hasAccess) {
    const rows = await db
      .select({ mfaRequired: accounts.mfaRequired })
      .from(accounts)
      .where(inArray(accounts.accountId, memberAccountIds));
    const accountMfaRequired = rows.some((r) => r.mfaRequired);
    if (mfaGateBlocks({ accountMfaRequired }, input.tokenId, input.mfaAal)) {
      return { ok: false, reason: 'mfa_required' };
    }
  }
  if (!(await claimChatLoginToken(input.user.platform, input.login.nonce, input.login.exp))) {
    const link = await lookupChatIdentity(input.user);
    return link?.userId === input.userId ? { ok: true, hasAccess, fresh: false } : { ok: false, reason: 'used' };
  }
  const linked = await linkChatIdentity(input.user, input.userId, { mfaVerified: input.mfaAal === 'aal2' });
  if (!linked.ok) return linked;
  return { ok: true, hasAccess, fresh: true };
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
 * project. `action` defaults to running a session, `project.session.start`:
 * the bar the web holds starting a session and prompting one to, and one a
 * plain project `member` holds. Until 2026-09-29 it was `project.write`,
 * which only managers hold, so a member who used Kortix on the web got
 * "Request access" in Slack and Teams, and an approved request (which grants
 * `member`) did not change that. Channel settings ask for
 * `project.connector.write` (core/settings.ts); review decisions ask for
 * `project.review.act`.
 */
export async function resolveChatActor(
  user: ChatUser,
  project: { projectId: string; accountId: string },
  action: string = PROJECT_ACTIONS.PROJECT_SESSION_START,
): Promise<ChatActor> {
  if (!user.workspaceId || !user.platformUserId) return { reason: 'unlinked' };
  const link = await lookupChatIdentity(user);
  if (!link) return { reason: 'unlinked' };
  if (!(await isAccountMember(link.userId, project.accountId))) return { reason: 'not_member' };
  // Role-only is the honest classification: the webhook has no token of its
  // own. The second factor is the one the link was made with.
  const verdict = await authorize(
    actorForUser(link.userId, project.accountId, link.mfaVerified ? { mfaAal: 'aal2' } : {}),
    action,
    { type: 'project', id: project.projectId },
  );
  // The account requires MFA and this link was made without it: linking
  // again from a Kortix session that passed MFA fixes it, so ask for that,
  // not for project access the person may already have.
  if (!verdict.allowed && verdict.reason === 'account_mfa_required') return { reason: 'unlinked' };
  if (!verdict.allowed) return { reason: 'not_member' };
  return { userId: link.userId };
}

/** `resolveChatActor` for a project known only by id. A missing project is `not_member`. */
export async function resolveProjectChatActor(
  user: ChatUser,
  projectId: string,
  action: string = PROJECT_ACTIONS.PROJECT_SESSION_START,
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

  // Only a project connected to this chat workspace. The id comes from the
  // card or button, so without the join anyone linked could file requests
  // against any project on the platform.
  const [project] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .innerJoin(
      chatInstalls,
      and(
        eq(chatInstalls.projectId, projects.projectId),
        eq(chatInstalls.platform, user.platform),
        eq(chatInstalls.workspaceId, user.workspaceId),
      ),
    )
    .where(eq(projects.projectId, projectId))
    .limit(1);
  if (!project) return { status: 'no-project' };

  const base = { requesterUserId: identity.userId, accountId: project.accountId };
  // The same check the message path makes: someone who can already run a
  // session here needs no request, and a link an MFA account cannot use
  // needs a new sign-in, not project access.
  const actor = await resolveChatActor(user, { projectId, accountId: project.accountId });
  if ('userId' in actor) return { status: 'already-member', ...base };
  if (actor.reason === 'unlinked') return { status: 'no-identity' };

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
