import type { Effect } from 'effect';
import { and, eq } from 'drizzle-orm';
import {
  chatThreadParticipants,
  projectSessionGrants,
  projectSessions,
} from '@kortix/db';
import { sharedConfig as config, sharedDb as db } from '../../shared/effect';
import { loadSlackTokenForProject } from '../install-store';
import { postEphemeral } from '../slack-api';
import { escapeMrkdwn, sessionWebUrl } from './util';
import { lookupEmailsByUserIds } from '../../projects/lib/access';
import { lookupSlackIdentity, lookupSlackUserIdForKortixUser } from './identity';

const PLATFORM = 'slack';

export type SlackConversationPolicy = 'owner_approval' | 'owner_only' | 'project_open';

export function normalizeConversationPolicy(value: unknown): SlackConversationPolicy {
  return value === 'owner_only' || value === 'project_open' || value === 'owner_approval'
    ? value
    : 'project_open';
}

export function conversationPolicyLabel(policy: SlackConversationPolicy): string {
  if (policy === 'project_open') return 'Project members can join';
  if (policy === 'owner_only') return 'Owner only';
  return 'Owner approval';
}

function policyFromMetadata(metadata: Record<string, unknown> | null | undefined): SlackConversationPolicy | null {
  const slack = metadata?.slack;
  if (!slack || typeof slack !== 'object') return null;
  return normalizeConversationPolicy((slack as Record<string, unknown>).conversation_policy);
}

async function grantSessionMember(sessionId: string, userId: string): Promise<void> {
  await db
    .insert(projectSessionGrants)
    .values({ sessionId, principalType: 'member', principalId: userId })
    .onConflictDoNothing({
      target: [
        projectSessionGrants.sessionId,
        projectSessionGrants.principalType,
        projectSessionGrants.principalId,
      ],
    });
}

async function approvedParticipantExists(input: {
  teamId: string;
  threadId: string;
  slackUserId: string;
  actorUserId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({ participantId: chatThreadParticipants.participantId })
    .from(chatThreadParticipants)
    .where(and(
      eq(chatThreadParticipants.platform, PLATFORM),
      eq(chatThreadParticipants.workspaceId, input.teamId),
      eq(chatThreadParticipants.threadId, input.threadId),
      eq(chatThreadParticipants.platformUserId, input.slackUserId),
      eq(chatThreadParticipants.userId, input.actorUserId),
      eq(chatThreadParticipants.status, 'approved'),
    ))
    .limit(1);
  return !!row;
}

async function loadParticipant(input: {
  teamId: string;
  threadId: string;
  slackUserId: string;
}) {
  const [row] = await db
    .select({
      status: chatThreadParticipants.status,
      userId: chatThreadParticipants.userId,
    })
    .from(chatThreadParticipants)
    .where(and(
      eq(chatThreadParticipants.platform, PLATFORM),
      eq(chatThreadParticipants.workspaceId, input.teamId),
      eq(chatThreadParticipants.threadId, input.threadId),
      eq(chatThreadParticipants.platformUserId, input.slackUserId),
    ))
    .limit(1);
  return row ?? null;
}

function threadJoinRequestBlocks(input: {
  requesterLabel: string;
  projectId: string;
  sessionId: string;
  threadId: string;
  requesterUserId: string;
  requesterSlackUserId: string;
}): unknown[] {
  const value = JSON.stringify({
    projectId: input.projectId,
    sessionId: input.sessionId,
    threadId: input.threadId,
    requesterUserId: input.requesterUserId,
    requesterSlackUserId: input.requesterSlackUserId,
  });
  return [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${escapeMrkdwn(input.requesterLabel)}* wants to join this Kortix session.\nThis Slack thread is private until you approve them.`,
      },
    },
    {
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Approve', emoji: true },
          style: 'primary',
          action_id: 'slack_thread_join_approve',
          value,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: 'Deny', emoji: true },
          style: 'danger',
          action_id: 'slack_thread_join_deny',
          value,
        },
      ],
    },
  ];
}

async function requesterLabel(userId: string, slackUserId: string): Promise<string> {
  const email = (await lookupEmailsByUserIds([userId]).catch(() => null))?.get(userId);
  return email || `<@${slackUserId}>`;
}

async function postJoinRequest(input: {
  projectId: string;
  teamId: string;
  channel?: string;
  threadId: string;
  sessionId: string;
  requesterUserId: string;
  requesterSlackUserId: string;
  ownerUserId: string | null;
  alreadyPending: boolean;
}): Promise<void> {
  if (!input.channel) return;
  const token = await loadSlackTokenForProject(input.projectId);
  if (!token) return;

  const requesterText = input.alreadyPending
    ? "You're still waiting for the session owner to approve access to this private thread."
    : "I asked the session owner to approve access to this private thread. I won't send your message until they approve.";
  await postEphemeral(
    token,
    input.channel,
    input.requesterSlackUserId,
    requesterText,
    [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*This Kortix session is private.*\n${requesterText}`,
        },
      },
    ],
    input.threadId,
  );

  if (input.alreadyPending || !input.ownerUserId) return;
  const ownerSlackUserId = await lookupSlackUserIdForKortixUser(input.teamId, input.ownerUserId);
  if (!ownerSlackUserId) return;
  const label = await requesterLabel(input.requesterUserId, input.requesterSlackUserId);
  await postEphemeral(
    token,
    input.channel,
    ownerSlackUserId,
    `${label} wants to join this Kortix session.`,
    threadJoinRequestBlocks({
      requesterLabel: label,
      projectId: input.projectId,
      sessionId: input.sessionId,
      threadId: input.threadId,
      requesterUserId: input.requesterUserId,
      requesterSlackUserId: input.requesterSlackUserId,
    }),
    input.threadId,
  );
}

export async function ensureSlackThreadParticipant(input: {
  projectId: string;
  teamId: string;
  channel?: string;
  threadId: string;
  sessionId: string;
  sessionOwnerId: string | null;
  sessionMetadata: Record<string, unknown> | null | undefined;
  channelPolicy: string | null | undefined;
  slackUserId: string;
  actorUserId: string;
}): Promise<boolean> {
  const policy = policyFromMetadata(input.sessionMetadata) ?? normalizeConversationPolicy(input.channelPolicy);

  if (input.sessionOwnerId && input.actorUserId === input.sessionOwnerId) {
    return true;
  }

  if (policy === 'project_open') {
    await grantSessionMember(input.sessionId, input.actorUserId);
    return true;
  }

  const token = input.channel ? await loadSlackTokenForProject(input.projectId) : null;
  if (policy === 'owner_only') {
    if (token && input.channel) {
      await postEphemeral(
        token,
        input.channel,
        input.slackUserId,
        'This Kortix session is owner-only.',
        [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: '*This Kortix session is owner-only.*\nStart a new thread if you want Kortix to work with you separately.',
            },
          },
        ],
        input.threadId,
      );
    }
    return false;
  }

  if (await approvedParticipantExists(input)) {
    await grantSessionMember(input.sessionId, input.actorUserId);
    return true;
  }

  const existing = await loadParticipant(input);
  if (existing?.status === 'denied') {
    if (token && input.channel) {
      await postEphemeral(
        token,
        input.channel,
        input.slackUserId,
        'The session owner declined your request for this thread.',
        [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: "*You don't have access to this Kortix session.*\nThe owner declined your request. Start a new thread to work with Kortix separately.",
            },
          },
        ],
        input.threadId,
      );
    }
    return false;
  }

  let inserted = false;
  if (existing && existing.userId !== input.actorUserId) {
    await db
      .update(chatThreadParticipants)
      .set({
        sessionId: input.sessionId,
        userId: input.actorUserId,
        status: 'pending',
        decidedAt: null,
        decidedByUserId: null,
        updatedAt: new Date(),
      })
      .where(and(
        eq(chatThreadParticipants.platform, PLATFORM),
        eq(chatThreadParticipants.workspaceId, input.teamId),
        eq(chatThreadParticipants.threadId, input.threadId),
        eq(chatThreadParticipants.platformUserId, input.slackUserId),
      ));
    inserted = true;
  } else if (!existing) {
    const rows = await db
      .insert(chatThreadParticipants)
      .values({
        platform: PLATFORM,
        workspaceId: input.teamId,
        threadId: input.threadId,
        sessionId: input.sessionId,
        platformUserId: input.slackUserId,
        userId: input.actorUserId,
        status: 'pending',
      })
      .onConflictDoNothing({
        target: [
          chatThreadParticipants.platform,
          chatThreadParticipants.workspaceId,
          chatThreadParticipants.threadId,
          chatThreadParticipants.platformUserId,
        ],
      })
      .returning({ participantId: chatThreadParticipants.participantId });
    inserted = rows.length > 0;
  }

  await postJoinRequest({
    projectId: input.projectId,
    teamId: input.teamId,
    channel: input.channel,
    threadId: input.threadId,
    sessionId: input.sessionId,
    requesterUserId: input.actorUserId,
    requesterSlackUserId: input.slackUserId,
    ownerUserId: input.sessionOwnerId,
    alreadyPending: !inserted,
  });
  return false;
}

export async function rememberSlackThreadOwner(input: {
  teamId: string;
  threadId: string;
  sessionId: string;
  slackUserId: string;
  userId: string;
}): Promise<void> {
  await db
    .insert(chatThreadParticipants)
    .values({
      platform: PLATFORM,
      workspaceId: input.teamId,
      threadId: input.threadId,
      sessionId: input.sessionId,
      platformUserId: input.slackUserId,
      userId: input.userId,
      status: 'approved',
      decidedAt: new Date(),
      decidedByUserId: input.userId,
    })
    .onConflictDoUpdate({
      target: [
        chatThreadParticipants.platform,
        chatThreadParticipants.workspaceId,
        chatThreadParticipants.threadId,
        chatThreadParticipants.platformUserId,
      ],
      set: {
        sessionId: input.sessionId,
        userId: input.userId,
        status: 'approved',
        decidedAt: new Date(),
        decidedByUserId: input.userId,
        updatedAt: new Date(),
      },
    });
}

export async function decideSlackThreadJoin(input: {
  teamId: string;
  channelId: string;
  deciderSlackUserId: string;
  projectId: string;
  sessionId: string;
  threadId: string;
  requesterUserId: string;
  requesterSlackUserId: string;
  decision: 'approved' | 'denied';
}): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  const decider = await lookupSlackIdentity(input.teamId, input.deciderSlackUserId);
  if (!decider) return { ok: false, text: 'Connect your Kortix account before approving session access.' };

  const [session] = await db
    .select({ createdBy: projectSessions.createdBy })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, input.sessionId))
    .limit(1);
  if (!session) return { ok: false, text: 'This Kortix session no longer exists.' };
  if (!session.createdBy || session.createdBy !== decider.userId) {
    return { ok: false, text: 'Only the session owner can approve people for this thread.' };
  }

  const now = new Date();
  await db
    .insert(chatThreadParticipants)
    .values({
      platform: PLATFORM,
      workspaceId: input.teamId,
      threadId: input.threadId,
      sessionId: input.sessionId,
      platformUserId: input.requesterSlackUserId,
      userId: input.requesterUserId,
      status: input.decision,
      decidedAt: now,
      decidedByUserId: decider.userId,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        chatThreadParticipants.platform,
        chatThreadParticipants.workspaceId,
        chatThreadParticipants.threadId,
        chatThreadParticipants.platformUserId,
      ],
      set: {
        sessionId: input.sessionId,
        userId: input.requesterUserId,
        status: input.decision,
        decidedAt: now,
        decidedByUserId: decider.userId,
        updatedAt: now,
      },
    });

  if (input.decision === 'approved') {
    await grantSessionMember(input.sessionId, input.requesterUserId);
  }

  const token = await loadSlackTokenForProject(input.projectId);
  const sessionUrl = sessionWebUrl(config.FRONTEND_URL, input.projectId, input.sessionId);
  if (token) {
    const text = input.decision === 'approved'
      ? `You've been approved for this Kortix session. Send your message again and I'll continue.`
      : 'The session owner declined your request for this Kortix session.';
    await postEphemeral(
      token,
      input.channelId,
      input.requesterSlackUserId,
      text,
      [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: input.decision === 'approved'
              ? `*Approved.*\nSend your message again in this thread. You can also <${sessionUrl}|open the session in Kortix>.`
              : '*Request declined.*\nStart a new thread if you want Kortix to work with you separately.',
          },
        },
      ],
      input.threadId,
    );
  }

  const label = await requesterLabel(input.requesterUserId, input.requesterSlackUserId);
  return {
    ok: true,
    text: input.decision === 'approved'
      ? `Approved ${label} for this Kortix session.`
      : `Denied ${label} for this Kortix session.`,
  };
}
