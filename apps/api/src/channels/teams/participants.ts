import { and, eq } from 'drizzle-orm';
import { chatThreadParticipants, projectSessionGrants, projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { config } from '../../config';
import { lookupEmailsByUserIds } from '../../projects/lib/access';
import { sessionWebUrl } from '../slack/util';
import { sendCard } from '../teams-api';
import { buildJoinRequestCard, buildNoticeCard } from './cards';
import { chatUser, lookupChatIdentity } from '../core/identity';
import type { TeamsConversationRef } from './types';

/**
 * Who may continue a Teams-started session — the Teams twin of
 * `channels/slack/participants.ts`, over the same `chat_thread_participants`
 * table and the same three policies:
 *
 * - `project_open` (default): any linked project member joins on first message.
 * - `owner_only`: only the person who started the session; others are told so.
 * - `owner_approval`: the first message from someone else is held; the owner
 *   gets an Approve / Deny card in the conversation; the requester is told to
 *   send again once approved.
 *
 * Teams has no ephemeral messages, so what Slack whispers to one person here
 * REPLACES that person's own live card (the "Working on it…" already posted
 * for their message), and the owner's Approve / Deny card is a normal card
 * whose buttons only the owner can act on (`decideTeamsThreadJoin` checks).
 */

const PLATFORM = 'teams';

export type TeamsConversationPolicy = 'owner_approval' | 'owner_only' | 'project_open';

export function normalizeConversationPolicy(value: unknown): TeamsConversationPolicy {
  return value === 'owner_only' || value === 'project_open' || value === 'owner_approval'
    ? value
    : 'project_open';
}

export function conversationPolicyLabel(policy: TeamsConversationPolicy): string {
  if (policy === 'project_open') return 'Project members can join';
  if (policy === 'owner_only') return 'Owner only';
  return 'Owner approval';
}

/** The policy frozen on the session at creation wins over the conversation's current one. */
export function policyFromMetadata(
  metadata: Record<string, unknown> | null | undefined,
): TeamsConversationPolicy | null {
  const teams = metadata?.teams;
  if (!teams || typeof teams !== 'object') return null;
  const value = (teams as Record<string, unknown>).conversation_policy;
  return value === undefined || value === null ? null : normalizeConversationPolicy(value);
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

async function loadParticipant(input: { tenantId: string; conversationId: string; teamsUserId: string }) {
  const [row] = await db
    .select({ status: chatThreadParticipants.status, userId: chatThreadParticipants.userId })
    .from(chatThreadParticipants)
    .where(
      and(
        eq(chatThreadParticipants.platform, PLATFORM),
        eq(chatThreadParticipants.workspaceId, input.tenantId),
        eq(chatThreadParticipants.threadId, input.conversationId),
        eq(chatThreadParticipants.platformUserId, input.teamsUserId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function requesterLabel(userId: string, fallback: string): Promise<string> {
  const email = (await lookupEmailsByUserIds([userId]).catch(() => null))?.get(userId);
  return email || fallback;
}

export type ParticipantVerdict =
  | { allowed: true }
  /** Not allowed; `notice` is what the requester's own live card should now say. */
  | { allowed: false; notice: string };

export async function ensureTeamsThreadParticipant(input: {
  projectId: string;
  tenantId: string;
  conversationId: string;
  sessionId: string;
  sessionOwnerId: string | null;
  sessionMetadata: Record<string, unknown> | null | undefined;
  channelPolicy: string | null | undefined;
  teamsUserId: string;
  requesterName: string;
  actorUserId: string;
  ref: TeamsConversationRef;
}): Promise<ParticipantVerdict> {
  const policy = policyFromMetadata(input.sessionMetadata) ?? normalizeConversationPolicy(input.channelPolicy);

  if (input.sessionOwnerId && input.actorUserId === input.sessionOwnerId) return { allowed: true };

  if (policy === 'project_open') {
    await grantSessionMember(input.sessionId, input.actorUserId);
    return { allowed: true };
  }

  if (policy === 'owner_only') {
    return {
      allowed: false,
      notice: 'This Kortix session is owner-only. Start a new conversation if you want Kortix to work with you separately.',
    };
  }

  const existing = await loadParticipant(input);
  if (existing?.status === 'approved' && existing.userId === input.actorUserId) {
    await grantSessionMember(input.sessionId, input.actorUserId);
    return { allowed: true };
  }
  if (existing?.status === 'denied') {
    return {
      allowed: false,
      notice: "You don't have access to this Kortix session — the owner declined your request. Start a new conversation to work with Kortix separately.",
    };
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
      .where(
        and(
          eq(chatThreadParticipants.platform, PLATFORM),
          eq(chatThreadParticipants.workspaceId, input.tenantId),
          eq(chatThreadParticipants.threadId, input.conversationId),
          eq(chatThreadParticipants.platformUserId, input.teamsUserId),
        ),
      );
    inserted = true;
  } else if (!existing) {
    const rows = await db
      .insert(chatThreadParticipants)
      .values({
        platform: PLATFORM,
        workspaceId: input.tenantId,
        threadId: input.conversationId,
        sessionId: input.sessionId,
        platformUserId: input.teamsUserId,
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

  if (inserted) {
    const label = await requesterLabel(input.actorUserId, input.requesterName);
    await sendCard(
      input.ref,
      buildJoinRequestCard({
        requesterLabel: label,
        projectId: input.projectId,
        sessionId: input.sessionId,
        conversationId: input.conversationId,
        requesterUserId: input.actorUserId,
        requesterTeamsUserId: input.teamsUserId,
      }),
    ).catch((err) => console.warn('[teams-participants] join request card failed', err));
  }

  return {
    allowed: false,
    notice: inserted
      ? "This Kortix session is private. I've asked the session owner to approve you — I won't send your message until they do."
      : "You're still waiting for the session owner to approve access to this conversation.",
  };
}

/** The person who started the session is its first approved participant. */
export async function rememberTeamsThreadOwner(input: {
  tenantId: string;
  conversationId: string;
  sessionId: string;
  teamsUserId: string;
  userId: string;
}): Promise<void> {
  const now = new Date();
  await db
    .insert(chatThreadParticipants)
    .values({
      platform: PLATFORM,
      workspaceId: input.tenantId,
      threadId: input.conversationId,
      sessionId: input.sessionId,
      platformUserId: input.teamsUserId,
      userId: input.userId,
      status: 'approved',
      decidedAt: now,
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
        decidedAt: now,
        decidedByUserId: input.userId,
        updatedAt: now,
      },
    });
}

export async function decideTeamsThreadJoin(input: {
  tenantId: string;
  conversationId: string;
  deciderTeamsUserId: string;
  projectId: string;
  sessionId: string;
  requesterUserId: string;
  requesterTeamsUserId: string;
  decision: 'approved' | 'denied';
  ref: TeamsConversationRef;
}): Promise<{ ok: boolean; text: string }> {
  const decider = await lookupChatIdentity(chatUser('teams', input.tenantId, input.deciderTeamsUserId));
  if (!decider) return { ok: false, text: 'Connect your Kortix account (`/login`) before approving session access.' };

  const [session] = await db
    .select({ createdBy: projectSessions.createdBy })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, input.sessionId))
    .limit(1);
  if (!session) return { ok: false, text: 'This Kortix session no longer exists.' };
  if (!session.createdBy || session.createdBy !== decider.userId) {
    return { ok: false, text: 'Only the session owner can approve people for this conversation.' };
  }

  const now = new Date();
  await db
    .insert(chatThreadParticipants)
    .values({
      platform: PLATFORM,
      workspaceId: input.tenantId,
      threadId: input.conversationId,
      sessionId: input.sessionId,
      platformUserId: input.requesterTeamsUserId,
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

  if (input.decision === 'approved') await grantSessionMember(input.sessionId, input.requesterUserId);

  const label = await requesterLabel(input.requesterUserId, 'They');
  const sessionUrl = sessionWebUrl(config.FRONTEND_URL, input.projectId, input.sessionId);
  // Tell the requester in the conversation (no ephemeral in Teams): they know
  // to send again, and everyone else sees the thread is open now.
  await sendCard(
    input.ref,
    buildNoticeCard(
      input.decision === 'approved'
        ? `${label} — you're approved for this Kortix session. Send your message again and I'll continue. You can also [open the session in Kortix](${sessionUrl}).`
        : `${label} — the session owner declined your request for this Kortix session. Start a new conversation to work with Kortix separately.`,
      input.decision === 'approved' ? '✅' : '🚫',
    ),
  ).catch((err) => console.warn('[teams-participants] decision notice failed', err));

  return {
    ok: true,
    text: input.decision === 'approved' ? `Approved ${label} for this Kortix session.` : `Denied ${label} for this Kortix session.`,
  };
}
