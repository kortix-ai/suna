import { labelForModelRef } from '../../llm-gateway/models/picker';
import { toOpencodeModelRef } from '../../llm-gateway/resolution/effective';
import { applyVerdict, getReviewItemById } from '../../projects/review-items';
import { setChannelAgent, setChannelModel } from '../slack/selection';
import { resolveConversationProject, setConversationProject, teamsChannelCtx } from './binding';
import { consumePendingTeamsPickerMessage } from './auth-resume';
import { REVIEW_FEEDBACK_INPUT, TEAMS_FORM_VERB, TEAMS_STOP_VERB, buildNoticeCard } from './cards';
import {
  createTeamsAccessRequest,
  notifyAdminsOfTeamsAccessRequest,
  resolveTeamsActor,
  teamsUserId,
} from './identity';
import { decideTeamsThreadJoin } from './participants';
import { createOrJoinTeamsConversationSession } from './session';
import { stopTeamsTurn } from './stop';
import type { TeamsActivity, TeamsConversationRef } from './types';

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
    case 'teams_thread_join':
      return handleThreadJoin(activity, action.data);
    case 'teams_set_model':
      return handleSetModel(activity, action.data);
    case 'teams_set_agent':
      return handleSetAgent(activity, action.data);
    case 'teams_pick_project':
      return handlePickProject(activity, action.data);
    case 'teams_answer':
      return handleAnswer(activity, action.data);
    case TEAMS_FORM_VERB:
      return handleForm(activity, action.data);
    case TEAMS_STOP_VERB:
      return handleStop(activity, action.data);
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
    return cardResponse(buildNoticeCard('Model reset to the project default.', '✅'));
  }
  const stored = toOpencodeModelRef(model);
  await setChannelModel(ctx, stored);
  return cardResponse(buildNoticeCard(`Model set to ${labelForModelRef(stored)}.`, '✅'));
}

/**
 * Stop the run behind the live card.
 *
 * The invoke carries the session id the card was drawn with; nothing about the
 * activity itself names a turn. `stopTeamsTurn` decides whether this person may
 * end it and settles the card, so the reply here is only what the presser is
 * told — and a refusal reads the same to them as to anyone watching, because an
 * `Action.Execute` response is shown to the presser alone.
 */
async function handleStop(
  activity: TeamsActivity,
  data: Record<string, unknown>,
): Promise<TeamsInvokeResponse> {
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
  if (!sessionId) return cardResponse(buildNoticeCard('That run is no longer available.'));
  const outcome = await stopTeamsTurn({
    sessionId,
    teamsUserId: teamsUserId(activity) ?? '',
    byName: activity.from?.name,
  });
  if (!outcome.stopped) return cardResponse(buildNoticeCard(outcome.notice));
  return cardResponse(
    buildNoticeCard(
      outcome.stoppedRuntime
        ? 'Stopped. The agent is no longer working on this.'
        : // The ledger is closed either way; say so without claiming a reach we
          // did not have. A parked or already-finished sandbox is the usual case.
          'Stopped. The run was already closing on its own.',
      '✅',
    ),
  );
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
    return cardResponse(buildNoticeCard('Agent reset to the project default.', '✅'));
  }
  const res = await setChannelAgent(ctx, agent);
  if (!res.ok && res.reason === 'unknown_agent') {
    return cardResponse(buildNoticeCard(`\`${agent}\` isn't a declared agent in this project.`));
  }
  return cardResponse(buildNoticeCard(`Agent set to ${agent}.`, '✅'));
}

async function handlePickProject(
  activity: TeamsActivity,
  data: Record<string, unknown>,
): Promise<TeamsInvokeResponse> {
  const convo = convoOf(activity);
  const projectId = typeof data.projectId === 'string' ? data.projectId : null;
  if (!convo || !projectId) return cardResponse(buildNoticeCard("I couldn't switch project."));
  const switched = await setConversationProject({ tenantId: convo.tenantId, conversationId: convo.conversationId, projectId });
  if (!switched) return cardResponse(buildNoticeCard("That project isn't connected to this Teams tenant."));

  // If this pick answered a project picker, replay the message that triggered it.
  const pendingId = typeof data.pendingId === 'string' ? data.pendingId : undefined;
  if (pendingId) {
    const parked = await consumePendingTeamsPickerMessage({ pendingId, tenantId: convo.tenantId });
    if (parked) {
      void createOrJoinTeamsConversationSession({
        projectId,
        tenantId: convo.tenantId,
        conversationId: convo.conversationId,
        activity: parked,
      }).catch((err) => console.error('[teams-webhook] picker replay failed', err));
      return cardResponse(buildNoticeCard('This conversation now runs the selected project — on it.', '✅'));
    }
  }
  return cardResponse(buildNoticeCard('This conversation now runs the selected project.', '✅'));
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

  // The question travels on the action (cards.ts), because the tap REPLACES the
  // card that asked it. Sending the agent a bare "Yes" leaves it to infer what
  // was agreed to; sending the pair leaves nothing to infer. Older cards, posted
  // before this shipped, carry no question — they still work.
  const question = typeof data.question === 'string' ? data.question.trim() : '';
  const synthetic: TeamsActivity = {
    ...activity,
    type: 'message',
    text: question ? `${question}\n${answer}` : answer,
    id: `${activity.id ?? 'answer'}:answer`,
  };
  void createOrJoinTeamsConversationSession({
    projectId,
    tenantId: convo.tenantId,
    conversationId: convo.conversationId,
    activity: synthetic,
  }).catch((err) => console.error('[teams-webhook] answer follow-up failed', err));

  return cardResponse(
    buildNoticeCard(question ? `**${question}**\n\n${answer} — working on it.` : `Answer received: ${answer}`, '✅'),
  );
}

/**
 * A form card's Submit. `Action.Execute` returns every `Input.*` value in
 * `activity.value.action.data`, keyed by the input id, merged with the
 * action's own data — so the inputs arrive here beside `verb` and `fieldIds`.
 *
 * `fieldIds` is the card's own list of what it asked for, written by
 * `buildFormCard`. Reading the answers through it (rather than "every key that
 * is not `verb`") keeps a client-supplied key out of the message, and keeps
 * the order the user saw.
 */
async function handleForm(
  activity: TeamsActivity,
  data: Record<string, unknown>,
): Promise<TeamsInvokeResponse> {
  const convo = convoOf(activity);
  if (!convo) return cardResponse(buildNoticeCard("I couldn't record that."));

  const ids = typeof data.fieldIds === 'string' ? data.fieldIds.split(',').map((f) => f.trim()).filter(Boolean) : [];
  const answered: Array<{ id: string; value: string }> = [];
  for (const id of ids) {
    const raw = data[id];
    const value =
      typeof raw === 'string' ? raw.trim() : typeof raw === 'number' || typeof raw === 'boolean' ? String(raw) : '';
    if (value) answered.push({ id, value });
  }
  if (answered.length === 0) {
    return cardResponse(buildNoticeCard('Nothing was filled in — open the form again and add at least one answer.'));
  }

  const projectId = await resolveConversationProject(convo.tenantId, convo.conversationId);
  if (!projectId) return cardResponse(buildNoticeCard("This conversation isn't connected to a project."));

  const text = ['Form submitted:', ...answered.map((a) => `- ${a.id}: ${a.value}`)].join('\n');
  const synthetic: TeamsActivity = {
    ...activity,
    type: 'message',
    text,
    id: `${activity.id ?? 'form'}:form`,
  };
  void createOrJoinTeamsConversationSession({
    projectId,
    tenantId: convo.tenantId,
    conversationId: convo.conversationId,
    activity: synthetic,
  }).catch((err) => console.error('[teams-webhook] form follow-up failed', err));

  return cardResponse(
    buildNoticeCard(
      ['**Submitted** — working on it.', '', ...answered.map((a) => `- **${a.id}:** ${a.value}`)].join('\n'),
      '✅',
    ),
  );
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

  const projectId = await resolveConversationProject(convo.tenantId, convo.conversationId);
  if (!projectId) return cardResponse(buildNoticeCard("This conversation isn't connected to a project."));

  const item = await getReviewItemById(reviewItemId, projectId);
  if (!item) return cardResponse(buildNoticeCard('That review item no longer exists.'));

  // The actor must be a linked Kortix user with WRITE access to this project —
  // the same bar Slack has always applied (channels/slack/interactivity.ts).
  // This checked only that the presser had *some* linked identity in the
  // tenant, so anyone who had ever run `/login` could approve or deny a review
  // for a project they are not a member of. The card is posted to the whole
  // conversation, so the check has to happen on the press.
  //
  // The item is loaded FIRST because the authorization is scoped to its own
  // account, not to whatever account the presser happens to belong to.
  const actor = await resolveTeamsActor(convo.tenantId, uid ?? '', item.accountId, projectId);
  if ('reason' in actor) {
    return cardResponse(
      buildNoticeCard(
        actor.reason === 'unlinked'
          ? 'Connect your Kortix account (`/login`) to act on reviews.'
          : "You don't have access to act on this project's reviews.",
      ),
    );
  }

  // The card carries an optional box; `Action.Execute` hands back its value
  // whichever button was pressed.
  const raw = data[REVIEW_FEEDBACK_INPUT];
  const feedback = typeof raw === 'string' && raw.trim() ? raw.trim().slice(0, 2000) : null;
  await applyVerdict(reviewItemId, projectId, { verdict, feedback, actingUserId: actor.userId });

  const base =
    verdict === 'approve'
      ? `The review "${item.title}" was approved.`
      : verdict === 'reject'
        ? `The review "${item.title}" was rejected — do not proceed with it.`
        : `Changes were requested on the review "${item.title}".`;
  // Only send the agent hunting for the reason when there is no reason to read.
  const decisionLine = feedback
    ? `${base}\n\nReviewer's feedback:\n${feedback}`
    : verdict === 'changes'
      ? `${base} Ask what to change, then revise.`
      : base;
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

async function handleThreadJoin(
  activity: TeamsActivity,
  data: Record<string, unknown>,
): Promise<TeamsInvokeResponse> {
  const convo = convoOf(activity);
  const decider = teamsUserId(activity);
  const decision = data.decision === 'approved' ? 'approved' : data.decision === 'denied' ? 'denied' : null;
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : null;
  const projectId = typeof data.projectId === 'string' ? data.projectId : null;
  const requesterUserId = typeof data.requesterUserId === 'string' ? data.requesterUserId : null;
  const requesterTeamsUserId = typeof data.requesterTeamsUserId === 'string' ? data.requesterTeamsUserId : null;
  if (!convo || !decider || !decision || !sessionId || !projectId || !requesterUserId || !requesterTeamsUserId || !activity.serviceUrl) {
    return cardResponse(buildNoticeCard("I couldn't apply that decision."));
  }
  const ref: TeamsConversationRef = {
    serviceUrl: activity.serviceUrl,
    conversationId: convo.conversationId,
    botId: activity.recipient?.id,
    fromId: activity.from?.id,
    tenantId: convo.tenantId,
    projectId,
  };
  const result = await decideTeamsThreadJoin({
    tenantId: convo.tenantId,
    conversationId: convo.conversationId,
    deciderTeamsUserId: decider,
    projectId,
    sessionId,
    requesterUserId,
    requesterTeamsUserId,
    decision,
    ref,
  });
  return cardResponse(buildNoticeCard(result.text, result.ok ? (decision === 'approved' ? '✅' : '🚫') : '⚠️'));
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
      return cardResponse(buildNoticeCard('Access requested. An admin will approve it in Kortix.', '✅'));
    case 'already-member':
      return cardResponse(buildNoticeCard("You already have access — send your message again and I'll pick it up."));
    case 'no-identity':
      return cardResponse(buildNoticeCard('Connect your Kortix account first, then request access.'));
    case 'no-project':
      return cardResponse(buildNoticeCard("I couldn't find that project."));
  }
}
