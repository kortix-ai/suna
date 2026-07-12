import { eq } from 'drizzle-orm';
import { chatTurnStreams } from '@kortix/db';
import { db } from '../shared/db';
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

async function platformFor(sessionId: string): Promise<'slack' | 'teams'> {
  const [row] = await db
    .select({ channelRef: chatTurnStreams.channelRef })
    .from(chatTurnStreams)
    .where(eq(chatTurnStreams.sessionId, sessionId))
    .limit(1);
  const platform = (row?.channelRef as { platform?: string } | null)?.platform;
  return platform === 'teams' ? 'teams' : 'slack';
}

export async function relayTurnStep(sessionId: string, title: string, opts: StepOpts = {}): Promise<boolean> {
  return (await platformFor(sessionId)) === 'teams'
    ? teams.relayTurnStep(sessionId, title, opts)
    : slack.relayTurnStep(sessionId, title, opts);
}

export async function relayTurnAnswer(sessionId: string, text: string, blocks?: unknown[]): Promise<boolean> {
  return (await platformFor(sessionId)) === 'teams'
    ? teams.relayTurnAnswer(sessionId, text)
    : slack.relayTurnAnswer(sessionId, text, blocks);
}

export async function relayTurnEnd(
  sessionId: string,
  status: 'idle' | 'error' = 'idle',
  errorInfo?: TurnErrorInfo,
): Promise<boolean> {
  return (await platformFor(sessionId)) === 'teams'
    ? teams.relayTurnEnd(sessionId, status, errorInfo)
    : slack.relayTurnEnd(sessionId, status, errorInfo);
}

export async function relayTurnQuestion(
  sessionId: string,
  questions: QuestionInfo[],
): Promise<{ ok: boolean; answers?: string[][]; error?: string }> {
  return (await platformFor(sessionId)) === 'teams'
    ? teamsQuestions.postTeamsQuestion(sessionId, questions)
    : slackQuestions.postQuestion(sessionId, questions);
}

export async function relayReviewCard(
  sessionId: string,
  item: ReviewCardItem,
): Promise<{ ok: boolean; error?: string }> {
  return (await platformFor(sessionId)) === 'teams'
    ? teamsReview.postTeamsReviewCard(sessionId, item)
    : slackReview.postReviewCard(sessionId, item);
}
