import { eq } from 'drizzle-orm';
import { chatTurnStreams, projectSessions } from '@kortix/db';
import { db } from '../shared/db';
import type { ConnectorPrincipal } from '../connectors/router-contract';
import { postSessionQuestion } from './core/session-notice';
import { channelOfSessionMetadata, questionReleaseSentinel } from './question-release';
import type { TurnErrorInfo } from './slack/errors';
import * as slackQuestions from './slack/questions';
import * as slackReview from './slack/review';
import type { ReviewCardItem } from './slack/review-cards';
import * as slack from './slack/turn';
import type { QuestionInfo } from './slack/types';
import * as teamsQuestions from './teams/questions';
import * as teamsReview from './teams/review';
import * as teams from './teams/turn';

interface StepOpts {
  detail?: string;
  outputForPrev?: string;
  sourcesForPrev?: Array<{ url: string; text: string }>;
}

type Platform = 'slack' | 'teams';

/**
 * Anything unrecognised still falls back to Slack, which is the historical
 * default. A Telegram or Email session is null: it has no live turn to render
 * into; it renders through its session port (core/session-notice.ts), when it
 * has one.
 */
async function platformFor(sessionId: string, fallback: Platform | null = 'slack'): Promise<Platform | null> {
  const [row] = await db
    .select({ channelRef: chatTurnStreams.channelRef })
    .from(chatTurnStreams)
    .where(eq(chatTurnStreams.sessionId, sessionId))
    .limit(1);
  const platform = (row?.channelRef as { platform?: string } | null)?.platform;
  if (platform === 'teams' || platform === 'slack') return platform;

  // No live-turn row. That used to mean "Slack", so a Teams session whose turn
  // had already closed — a question asked late, a review filed after the card
  // settled — was handed to the SLACK renderer, which found no Slack turn and
  // dropped it. The session's own metadata is set once at creation and never
  // goes away; ask it before falling back.
  const [session] = await db
    .select({ metadata: projectSessions.metadata })
    .from(projectSessions)
    .where(eq(projectSessions.sessionId, sessionId))
    .limit(1);
  const channel = channelOfSessionMetadata(session?.metadata);
  if (channel === 'slack' || channel === 'teams') return channel;
  // A live Slack row renders in Slack whatever channel started the session: a
  // Telegram session that bound a Slack thread (`slack send --channel`) streams there.
  if (row) return 'slack';
  return channel ? null : fallback;
}

/** Teams relays answer a bare boolean; carry a stable reason for the sandbox. */
function fromBoolean(ok: boolean): slack.TurnRelayResult {
  return ok ? { ok: true } : { ok: false, reason: 'not_relayed' };
}

export async function relayTurnStepDetailed(
  sessionId: string,
  title: string,
  opts: StepOpts = {},
): Promise<slack.TurnRelayResult> {
  const platform = await platformFor(sessionId);
  if (!platform) return { ok: false, reason: 'not_relayed' };
  return platform === 'teams'
    ? fromBoolean(await teams.relayTurnStep(sessionId, title, opts))
    : slack.relayTurnStepDetailed(sessionId, title, opts);
}

export async function relayTurnAnswerDetailed(
  sessionId: string,
  text: string,
  blocks?: unknown[],
  card?: Record<string, unknown>,
): Promise<slack.TurnRelayResult> {
  const platform = await platformFor(sessionId);
  if (!platform) return { ok: false, reason: 'not_relayed' };
  return platform === 'teams'
    ? fromBoolean(await teams.relayTurnAnswer(sessionId, text, card))
    : slack.relayTurnAnswerDetailed(sessionId, text, blocks);
}

export async function relayTurnEnd(
  sessionId: string,
  status: 'idle' | 'error' = 'idle',
  errorInfo?: TurnErrorInfo,
): Promise<boolean> {
  // Runtime ends arrive for every session, not only chat-channel sessions.
  // Keep late channel errors observable, but do not invent a Slack recipient.
  const platform = await platformFor(sessionId, null);
  if (!platform) return false;
  return platform === 'teams'
    ? teams.relayTurnEnd(sessionId, status, errorInfo)
    : slack.relayTurnEnd(sessionId, status, errorInfo);
}

export async function relayTurnQuestion(
  sessionId: string,
  questions: QuestionInfo[],
  /** Post into the session's chat when no live turn renders it, as the agent `principal` would. Null: only a live turn may. */
  chat: { pendingId: string; principal: ConnectorPrincipal } | null = null,
): Promise<{ ok: boolean; answers?: string[][]; error?: string }> {
  const platform = await platformFor(sessionId);
  if (!platform) {
    const posted = chat ? await postSessionQuestion({ sessionId, questions, ...chat }) : null;
    return posted
      ? { ok: true, answers: questions.map(() => [questionReleaseSentinel(posted, true)]) }
      : { ok: false, error: 'not_relayed' };
  }
  return platform === 'teams'
    ? teamsQuestions.postTeamsQuestion(sessionId, questions)
    : slackQuestions.postQuestion(sessionId, questions);
}

export async function relayReviewCard(
  sessionId: string,
  item: ReviewCardItem,
): Promise<{ ok: boolean; error?: string }> {
  const platform = await platformFor(sessionId);
  if (!platform) return { ok: false, error: 'not_relayed' };
  return platform === 'teams'
    ? teamsReview.postTeamsReviewCard(sessionId, item)
    : slackReview.postReviewCard(sessionId, item);
}
