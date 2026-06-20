import { postBlocks } from '../slack-api';
import { deleteTurn, finalizeTurn, loadTurn } from './turn';
import { escapeMrkdwn } from './util';
import type { QuestionInfo } from './types';

export type { QuestionInfo } from './types';

// Post the agent's question(s) into the Slack thread and END the turn. A Slack
// thread is async — we NEVER block waiting for an inline answer (that hung the
// `question` tool until a human killed it). Each option renders as a CLICKABLE
// button: a click fires a block_action the interactivity webhook routes back
// into the thread as a follow-up turn carrying the chosen answer. A free-form
// in-thread reply works too (for "Other"). Either way the answer arrives as a
// normal follow-up turn with full context. The sentinel is returned as the
// question tool's "answer" so the agent resumes and ends its turn. Kept here
// (not just in the sandbox) so an OLD sandbox image — which resumes opencode
// from THIS response's `answers` — stays unblocked during the window between an
// API deploy and the sandbox template rebuild.
const QUESTION_SENTINEL =
  '(Posted to the Slack thread. In Slack, questions are async — the user replies as ' +
  'a normal message, which reaches you as a NEW turn with full context. Do not wait ' +
  'for an answer here; finish this turn now.)';

// Renders the agent's question(s) into the live Slack thread. The sandbox owns
// the "is this Slack / auto-answer the tool" decision (via its env = the session
// metadata) and resumes opencode itself, so this is purely the thread-render side
// effect: it needs a live turn (for the channel/token) and is a best-effort no-op
// when there isn't one (e.g. a second question after the first finalized).
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

// Interactive rendering: question + each option as a CLICKABLE button. A click
// fires a block_action (`action_id` = `qa_<q>_<o>`) the interactivity webhook
// routes back into the thread as a follow-up turn carrying the chosen answer, so
// the `question` tool behaves natively in Slack instead of dead-ending in a
// bullet list. Option descriptions (a button shows only its label) are surfaced
// above the buttons so each choice stays legible. `description` is optional.
function buildQuestionBlocks(questions: QuestionInfo[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  questions.forEach((q, qi) => {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${escapeMrkdwn(q.question)}*` },
    });
    const described = q.options.filter((o) => o.description);
    if (described.length > 0) {
      const lines = described
        .map((o) => `•  *${escapeMrkdwn(o.label)}* — ${escapeMrkdwn(o.description as string)}`)
        .join('\n');
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: lines } });
    }
    if (q.options.length > 0) {
      // Slack caps an actions block at 25 elements; AskUserQuestion stays well
      // under that. Button text ≤75 chars; the value carries the question +
      // answer so the click handler can synthesize a clean follow-up.
      blocks.push({
        type: 'actions',
        elements: q.options.slice(0, 25).map((o, oi) => ({
          type: 'button',
          text: { type: 'plain_text', text: truncate(o.label, 75), emoji: true },
          action_id: `qa_${qi}_${oi}`,
          value: JSON.stringify({ q: q.question.slice(0, 300), a: o.label }).slice(0, 1900),
        })),
      });
    }
  });
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '↩︎  Click an option, or reply in this thread to answer.' }],
  });
  return blocks;
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
