import { and, eq, inArray } from 'drizzle-orm';
import { chatEventDedup, chatThreadParticipants, chatThreads, projectSessions } from '@kortix/db';
import { config } from '../../config';
import { db } from '../../shared/db';
import { normalizeConversationPolicy, policyFromMetadata } from './participants';
import { closeAbandonedTurn, deleteTurn, loadTurn } from './turn';
import { teamsMessageText, type TeamsConversationScope } from './util';

const PLATFORM = 'teams';

/**
 * How long a turn may go without writing a step and still count as running.
 * The same window session.ts uses to tell a live turn from an abandoned one.
 */
const TURN_LIVE_WINDOW_MS = 10 * 60 * 1000;

export type TeamsFreshStartOutcome =
  | { reset: true; previousSessionId: string | null }
  | { reset: false; notice: string };

/**
 * `/new` — detach this conversation from its session, so the next message
 * starts a fresh one.
 *
 * A personal or group chat is ONE conversation id for its whole life, and a
 * conversation maps permanently to one session (session.ts). Slack never
 * needs this: every new top-level message is a new thread, so a new session.
 * In a Teams chat every task anyone ever asked landed in the same session,
 * and nothing short of deleting that session gave the agent a clean slate.
 *
 * The previous session is not touched. It keeps its history in Kortix, and
 * its sandbox parks on its own schedule. Only the conversation's pointers go:
 *
 *  - the thread mapping, so the next message creates a session;
 *  - the join-policy participants — they were decided for THAT session, and a
 *    person its owner declined must not stay declined under a new owner;
 *  - the thread-create claim — it lives 5 minutes, and a new claim inside
 *    that window loses to the old one and then waits 8 s for a session that
 *    never comes ("lost thread-create claim");
 *  - the suppressed-error marker, so a new failure is reported again.
 */
export async function startFreshTeamsConversation(input: {
  tenantId: string;
  conversationId: string;
  scope: TeamsConversationScope;
  /** `teamsUserId(activity)`: the AAD object id when Teams sends one. */
  teamsUserId: string;
  /** The conversation's current policy, for a session that froze none. */
  channelPolicy?: string | null;
  /** Per-project (BYO) bot: detach only a session of this project. */
  projectId?: string;
}): Promise<TeamsFreshStartOutcome> {
  if (input.scope === 'channel') {
    return {
      reset: false,
      notice: 'In a channel, every new post starts its own session. Start a new post and @mention me.',
    };
  }

  const [thread] = await db
    .select({
      sessionId: chatThreads.sessionId,
      status: projectSessions.status,
      metadata: projectSessions.metadata,
    })
    .from(chatThreads)
    .leftJoin(projectSessions, eq(projectSessions.sessionId, chatThreads.sessionId))
    .where(
      and(
        eq(chatThreads.platform, PLATFORM),
        eq(chatThreads.workspaceId, input.tenantId),
        eq(chatThreads.threadId, input.conversationId),
        input.projectId ? eq(chatThreads.projectId, input.projectId) : undefined,
      ),
    )
    .limit(1);

  if (!thread?.sessionId) {
    // Nothing to detach. The thread-create claim stays: with no mapping it
    // can only belong to a session that is being created right now.
    return { reset: true, previousSessionId: null };
  }

  const turn = await loadTurn(thread.sessionId);
  const running =
    !!turn &&
    !turn.finalized &&
    thread.status === 'running' &&
    Date.now() - (turn.updatedAt ?? 0) < TURN_LIVE_WINDOW_MS;
  if (running) {
    // Detaching a conversation from a run that is still posting into it would
    // leave that run's card updating beside the new session's. Stop is one
    // command away, and it settles the card properly.
    return {
      reset: false,
      notice: 'A run is still going here. Stop it with `/stop`, or wait for it to finish, then send `/new` again.',
    };
  }

  if (!(await mayStartFresh(input, (thread.metadata as Record<string, unknown> | null) ?? null))) {
    return {
      reset: false,
      notice: 'Only someone already working in this session can start a new one here.',
    };
  }

  // An unfinished turn that is no longer moving would otherwise be closed by
  // the stale-turn sweep up to 30 minutes later, repainting a card above the
  // new session's work.
  if (turn && !turn.finalized) await closeAbandonedTurn(turn);
  else if (turn) await deleteTurn(thread.sessionId);

  await db
    .delete(chatThreads)
    .where(
      and(
        eq(chatThreads.platform, PLATFORM),
        eq(chatThreads.workspaceId, input.tenantId),
        eq(chatThreads.threadId, input.conversationId),
        // Only the mapping read above: a message that raced this command and
        // already bound a newer session keeps it.
        eq(chatThreads.sessionId, thread.sessionId),
      ),
    );
  await db
    .delete(chatThreadParticipants)
    .where(
      and(
        eq(chatThreadParticipants.platform, PLATFORM),
        eq(chatThreadParticipants.workspaceId, input.tenantId),
        eq(chatThreadParticipants.threadId, input.conversationId),
      ),
    );
  await db
    .delete(chatEventDedup)
    .where(
      inArray(chatEventDedup.eventId, [
        `teams:threadcreate:${input.tenantId}:${input.conversationId}`,
        `teams:threaderror:${input.tenantId}:${input.conversationId}`,
      ]),
    )
    .catch(() => {});
  return { reset: true, previousSessionId: thread.sessionId };
}

/**
 * Who may start a new session in a chat. The same bar as continuing one:
 * detaching an owner-only session and becoming the owner of the next is
 * otherwise a way around the policy.
 */
async function mayStartFresh(
  input: { tenantId: string; conversationId: string; scope: TeamsConversationScope; teamsUserId: string; channelPolicy?: string | null },
  metadata: Record<string, unknown> | null,
): Promise<boolean> {
  // A personal chat has one person in it.
  if (input.scope === 'personal') return true;
  // Without linked identities no join policy is enforced anywhere.
  if (!config.TEAMS_REQUIRE_USER_IDENTITY) return true;
  const policy = policyFromMetadata(metadata) ?? normalizeConversationPolicy(input.channelPolicy);
  if (policy === 'project_open') return true;
  if (!input.teamsUserId) return false;
  try {
    const [row] = await db
      .select({ status: chatThreadParticipants.status })
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
    // The owner is recorded as the first approved participant
    // (rememberTeamsThreadOwner), so this admits the owner too.
    return row?.status === 'approved';
  } catch (err) {
    console.warn('[teams-webhook] /new participant lookup failed (refusing)', err);
    return false;
  }
}

/**
 * What follows `/new` in the same message — the task the fresh session starts
 * with. Line breaks survive, so `/new` followed by a pasted log is one message.
 * Empty when the command stands alone.
 */
export function messageAfterFreshStart(activity: Parameters<typeof teamsMessageText>[0]): string {
  return teamsMessageText(activity)
    .replace(/^\/(?:new|reset)\b[ \t]*\n?/i, '')
    .trim();
}
