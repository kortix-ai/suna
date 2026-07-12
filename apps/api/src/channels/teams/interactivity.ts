import { labelForModelRef } from '../../llm-gateway/models/picker';
import { toOpencodeModelRef } from '../../llm-gateway/resolution/effective';
import { applyVerdict, getReviewItemById } from '../../projects/review-items';
import { setChannelAgent, setChannelModel } from '../slack/selection';
import { resolveConversationProject, setConversationProject, teamsChannelCtx } from './binding';
import { buildNoticeCard } from './cards';
import {
  createTeamsAccessRequest,
  lookupTeamsIdentity,
  notifyAdminsOfTeamsAccessRequest,
  teamsUserId,
} from './identity';
import { createOrJoinTeamsConversationSession } from './session';
import type { TeamsActivity } from './types';

export interface TeamsInvokeResponse {
  statusCode: number;
  type: string;
  value: unknown;
}

function cardResponse(card: unknown): TeamsInvokeResponse {
  return { statusCode: 200, type: 'application/vnd.microsoft.card.adaptive', value: card };
}

function tenantOf(activity: TeamsActivity): string | null {
  return activity.conversation?.tenantId ?? activity.channelData?.tenant?.id ?? null;
}

function parseAction(activity: TeamsActivity): { verb: string; data: Record<string, unknown> } | null {
  const value = activity.value as { action?: { verb?: string; data?: Record<string, unknown> } } | undefined;
  const verb = value?.action?.verb ?? (value?.action?.data as { verb?: string } | undefined)?.verb;
  if (!verb) return null;
  return { verb, data: value?.action?.data ?? {} };
}

export async function handleAdaptiveCardAction(activity: TeamsActivity): Promise<TeamsInvokeResponse> {
  const action = parseAction(activity);
  if (!action) return cardResponse(buildNoticeCard("This action isn't available."));

  switch (action.verb) {
    case 'teams_request_access':
      return handleRequestAccess(activity, action.data);
    case 'teams_set_model':
      return handleSetModel(activity, action.data);
    case 'teams_set_agent':
      return handleSetAgent(activity, action.data);
    case 'teams_pick_project':
      return handlePickProject(activity, action.data);
    case 'teams_answer':
      return handleAnswer(activity, action.data);
    case 'teams_review':
      return handleReview(activity, action.data);
    default:
      return cardResponse(buildNoticeCard("This action isn't available anymore."));
  }
}

function convoOf(activity: TeamsActivity): { tenantId: string; conversationId: string } | null {
  const tenantId = tenantOf(activity);
  const conversationId = activity.conversation?.id;
  if (!tenantId || !conversationId) return null;
  return { tenantId, conversationId };
}

async function handleSetModel(
  activity: TeamsActivity,
  data: Record<string, unknown>,
): Promise<TeamsInvokeResponse> {
  const convo = convoOf(activity);
  if (!convo) return cardResponse(buildNoticeCard("I couldn't update the model."));
  const model = typeof data.model === 'string' ? data.model : '';
  const ctx = teamsChannelCtx(convo.tenantId, convo.conversationId);
  if (!model) {
    await setChannelModel(ctx, null);
    return cardResponse(buildNoticeCard('Model reset to the project default.'));
  }
  const stored = toOpencodeModelRef(model);
  await setChannelModel(ctx, stored);
  return cardResponse(buildNoticeCard(`Model set to ${labelForModelRef(stored)}.`));
}

async function handleSetAgent(
  activity: TeamsActivity,
  data: Record<string, unknown>,
): Promise<TeamsInvokeResponse> {
  const convo = convoOf(activity);
  if (!convo) return cardResponse(buildNoticeCard("I couldn't update the agent."));
  const agent = typeof data.agent === 'string' ? data.agent : '';
  const ctx = teamsChannelCtx(convo.tenantId, convo.conversationId);
  if (!agent) {
    await setChannelAgent(ctx, null);
    return cardResponse(buildNoticeCard('Agent reset to the project default.'));
  }
  const res = await setChannelAgent(ctx, agent);
  if (!res.ok && res.reason === 'unknown_agent') {
    return cardResponse(buildNoticeCard(`\`${agent}\` isn't a declared agent in this project.`));
  }
  return cardResponse(buildNoticeCard(`Agent set to ${agent}.`));
}

async function handlePickProject(
  activity: TeamsActivity,
  data: Record<string, unknown>,
): Promise<TeamsInvokeResponse> {
  const convo = convoOf(activity);
  const projectId = typeof data.projectId === 'string' ? data.projectId : null;
  if (!convo || !projectId) return cardResponse(buildNoticeCard("I couldn't switch project."));
  await setConversationProject({ tenantId: convo.tenantId, conversationId: convo.conversationId, projectId });
  return cardResponse(buildNoticeCard('This conversation now runs the selected project.'));
}

async function handleAnswer(
  activity: TeamsActivity,
  data: Record<string, unknown>,
): Promise<TeamsInvokeResponse> {
  const convo = convoOf(activity);
  const answer = typeof data.answer === 'string' ? data.answer : '';
  if (!convo || !answer) return cardResponse(buildNoticeCard("I couldn't record that answer."));

  const projectId = await resolveConversationProject(convo.tenantId, convo.conversationId);
  if (!projectId) return cardResponse(buildNoticeCard("This conversation isn't connected to a project."));

  const synthetic: TeamsActivity = {
    ...activity,
    type: 'message',
    text: answer,
    id: `${activity.id ?? 'answer'}:answer`,
  };
  void createOrJoinTeamsConversationSession({
    projectId,
    tenantId: convo.tenantId,
    conversationId: convo.conversationId,
    activity: synthetic,
  }).catch((err) => console.error('[teams-webhook] answer follow-up failed', err));

  return cardResponse(buildNoticeCard(`Answer received: ${answer}`));
}

const VERDICT_MAP: Record<string, 'approve' | 'reject' | 'changes'> = {
  approve: 'approve',
  reject: 'reject',
  changes: 'changes',
};

async function handleReview(
  activity: TeamsActivity,
  data: Record<string, unknown>,
): Promise<TeamsInvokeResponse> {
  const convo = convoOf(activity);
  const reviewItemId = typeof data.reviewItemId === 'string' ? data.reviewItemId : null;
  const verdict = typeof data.verdict === 'string' ? VERDICT_MAP[data.verdict] : undefined;
  const uid = teamsUserId(activity);
  if (!convo || !reviewItemId || !verdict) return cardResponse(buildNoticeCard("I couldn't apply that decision."));

  const identity = uid ? await lookupTeamsIdentity(convo.tenantId, uid) : null;
  if (!identity) {
    return cardResponse(buildNoticeCard('Connect your Kortix account (`/login`) to act on reviews.'));
  }

  const projectId = await resolveConversationProject(convo.tenantId, convo.conversationId);
  if (!projectId) return cardResponse(buildNoticeCard("This conversation isn't connected to a project."));

  const item = await getReviewItemById(reviewItemId, projectId);
  if (!item) return cardResponse(buildNoticeCard('That review item no longer exists.'));

  await applyVerdict(reviewItemId, projectId, { verdict, feedback: null, actingUserId: identity.userId });

  const decisionLine =
    verdict === 'approve'
      ? `The review "${item.title}" was approved.`
      : verdict === 'reject'
        ? `The review "${item.title}" was rejected — do not proceed with it.`
        : `Changes were requested on the review "${item.title}". Ask what to change, then revise.`;
  const synthetic: TeamsActivity = {
    ...activity,
    type: 'message',
    text: [decisionLine, '', 'Continue the turn based on this decision.'].join('\n'),
    id: `${activity.id ?? 'review'}:review`,
  };
  void createOrJoinTeamsConversationSession({
    projectId,
    tenantId: convo.tenantId,
    conversationId: convo.conversationId,
    activity: synthetic,
  }).catch((err) => console.error('[teams-webhook] review resume failed', err));

  const ack =
    verdict === 'approve' ? `Approved "${item.title}" — resuming the agent.` : verdict === 'reject' ? `Rejected "${item.title}".` : `Requested changes on "${item.title}".`;
  return cardResponse(buildNoticeCard(ack));
}

async function handleRequestAccess(
  activity: TeamsActivity,
  data: Record<string, unknown>,
): Promise<TeamsInvokeResponse> {
  const tenantId = tenantOf(activity);
  const userId = teamsUserId(activity);
  const projectId = typeof data.projectId === 'string' ? data.projectId : null;
  if (!tenantId || !userId || !projectId) {
    return cardResponse(buildNoticeCard("I couldn't file that request. Try again from the prompt."));
  }

  const outcome = await createTeamsAccessRequest({ tenantId, teamsUserId: userId, projectId });
  switch (outcome.status) {
    case 'created':
    case 'pending':
      await notifyAdminsOfTeamsAccessRequest({
        projectId,
        accountId: outcome.accountId,
        requesterUserId: outcome.requesterUserId,
      });
      return cardResponse(buildNoticeCard('Access requested. An admin will approve it in Kortix.'));
    case 'already-member':
      return cardResponse(buildNoticeCard("You already have access — send your message again and I'll pick it up."));
    case 'no-identity':
      return cardResponse(buildNoticeCard('Connect your Kortix account first, then request access.'));
    case 'no-project':
      return cardResponse(buildNoticeCard("I couldn't find that project."));
  }
}
