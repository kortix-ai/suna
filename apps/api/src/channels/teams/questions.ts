import { sendCard, sendText } from '../teams-api';
import { buildQuestionCard } from './cards';
import { deleteTurn, finalizeTurn, loadTurn } from './turn';
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
): Promise<{ ok: boolean; answers?: string[][]; error?: string }> {
  const handle = await loadTurn(sessionId);
  if (!handle) return { ok: false, error: 'No active Teams turn for this session.' };

  await finalizeTurn(handle, {});
  await deleteTurn(sessionId);

  const ref: TeamsConversationRef = {
    serviceUrl: handle.serviceUrl,
    conversationId: handle.conversationId,
    botId: handle.botId,
    fromId: handle.fromId,
    tenantId: handle.tenantId,
    projectId: handle.projectId,
  };

  const posted = await sendCard(ref, buildQuestionCard(questions));
  if (!posted) {
    const plain = await sendText(ref, renderQuestionsPlain(questions));
    if (!plain) return { ok: false, error: 'Failed to post the question to Teams.' };
  }
  return { ok: true, answers: questions.map(() => [QUESTION_SENTINEL]) };
}
