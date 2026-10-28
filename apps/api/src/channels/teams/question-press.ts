/**
 * A tap or a form submit on a question card whose data names its stored
 * question (`kq`, core/questions.ts). What decides runs inside the invoke, so
 * the card the presser gets back is true: who they are, whether the
 * conversation lets them in, and what the answer is. After the reply,
 * everyone's copy of the card loses its buttons, and the answer reaches only
 * the question's own session: in the turn the question still blocks, else as
 * a follow-up under this invoke's own key. A press never starts or revives a
 * session. Loaded on press by interactivity.ts.
 */
import type { RuntimeQuestion } from '@kortix/api-contract/transcript';
import { projects } from '@kortix/db';
import { eq } from 'drizzle-orm';
import { logger } from '../../lib/logger';
import { db } from '../../shared/db';
import { isUuid } from '../../shared/validate';
import { parseQuestionButton } from '../core/question-token';
import type { QuestionPick, QuestionPress } from '../core/questions';
import { findChatThreadSession } from '../core/threads';
import { updateCard } from '../teams-api';
import { runWebhookWork } from '../webhook-work';
import { QUESTION_EARLIER, buildNoticeCard } from './cards';
import type { TeamsInbound } from './inbound';
import { type TeamsInvokeResponse, cardResponse, messageResponse } from './interactivity';
import { type TeamsFollowUp, admitTeamsFollowUp, agentGrantEnvFor, deliverAdmittedFollowUp, resolveTeamsTurnActor } from './session';
import { noticeOnLiveCard, startTurn } from './turn';
import type { TeamsActivity, TeamsLiveTurn } from './types';

/** The card once a press settled it: each question, then `line`, and no buttons. */
const settledCard = (questions: RuntimeQuestion[], line: string) =>
  buildNoticeCard([...questions.map((q) => `**${q.question}**`), line].join('\n\n'));

/**
 * The stored question and the picks of a `kq` press, or null for data Kortix
 * did not write. A one-tap button carries `kq:<id>:<option>`. A form carries
 * the id in `kq`, each question's choice in `kq<q>` (option indexes,
 * comma-joined on a multi-select) and its own text in `kq<q>.text`.
 */
function pressOf(data: Record<string, unknown>, form: boolean): { pendingId: string; picks: QuestionPick[] } | null {
  const kq = data.kq;
  if (!form) {
    const button = typeof kq === 'string' ? parseQuestionButton(kq) : null;
    return button && { pendingId: button.pendingId, picks: [{ question: button.question, options: [button.index] }] };
  }
  if (!isUuid(kq)) return null;
  const picks = new Map<number, QuestionPick>();
  for (const [key, raw] of Object.entries(data)) {
    const field = /^kq(0|[1-9]\d?)(\.text)?$/.exec(key);
    const value = typeof raw === 'string' ? raw.trim() : '';
    if (!field || !value) continue;
    const question = Number(field[1]);
    const pick = picks.get(question) ?? { question, options: [] };
    if (field[2]) pick.text = value;
    // An index the question does not have answers nothing (decideQuestionPress).
    else pick.options = value.split(',').map((o) => (/^\d{1,2}$/.test(o.trim()) ? Number(o) : -1));
    picks.set(question, pick);
  }
  return { pendingId: kq, picks: [...picks.values()] };
}

const NOT_TAKEN = 'Your answer was not taken. Follow the message I sent you, then tap again.';

/**
 * The reply for the presser of a card from before `kq` (interactivity.ts)
 * whom Kortix cannot act as in `projectId`, else null. Decided before the
 * invoke replies, as for a `kq` press: they get the sign-in prompt, nothing is
 * kept to replay, and their card keeps its inputs for the press after login.
 */
export async function unlinkedPresser(activity: TeamsActivity, projectId: string, tenantId: string): Promise<TeamsInvokeResponse | null> {
  const [project] = await db.select({ accountId: projects.accountId }).from(projects).where(eq(projects.projectId, projectId)).limit(1);
  const userId = project && (await resolveTeamsTurnActor(project.accountId, projectId, tenantId, activity, undefined, false));
  return userId ? null : messageResponse(NOT_TAKEN);
}

export async function answerTeamsQuestion(
  activity: TeamsActivity,
  convo: { tenantId: string; conversationId: string },
  inbound: TeamsInbound,
  data: Record<string, unknown>,
  form: boolean,
): Promise<TeamsInvokeResponse> {
  const press = pressOf(data, form);
  if (!press) return cardResponse(settledCard([], QUESTION_EARLIER));
  if (press.picks.length === 0) return messageResponse('Nothing was filled in. Add at least one answer, then send it again.');

  const { tenantId, conversationId } = convo;
  const thread = await findChatThreadSession(
    { platform: 'teams', workspaceId: tenantId, threadId: conversationId },
    inbound.kind === 'project' ? inbound.projectId : undefined,
  );
  const [project] = thread ? await db.select().from(projects).where(eq(projects.projectId, thread.projectId)).limit(1) : [];
  if (!thread || !project) return cardResponse(settledCard([], QUESTION_EARLIER));
  const { projectId, sessionId } = thread;

  const userId = await resolveTeamsTurnActor(project.accountId, projectId, tenantId, activity, undefined, false);
  if (!userId) return messageResponse(NOT_TAKEN);
  const followUp: TeamsFollowUp = {
    projectId,
    accountId: project.accountId,
    project,
    agentGrantEnv: agentGrantEnvFor(project, thread.agentName),
    tenantId,
    conversationId,
    sessionId,
    sessionOwnerId: thread.createdBy,
    sessionMetadata: (thread.metadata as Record<string, unknown> | null) ?? null,
    sessionStatus: thread.status,
    handle: null,
    liveCard: async () => null,
    activity,
    userId,
  };
  const admitted = await admitTeamsFollowUp(followUp);
  if ('refusal' in admitted) return messageResponse(admitted.refusal);

  const { decideQuestionPress, rememberedQuestionRef, settleQuestionAnswer } = await import('../core/questions');
  const target = { platform: 'teams' as const, workspaceId: tenantId, threadId: conversationId, projectId };
  // The pressed card: Teams names it on the invoke, else the one kept when it was posted.
  const ref = activity.replyToId ?? (await rememberedQuestionRef(target, press.pendingId));
  logger.info('[teams] question press', { sessionId, card: activity.replyToId ? 'replyToId' : ref ? 'stored' : 'none' });
  const p: QuestionPress = { target, ref: ref ?? '', pendingId: press.pendingId, picks: press.picks };
  const decision = await decideQuestionPress(p, async (sid) => (sid === sessionId ? conversationId : null));

  // Everyone's copy of the card. The invoke reply below changes the presser's only.
  const show = async (card: unknown) => {
    if (!ref || !activity.serviceUrl) return;
    const conversation = { serviceUrl: activity.serviceUrl, conversationId, botId: activity.recipient?.id, fromId: activity.from?.id, tenantId, projectId };
    if (!(await updateCard(conversation, ref, card))) logger.warn('[teams] question card not updated', { sessionId });
  };
  if (decision.kind === 'earlier') {
    const card = settledCard(decision.questions, QUESTION_EARLIER);
    void runWebhookWork('teams-question', () => show(card), { ackWaitMs: 0 });
    return cardResponse(card);
  }

  const { answer } = decision;
  const name = activity.from?.name;
  const card = settledCard(answer.questions, `✅ Answered: ${answer.label}${name ? ` — ${name}` : ''}`);
  void runWebhookWork(
    'teams-question',
    async () => {
      await show(card);
      const settled = await settleQuestionAnswer(
        p,
        answer,
        async (a) => {
          const message: TeamsActivity = { ...activity, type: 'message', text: a.prompt, id: `kq:${activity.id}` };
          let live = null as TeamsLiveTurn | null;
          const liveCard = async () => (live = await startTurn(projectId, tenantId, message));
          if ((await deliverAdmittedFollowUp({ ...followUp, activity: message, liveCard }, admitted.selection)) === 'done') return 'handled';
          // The session is gone: the card this answer opened says so.
          if (live) await noticeOnLiveCard(live, QUESTION_EARLIER);
          return 'gone';
        },
        // Teams does not send an invoke again.
        { finalAttempt: true },
      );
      if (settled === 'gone') await show(settledCard(answer.questions, QUESTION_EARLIER));
    },
    { ackWaitMs: 0 },
  );
  return cardResponse(card);
}
