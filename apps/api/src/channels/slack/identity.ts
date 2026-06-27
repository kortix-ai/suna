import { and, eq, inArray, isNull } from 'drizzle-orm';
import { accountMembers, chatUserIdentities, projectAccessRequests, projects } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { lookupEmailsByUserIds } from '../../projects/lib/access';
import { loadSlackTokenForProject } from '../install-store';
import { openDmChannel, postBlocks, postEphemeral } from '../slack-api';
import { buildSlackLoginUrl } from './login';
import { dashboardBase } from './util';

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

// ── In-thread identity / access nudges ───────────────────────────────────────
// When an unlinked or no-access sender @-mentions Kortix we answer right where
// they asked — an ephemeral (“only visible to you”) message in the same thread —
// instead of a separate DM. Two states, two affordances:
//   • unlinked   → "Connect your Kortix account" (opens the /login web flow)
//   • not_member → "Request access" (files a project access request for an admin)
// Connecting is decoupled from access, so a brand-new user connects once and then
// requests access in-thread without bouncing off a hard "ask an admin" wall.

export function connectAccountBlocks(url: string): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Kortix runs as *your own* Kortix account — connect it once to continue. _Only you can see this._',
      },
    },
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
  ];
}

export function requestAccessBlocks(projectId: string): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: "You're connected, but your Kortix account doesn't have access to this project yet. Request access and an admin will approve it. _Only you can see this._",
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Request access', emoji: true },
          style: 'primary',
          value: JSON.stringify({ projectId }),
          action_id: 'slack_request_access',
        },
      ],
    },
  ];
}

export async function postIdentityPrompt(input: {
  projectId: string;
  teamId: string;
  channel?: string;
  threadTs?: string;
  slackUserId: string;
  reason: 'unlinked' | 'not_member';
}): Promise<void> {
  const token = await loadSlackTokenForProject(input.projectId);
  if (!token) return;

  const { blocks, fallback } =
    input.reason === 'unlinked'
      ? {
          blocks: connectAccountBlocks(
            buildSlackLoginUrl({ teamId: input.teamId, slackUserId: input.slackUserId }),
          ),
          fallback: 'Connect your Kortix account to continue.',
        }
      : {
          blocks: requestAccessBlocks(input.projectId),
          fallback: "You're connected, but don't have access to this project yet.",
        };

  // Send BOTH: an in-thread ephemeral for context right where they asked, AND a
  // DM. The DM pushes a real notification and persists — an ephemeral alone is
  // silent and vanishes on reload, so on its own it reads as "no response."
  if (input.channel) {
    await postEphemeral(token, input.channel, input.slackUserId, fallback, blocks, input.threadTs);
  }
  const dm = await openDmChannel(token, input.slackUserId);
  if (dm) await postBlocks(token, dm, fallback, blocks);
}

export type AccessRequestOutcome =
  | { status: 'created' | 'pending' | 'already-member'; requesterUserId: string; accountId: string }
  | { status: 'no-identity' | 'no-project' };

// File (or find the existing pending) project access request for the Slack sender,
// reusing the same projectAccessRequests table the web "Request access" flow uses.
// Idempotent: a second click while one is pending returns 'pending', not a dupe.
export async function createSlackAccessRequest(input: {
  teamId: string;
  slackUserId: string;
  projectId: string;
}): Promise<AccessRequestOutcome> {
  const identity = await lookupSlackIdentity(input.teamId, input.slackUserId);
  if (!identity) return { status: 'no-identity' };

  const [project] = await db
    .select({ accountId: projects.accountId })
    .from(projects)
    .where(eq(projects.projectId, input.projectId))
    .limit(1);
  if (!project) return { status: 'no-project' };

  const base = { requesterUserId: identity.userId, accountId: project.accountId };
  if (await isAccountMember(identity.userId, project.accountId)) {
    return { status: 'already-member', ...base };
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
    message: null,
  });
  return { status: 'created', ...base };
}

// DM every account admin (owner/admin) who has a linked Slack identity in this
// workspace that a new access request is waiting, with a link to review it in
// Kortix. Best-effort — an admin without a Slack link still sees it on the web
// Members screen (the same request row powers both).
export async function notifyAdminsOfAccessRequest(input: {
  teamId: string;
  projectId: string;
  accountId: string;
  requesterUserId: string;
  requesterSlackUserId: string;
}): Promise<void> {
  const token = await loadSlackTokenForProject(input.projectId);
  if (!token) return;

  const admins = await db
    .select({ userId: accountMembers.userId })
    .from(accountMembers)
    .where(
      and(
        eq(accountMembers.accountId, input.accountId),
        inArray(accountMembers.accountRole, ['owner', 'admin']),
      ),
    );
  if (admins.length === 0) return;

  const email = (await lookupEmailsByUserIds([input.requesterUserId]).catch(() => null))?.get(
    input.requesterUserId,
  );
  const who = email ? `*${email}*` : `<@${input.requesterSlackUserId}>`;
  const projectUrl = `${dashboardBase(config.FRONTEND_URL)}/projects/${input.projectId}`;
  const text = `${who} requested access to a Kortix project in this workspace.`;
  const blocks = [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: `${text}\nOpen *Members* in Kortix to approve.` },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Review in Kortix', emoji: true },
          style: 'primary',
          url: projectUrl,
          action_id: 'slack_open_access_review',
        },
      ],
    },
  ];

  for (const admin of admins) {
    if (admin.userId === input.requesterUserId) continue;
    const slackId = await lookupSlackUserIdForKortixUser(input.teamId, admin.userId);
    if (!slackId) continue;
    const dm = await openDmChannel(token, slackId);
    if (!dm) continue;
    await postBlocks(token, dm, text, blocks);
  }
}

// Reverse of lookupSlackIdentity: the Slack user a Kortix user is linked to in a
// given workspace, so we can DM admins about access requests.
async function lookupSlackUserIdForKortixUser(teamId: string, userId: string): Promise<string | null> {
  const [row] = await db
    .select({ slackUserId: chatUserIdentities.platformUserId })
    .from(chatUserIdentities)
    .where(
      and(
        eq(chatUserIdentities.platform, PLATFORM),
        eq(chatUserIdentities.workspaceId, teamId),
        eq(chatUserIdentities.userId, userId),
        isNull(chatUserIdentities.revokedAt),
      ),
    )
    .limit(1);
  return row?.slackUserId ?? null;
}
