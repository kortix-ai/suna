import { postBlocks } from '../slack-api';
import { deleteTurn, finalizeTurn, loadTurn } from './turn';
import { escapeMrkdwn } from './util';
import type { QuestionInfo } from './types';

export type { QuestionInfo } from './types';

// Post the agent's question(s) into the Slack thread and END the turn. A Slack
// thread is async — we NEVER block waiting for an inline answer (that hung the
// `question` tool until a human killed it). The user replies in-thread, which
// arrives as a normal follow-up turn with full context. So the rendered message
// is plain (no Submit form): the answer is just the user's next message.
// Returned as the question tool's "answer" so the agent resumes and ends its
// turn. Kept here (not just in the sandbox) so an OLD sandbox image — which
// resumes opencode from THIS response's `answers` — stays unblocked during the
// window between an API deploy and the sandbox template rebuild.
const QUESTION_SENTINEL =
  '(Posted to the Slack thread. In Slack, questions are async — the user replies as ' +
  'a normal message, which reaches you as a NEW turn with full context. Do not wait ' +
  'for an answer here; finish this turn now.)';

export async function postQuestion(
  sessionId: string,
  questions: QuestionInfo[],
): Promise<{ ok: boolean; answers?: string[][]; error?: string }> {
  const handle = await loadTurn(sessionId);
  if (!handle) {
    return { ok: false, error: 'No active Slack turn for this session.' };
  }

  // Close out the in-flight plan, then post the question(s) below it.
  await finalizeTurn(handle, {});
  await deleteTurn(sessionId);

  const blocks = buildQuestionBlocks(questions);
  const fallback = questions[0]?.question?.slice(0, 200) ?? 'A question for you';
  const messageTs = await postBlocks(handle.token, handle.channel, fallback, blocks, handle.triggerTs);
  if (!messageTs) {
    return { ok: false, error: 'Failed to post the question to Slack.' };
  }
  return { ok: true, answers: questions.map(() => [QUESTION_SENTINEL]) };
}

// Non-interactive rendering: question + options as a readable list, with a hint
// to reply in-thread. `description` is optional (tolerated if the agent omits it).
function buildQuestionBlocks(questions: QuestionInfo[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  questions.forEach((q) => {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${escapeMrkdwn(q.question)}*` },
    });
    if (q.options.length > 0) {
      const lines = q.options
        .map((o) => `•  ${escapeMrkdwn(o.label)}${o.description ? ` — ${escapeMrkdwn(o.description)}` : ''}`)
        .join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines } });
    }
  });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '↩︎  Reply in this thread to answer.' }],
  });
  return blocks;
}
