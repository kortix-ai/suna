import { and, eq, isNull } from 'drizzle-orm';
import { accountMembers, chatUserIdentities } from '@kortix/db';
import { db } from '../../shared/db';
import { loadSlackTokenForProject } from '../install-store';
import { openDmChannel, postBlocks } from '../slack-api';
import { buildSlackLoginUrl } from './login';

const PLATFORM = 'slack';

export type SlackActor =
  | { userId: string }
  | { reason: 'unlinked' | 'not_member' };

// Resolve the Slack sender to the Kortix user they linked via `/login`, and
// confirm that user is a member of the project's account. This is the
// authoritative security gate: no live, member-backed mapping → no run.
export async function resolveSlackActor(
  teamId: string,
  slackUserId: string,
  accountId: string,
): Promise<SlackActor> {
  if (!teamId || !slackUserId) return { reason: 'unlinked' };

  const [link] = await db
    .select({ userId: chatUserIdentities.userId })
    .from(chatUserIdentities)
    .where(
      and(
        eq(chatUserIdentities.platform, PLATFORM),
        eq(chatUserIdentities.workspaceId, teamId),
        eq(chatUserIdentities.platformUserId, slackUserId),
        isNull(chatUserIdentities.revokedAt),
      ),
    )
    .limit(1);
  if (!link) return { reason: 'unlinked' };

  if (!(await isAccountMember(link.userId, accountId))) return { reason: 'not_member' };
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

export async function lookupSlackIdentity(
  teamId: string,
  slackUserId: string,
): Promise<{ userId: string } | null> {
  const [row] = await db
    .select({ userId: chatUserIdentities.userId })
    .from(chatUserIdentities)
    .where(
      and(
        eq(chatUserIdentities.platform, PLATFORM),
        eq(chatUserIdentities.workspaceId, teamId),
        eq(chatUserIdentities.platformUserId, slackUserId),
        isNull(chatUserIdentities.revokedAt),
      ),
    )
    .limit(1);
  return row ?? null;
}

// Idempotent bind — used by the `/login` web flow and the installer auto-seed.
// A re-link (same Slack user, new Kortix user) overwrites the mapping and clears
// any prior revocation.
export async function linkSlackIdentity(input: {
  teamId: string;
  slackUserId: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(chatUserIdentities)
    .values({
      platform: PLATFORM,
      workspaceId: input.teamId,
      platformUserId: input.slackUserId,
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

export async function revokeSlackIdentity(teamId: string, slackUserId: string): Promise<boolean> {
  const rows = await db
    .update(chatUserIdentities)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(chatUserIdentities.platform, PLATFORM),
        eq(chatUserIdentities.workspaceId, teamId),
        eq(chatUserIdentities.platformUserId, slackUserId),
        isNull(chatUserIdentities.revokedAt),
      ),
    )
    .returning({ identityId: chatUserIdentities.identityId });
  return rows.length > 0;
}

// Nudge an unlinked / non-member sender to connect their own Kortix account.
// Sent as a DM — it pushes a notification and persists, so the user actually
// sees it (an ephemeral in the channel/thread is silent and easy to miss). The
// `<#channel>` link gives them context for where they triggered it.
export async function postLoginPrompt(input: {
  projectId: string;
  teamId: string;
  channel?: string;
  slackUserId: string;
  reason: 'unlinked' | 'not_member';
}): Promise<void> {
  const token = await loadSlackTokenForProject(input.projectId);
  if (!token) return;
  const dm = await openDmChannel(token, input.slackUserId);
  if (!dm) return;

  const url = buildSlackLoginUrl({ teamId: input.teamId, slackUserId: input.slackUserId });
  const where = input.channel ? ` in <#${input.channel}>` : '';
  const text =
    input.reason === 'not_member'
      ? `You messaged Kortix${where}, but that Kortix account isn't a member of this workspace's project. Ask an admin to add you, then connect again.`
      : `You messaged Kortix${where}. Kortix runs as *your own* Kortix account — connect it once to continue.`;

  await postBlocks(token, dm, text, [
    { type: 'section', text: { type: 'mrkdwn', text } },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Connect my Kortix account', emoji: true },
          style: 'primary',
          url,
          action_id: 'slack_login_connect',
        },
      ],
    },
  ]);
}
