import { sendCard, sendText } from '../teams-api';
import { buildQuestionCard } from './cards';
import { conversationRefForSession, finalizeTurn, loadTurn, markTurnReplied } from './turn';
import type { QuestionInfo } from '../slack/types';
import type { TeamsConversationRef } from './types';

const QUESTION_SENTINEL =
  '(Posted to the Teams conversation. In Teams, questions are async — the user replies as a ' +
  'normal message, which reaches you as a NEW turn with full context. Do not wait for an answer ' +
  'here; finish this turn now.)';

function renderQuestionsPlain(questions: QuestionInfo[]): string {
  return questions
    .map((q) => {
      const opts = (q.options ?? []).map((o) => `• ${o.label}`).join('\n');
      return opts ? `${q.question}\n${opts}` : q.question;
    })
    .join('\n\n');
}

export async function postTeamsQuestion(
  sessionId: string,
  questions: QuestionInfo[],
  /** The stored question its card answers (`buildQuestionCard`). */
  pendingId?: string,
): Promise<{ ok: boolean; answers?: string[][]; error?: string }> {
  const handle = await loadTurn(sessionId);
  let ref: TeamsConversationRef | null;
  if (handle) {
    // NOT "Task complete". The agent did not finish — it asked. Closing the
    // live card with the default title told the user the work was done, one
    // line above a card asking them a question. The step in flight gets the
    // neutral glyph for the same reason.
    await finalizeTurn(handle, { title: 'Waiting for your answer', unfinished: true });
    // Kept as a replied-turn marker, so a `teams send` from this same run
    // after the card does not open a second one.
    await markTurnReplied(sessionId);
    ref = {
      serviceUrl: handle.serviceUrl,
      conversationId: handle.conversationId,
      botId: handle.botId,
      fromId: handle.fromId,
      tenantId: handle.tenantId,
      projectId: handle.projectId,
    };
  } else {
    // A prompt that runs without a card of its own — a message sent while
    // another run was going, a queued start — still asks in its conversation.
    ref = await conversationRefForSession(sessionId);
    if (!ref) return { ok: false, error: 'No active Teams turn for this session.' };
  }

  const posted = await sendCard(ref, buildQuestionCard(questions, pendingId));
  if (!posted) {
    const plain = await sendText(ref, renderQuestionsPlain(questions));
    if (!plain) return { ok: false, error: 'Failed to post the question to Teams.' };
  } else if (pendingId && ref.projectId && ref.tenantId) {
    // A press finds its card by this id when Teams does not name it (question-press.ts).
    const { rememberQuestionMessage } = await import('../core/questions');
    await rememberQuestionMessage({ platform: 'teams', projectId: ref.projectId, workspaceId: ref.tenantId, threadId: ref.conversationId }, posted, pendingId);
  }
  return { ok: true, answers: questions.map(() => [QUESTION_SENTINEL]) };
}
