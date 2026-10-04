import { and, eq } from 'drizzle-orm';
import { chatThreadParticipants, chatThreads, projectSessionGrants, projectSessions } from '@kortix/db';
import { db } from '../../../lib/db';
import { config } from '../../../lib/config';
import { lookupEmailsByUserIds } from '../../projects/lib/access';
import { sessionWebUrl } from '../slack/util';
import { conversationMemberId } from '../teams-api';
import { buildJoinRequestCard, buildNoticeCard } from './cards';
import { sendCardPrivately } from './private-reply';
import { chatUser, lookupChatIdentity, resolveProjectChatActor } from '../core/identity';
import type { TeamsConversationRef } from './types';

/**
 * Who may continue a Teams-started session — the Teams twin of
 * `services/channels/slack/participants.ts`, over the same `chat_thread_participants`
 * table and the same three policies:
 *
 * - `project_open` (default): any linked project member joins on first message.
 * - `owner_only`: only the person who started the session; others are told so.
 * - `owner_approval`: the first message from someone else is held; the owner
 *   gets an Approve / Deny card in the conversation; the requester is told to
 *   send again once approved.
 *
 * What Slack whispers to one person here goes to that person alone in a
 * Teams targeted message (private-reply.ts): the refusal to the requester
 * (session.ts), the owner's Approve / Deny card, and the decision. When Teams
 * refuses a targeted message the card goes to the whole conversation, and the
 * buttons still work only for the owner (`decideTeamsThreadJoin` checks).
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
    .select({
      participantId: chatThreadParticipants.participantId,
      status: chatThreadParticipants.status,
      userId: chatThreadParticipants.userId,
      sessionId: chatThreadParticipants.sessionId,
    })
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

/** The Teams user id (`29:…`) of whoever started the session: its owner. */
function sessionStarterTeamsId(metadata: Record<string, unknown> | null | undefined): string | null {
  const teams = metadata?.teams;
  const user = teams && typeof teams === 'object' ? (teams as Record<string, unknown>).user : null;
  return typeof user === 'string' && user ? user : null;
}

async function requesterLabel(userId: string, fallback: string): Promise<string> {
  const email = (await lookupEmailsByUserIds([userId]).catch(() => null))?.get(userId);
  return email || fallback;
}

export type ParticipantVerdict =
  | { allowed: true }
  /** Not allowed; `notice` is what the requester alone is told (session.ts). */
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

  // A row is per conversation, but a decision is about one session: after
  // `/new`, or once the old session is gone, an old approval or denial must
  // not carry over to the next session's owner.
  const loaded = await loadParticipant(input);
  const existing = loaded && loaded.sessionId === input.sessionId ? loaded : null;
  if (existing?.status === 'approved' && existing.userId === input.actorUserId) {
    await grantSessionMember(input.sessionId, input.actorUserId);
    return { allowed: true };
  }
  if (existing?.status === 'denied' && existing.userId === input.actorUserId) {
    return {
      allowed: false,
      notice: "You don't have access to this Kortix session — the owner declined your request. Start a new conversation to work with Kortix separately.",
    };
  }

  let inserted = false;
  if (loaded && (loaded.userId !== input.actorUserId || loaded.sessionId !== input.sessionId)) {
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
  } else if (!loaded) {
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
    await sendCardPrivately(
      input.ref,
      sessionStarterTeamsId(input.sessionMetadata),
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

/**
 * The session owner decides a join request from the Approve / Deny card.
 *
 * The card's data names the session and the requester, and cards are not
 * proof: an agent can post any Adaptive Card into its conversation. So the
 * decision applies only to a request this conversation actually raised for
 * its current session (`ensureTeamsThreadParticipant` wrote it, pending), and
 * the requester's Kortix account is the one that request recorded, never the
 * card's. The owner must still be able to work in the project.
 */
export async function decideTeamsThreadJoin(input: {
  tenantId: string;
  conversationId: string;
  deciderTeamsUserId: string;
  requesterTeamsUserId: string;
  decision: 'approved' | 'denied';
  ref: TeamsConversationRef;
}): Promise<{ ok: boolean; text: string }> {
  const closed = { ok: false, text: 'This request is no longer open.' };
  const deciderUser = chatUser('teams', input.tenantId, input.deciderTeamsUserId);
  const decider = await lookupChatIdentity(deciderUser);
  if (!decider) return { ok: false, text: 'Connect your Kortix account (`/login`) before approving session access.' };

  const [thread] = await db
    .select({ sessionId: chatThreads.sessionId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, PLATFORM),
        eq(chatThreads.workspaceId, input.tenantId),
        eq(chatThreads.threadId, input.conversationId),
      ),
    )
    .limit(1);
  const request = await loadParticipant({
    tenantId: input.tenantId,
    conversationId: input.conversationId,
    teamsUserId: input.requesterTeamsUserId,
  });
  if (!thread?.sessionId || !request || request.status !== 'pending' || request.sessionId !== thread.sessionId || !request.userId) {
    return closed;
  }
  const sessionId = thread.sessionId;
  const requesterUserId = request.userId;

  const [session] = await db
    .select({ createdBy: projectSessions.createdBy, projectId: projectSessions.projectId })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  if (!session) return { ok: false, text: 'This Kortix session no longer exists.' };
  if (!session.createdBy || session.createdBy !== decider.userId) {
    return { ok: false, text: 'Only the session owner can approve people for this conversation.' };
  }
  if (!('userId' in (await resolveProjectChatActor(deciderUser, session.projectId)))) {
    return { ok: false, text: 'Your Kortix account no longer has access to this project, so you cannot approve people for it.' };
  }

  const now = new Date();
  const decided = await db
    .update(chatThreadParticipants)
    .set({ status: input.decision, decidedAt: now, decidedByUserId: decider.userId, updatedAt: now })
    .where(
      and(
        eq(chatThreadParticipants.participantId, request.participantId),
        // One decision per request, even when two clicks race.
        eq(chatThreadParticipants.status, 'pending'),
      ),
    )
    .returning({ participantId: chatThreadParticipants.participantId });
  if (decided.length === 0) return closed;

  if (input.decision === 'approved') await grantSessionMember(sessionId, requesterUserId);

  const label = await requesterLabel(requesterUserId, 'They');
  const sessionUrl = sessionWebUrl(config.FRONTEND_URL, session.projectId, sessionId);
  // Tell the requester alone: they know to send again. The request stored
  // their Entra object id; a targeted message needs their Teams user id.
  const ref = { ...input.ref, projectId: session.projectId };
  await sendCardPrivately(
    ref,
    await conversationMemberId(ref, input.requesterTeamsUserId),
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
