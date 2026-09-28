import { accountRoleMap, isAccountManagerRole } from '../../iam/read-models';
import { config } from '../../config';
import { notifyProjectAccessRequestManagers } from '../../projects/lib/access-requests';
import { lookupEmailsByUserIds } from '../../projects/lib/access';
import { loadSlackTokenForProject } from '../install-store';
import { openDmChannel, postBlocks, postEphemeral } from '../slack-api';
import { lookupChatUserForKortixUser } from '../core/identity';
import { createPendingSlackAuthMessage } from './auth-resume';
import { buildSlackLoginUrl } from './login';
import { dashboardBase } from './util';
import type { SlackEnvelope, SlackEvent } from './types';

// The Slack rendering of the chat identity link (core/identity.ts owns the
// link itself and the actor check).

// ── In-thread identity / access nudges ───────────────────────────────────────
// When an unlinked or no-access sender @-mentions Kortix we answer right where
// they asked — an ephemeral (“only visible to you”) message in the same thread —
// instead of a separate DM. Two states, two affordances:
//   • unlinked   → "Connect your Kortix account" (opens the /login web flow)
//   • not_member → "Request access" (files a project access request for an admin)
// Connecting is decoupled from access, so a brand-new user connects once and then
// requests access in-thread without bouncing off a hard "ask an admin" wall.

export function connectAccountBlocks(url: string, pendingId?: string | null): unknown[] {
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: 'Kortix needs a linked Kortix account before it can run from Slack. Connect or create one to continue. _Only you can see this._',
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Connect or create account', emoji: true },
          style: 'primary',
          value: JSON.stringify({ url, ...(pendingId ? { pendingId } : {}) }),
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
  envelope?: SlackEnvelope;
  event?: SlackEvent;
}): Promise<void> {
  const token = await loadSlackTokenForProject(input.projectId);
  if (!token) return;

  let blocks: unknown[];
  let fallback: string;
  if (input.reason === 'unlinked') {
    const pendingId = input.envelope && input.event
      ? await createPendingSlackAuthMessage({
        projectId: input.projectId,
        teamId: input.teamId,
        slackUserId: input.slackUserId,
        envelope: input.envelope,
        event: input.event,
      })
      : null;
    blocks = connectAccountBlocks(buildSlackLoginUrl({
      teamId: input.teamId,
      slackUserId: input.slackUserId,
      ...(pendingId ? { pendingId } : {}),
    }), pendingId);
    fallback = 'Kortix needs a linked Kortix account to continue.';
  } else {
    blocks = requestAccessBlocks(input.projectId);
    fallback = "You're connected, but don't have access to this project yet.";
  }

  // Send BOTH: an in-thread ephemeral for context right where they asked, AND a
  // DM. The DM pushes a real notification and persists — an ephemeral alone is
  // silent and vanishes on reload, so on its own it reads as "no response."
  if (input.channel) {
    await postEphemeral(token, input.channel, input.slackUserId, fallback, blocks, input.threadTs);
  }
  const dm = await openDmChannel(token, input.slackUserId);
  if (dm) await postBlocks(token, dm, fallback, blocks);
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
  await notifyProjectAccessRequestManagers({
    accountId: input.accountId,
    projectId: input.projectId,
    requesterUserId: input.requesterUserId,
  });

  const token = await loadSlackTokenForProject(input.projectId);
  if (!token) return;

  const admins = [...(await accountRoleMap(input.accountId)).entries()]
    .filter(([, role]) => isAccountManagerRole(role))
    .map(([userId]) => ({ userId }));
  if (admins.length === 0) return;

  const email = (await lookupEmailsByUserIds([input.requesterUserId]).catch(() => null))?.get(
    input.requesterUserId,
  );
  const who = email ? `*${email}*` : `<@${input.requesterSlackUserId}>`;
  const projectUrl = `${dashboardBase(config.FRONTEND_URL)}/projects/${input.projectId}/customize/members`;
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
    const slackId = await lookupChatUserForKortixUser('slack', input.teamId, admin.userId);
    if (!slackId) continue;
    const dm = await openDmChannel(token, slackId);
    if (!dm) continue;
    await postBlocks(token, dm, text, blocks);
  }
}
