/**
 * Approval cards in chat threads: post one when a connector call a chat
 * session made is held for approval, and replace its buttons with the outcome
 * once anyone decides (in the thread, in Kortix, or on the link page).
 *
 * The card's location is written onto the gated call itself
 * (`connector_calls.result_summary.chat_card`), so the decision path needs no
 * lookup to find it.
 */
import { chatUserIdentities, connectorCalls, projectSessions } from '@kortix/db';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { approvalPreviewReviewable } from '../connectors/args-preview';
import type { ApprovalDecision } from '../projects/lib/connector-approval-decision';
import { db } from '../shared/db';
import { loadSlackTokenForProject } from './install-store';
import { postBlocks, updateBlocks } from './slack-api';
import { buildApprovalCardBlocks, buildApprovalOutcomeBlocks } from './slack/approval-card';
import { deleteTurn, finalizeTurn, loadTurn } from './slack/turn';
import { updateCard } from './teams-api';
import { postTeamsApprovalCard } from './teams/approval';
import { buildTeamsApprovalOutcomeCard } from './teams/cards';
import { conversationRefForSession } from './teams/turn';

export type ChatApprovalCardRef =
  | { platform: 'slack'; team_id: string; channel: string; ts: string }
  | { platform: 'teams'; session_id: string; activity_id: string };

export interface PostApprovalCardInput {
  projectId: string;
  sessionId: string;
  executionId: string;
  actionPath: string;
  risk: string | null;
  resultSummary: Record<string, unknown>;
  approvalUrl: string | null;
}

/** Where a Slack session's thread is, from the live turn or the session row. */
async function slackThreadOf(
  sessionId: string,
): Promise<{ projectId: string; teamId: string; channel: string; threadTs: string; token: string } | null> {
  const handle = await loadTurn(sessionId);
  if (handle) {
    return {
      projectId: handle.projectId,
      teamId: handle.teamId,
      channel: handle.channel,
      threadTs: handle.originatingEvent?.thread_ts ?? handle.triggerTs,
      token: handle.token,
    };
  }
  const [row] = await db
    .select({ projectId: projectSessions.projectId, metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const slack = (row?.metadata as { slack?: { team_id?: string; channel?: string; thread_ts?: string } } | null)?.slack;
  if (!row || !slack?.channel || !slack.thread_ts || !slack.team_id) return null;
  const token = await loadSlackTokenForProject(row.projectId);
  if (!token) return null;
  return { projectId: row.projectId, teamId: slack.team_id, channel: slack.channel, threadTs: slack.thread_ts, token };
}

/**
 * Post the approval card into the session's chat thread. Resolves to whether a
 * card went up — the gateway then tells the agent not to repost the link.
 * Sessions with no chat thread (web, CLI, triggers) post nothing.
 */
export async function postApprovalCard(input: PostApprovalCardInput): Promise<{ posted: boolean }> {
  const summary = input.resultSummary;
  const argsPreview =
    summary.args_preview && typeof summary.args_preview === 'object' && !Array.isArray(summary.args_preview)
      ? (summary.args_preview as Record<string, unknown>)
      : null;
  const cardInput = {
    executionId: input.executionId,
    actionPath: input.actionPath,
    risk: input.risk,
    argsPreview,
    approvalContext: typeof summary.approval_context === 'string' ? summary.approval_context : null,
    approvalUrl: input.approvalUrl,
    approvable: approvalPreviewReviewable(summary),
  };

  const thread = await slackThreadOf(input.sessionId);
  if (!thread) {
    const teams = await postTeamsApprovalCard(input.sessionId, cardInput);
    if (!teams) return { posted: false };
    await recordCard(input.executionId, { platform: 'teams', session_id: input.sessionId, activity_id: teams.activityId });
    return { posted: true };
  }
  if (thread.projectId !== input.projectId) return { posted: false };

  const blocks = buildApprovalCardBlocks(cardInput);
  const ts = await postBlocks(
    thread.token,
    thread.channel,
    `The agent needs your approval to run ${input.actionPath}`,
    blocks,
    thread.threadTs,
  );
  if (!ts) return { posted: false };

  // The agent is now waiting on a human: close the in-flight plan the same way
  // a review card does, so the thread does not show a turn still "working".
  const handle = await loadTurn(input.sessionId);
  if (handle) {
    await finalizeTurn(handle, { title: 'Waiting for your decision', unfinished: true });
    await deleteTurn(input.sessionId);
  }

  await recordCard(input.executionId, { platform: 'slack', team_id: thread.teamId, channel: thread.channel, ts });
  return { posted: true };
}

async function recordCard(executionId: string, card: ChatApprovalCardRef): Promise<void> {
  await db
    .update(connectorCalls)
    .set({ resultSummary: sql`coalesce(${connectorCalls.resultSummary}, '{}'::jsonb) || ${JSON.stringify({ chat_card: card })}::jsonb` })
    .where(eq(connectorCalls.executionId, executionId));
}

function cardRefOf(resultSummary: Record<string, unknown>): ChatApprovalCardRef | null {
  const card = resultSummary.chat_card as Record<string, unknown> | undefined;
  if (card?.platform === 'slack' && card.team_id && card.channel && card.ts) return card as ChatApprovalCardRef;
  if (card?.platform === 'teams' && card.session_id && card.activity_id) return card as ChatApprovalCardRef;
  return null;
}

/** `<@U…>` when the Kortix user linked a Slack identity in that workspace. */
async function decidedByLabel(userId: string, teamId: string): Promise<string> {
  const [link] = await db
    .select({ platformUserId: chatUserIdentities.platformUserId })
    .from(chatUserIdentities)
    .where(
      and(
        eq(chatUserIdentities.userId, userId),
        eq(chatUserIdentities.platform, 'slack'),
        eq(chatUserIdentities.workspaceId, teamId),
        isNull(chatUserIdentities.revokedAt),
      ),
    )
    .limit(1);
  return link ? `<@${link.platformUserId}>` : 'a teammate in Kortix';
}

/** Replace a posted card's buttons with the outcome. No card, no-op. */
export async function markApprovalCardDecided(input: {
  projectId: string;
  resultSummary: Record<string, unknown>;
  actionPath: string;
  decision: ApprovalDecision;
  note: string;
  actorUserId: string;
}): Promise<void> {
  const card = cardRefOf(input.resultSummary);
  if (!card) return;
  if (card.platform === 'teams') {
    const ref = await conversationRefForSession(card.session_id);
    if (ref) {
      await updateCard(
        ref,
        card.activity_id,
        buildTeamsApprovalOutcomeCard({ actionPath: input.actionPath, decision: input.decision, note: input.note }),
      );
    }
    return;
  }
  const token = await loadSlackTokenForProject(input.projectId);
  if (!token) return;
  const blocks = buildApprovalOutcomeBlocks({
    actionPath: input.actionPath,
    decision: input.decision,
    decidedBy: await decidedByLabel(input.actorUserId, card.team_id),
    note: input.note,
    approvalContext:
      typeof input.resultSummary.approval_context === 'string' ? input.resultSummary.approval_context : null,
  });
  await updateBlocks(
    token,
    card.channel,
    card.ts,
    `${input.decision === 'approve' ? 'Approved' : 'Denied'}: ${input.actionPath}`,
    blocks,
  );
}
