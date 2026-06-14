import { eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { postBlocks, type StreamTaskChunk } from '../slack-api';
import { STREAM_TTL_MS } from './app';
import {
  claimFinalize,
  deleteTurn,
  finalizeTurn,
  loadTurn,
  openPlanMessage,
  repaintLivePlan,
  saveTurn,
} from './turn';
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

export async function relayTurnStep(
  sessionId: string,
  title: string,
  opts: {
    detail?: string;
    outputForPrev?: string;
    sourcesForPrev?: Array<{ url: string; text: string }>;
  } = {},
): Promise<boolean> {
  const handle = await loadTurn(sessionId);
  if (!handle || handle.finalized) {
    console.warn('[slack-webhook] turn-stream step relay dropped — no active stream', {
      sessionId,
      title: title.slice(0, 80),
      finalized: handle?.finalized ?? null,
    });
    return false;
  }

  // First `slack step` → create the plan-checklist message.
  if (!handle.ts) {
    const firstStep: StreamTaskChunk = {
      type: 'task_update',
      id: 'step-0',
      title: title.slice(0, 200),
      status: 'in_progress',
    };
    if (opts.detail) firstStep.details = opts.detail.slice(0, 500);
    const opened = await openPlanMessage(handle, firstStep);
    if (!opened) return false;
    handle.expiry = Date.now() + STREAM_TTL_MS;
    await saveTurn(handle);
    return true;
  }

  // Subsequent step → mark the previous one complete (with its output/sources),
  // append the new one, and repaint the whole plan via chat.update.
  const last = handle.steps[handle.steps.length - 1];
  if (last && last.status === 'in_progress') {
    last.status = 'complete';
    if (opts.outputForPrev) last.output = opts.outputForPrev.slice(0, 500);
    if (opts.sourcesForPrev && opts.sourcesForPrev.length > 0) {
      last.sources = opts.sourcesForPrev.slice(0, 8).map((s) => ({
        type: 'url',
        url: s.url,
        text: s.text.slice(0, 80),
      }));
    }
  }
  const next: StreamTaskChunk = {
    type: 'task_update',
    id: `step-${handle.steps.length}`,
    title: title.slice(0, 200),
    status: 'in_progress',
  };
  if (opts.detail) next.details = opts.detail.slice(0, 500);
  handle.steps.push(next);
  handle.expiry = Date.now() + STREAM_TTL_MS;
  await repaintLivePlan(handle);
  await saveTurn(handle);
  return true;
}

export async function relayTurnAnswer(
  sessionId: string,
  text: string,
  blocks?: unknown[],
): Promise<boolean> {
  const handle = await loadTurn(sessionId);
  if (!handle || handle.finalized) return false;
  // Win the finalize race against a late session.idle/error relay (or a duplicate
  // send) so the turn is closed exactly once.
  if (!(await claimFinalize(sessionId))) return false;
  await finalizeTurn(handle, { answer: text, blocks });
  await deleteTurn(sessionId);
  return true;
}

// Called when the agent's turn ends — opencode `session.idle` (finished) or
// `session.error` (died) on the root session, relayed by the sandbox. If the
// agent already delivered its reply via `slack send`, the turn is already
// finalized and there's nothing to do. If it ended WITHOUT sending — e.g. it
// judged the message needed no reply — close the plan message (clearing the ⏳).
// Idle closes silently (no "_Done._" filler — see finalizeTurn's silent path);
// error surfaces an honest failure line.
export async function relayTurnEnd(
  sessionId: string,
  status: 'idle' | 'error' = 'idle',
  opencodeSessionId?: string,
): Promise<boolean> {
  const handle = await loadTurn(sessionId);
  if (!handle || handle.finalized) return false;

  // Subagents emit idle/error for their own opencode sessions too. The sandbox
  // already filters to the root session, but when the relay names a session,
  // re-check it against the canonical pin as the server-side guard.
  if (opencodeSessionId) {
    const [row] = await db
      .select({ pinned: projectSessions.opencodeSessionId })
      .from(projectSessions)
      .where(eq(projectSessions.sessionId, sessionId))
      .limit(1);
    if (row?.pinned && row.pinned !== opencodeSessionId) return false;
  }

  if (!(await claimFinalize(sessionId))) return false;
  await finalizeTurn(
    handle,
    status === 'error'
      ? { error: '_The run hit an error — open the session for details._' }
      : {},
  );
  await deleteTurn(sessionId);
  return true;
}
