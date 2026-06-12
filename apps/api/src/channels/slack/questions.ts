import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { projectSessions } from '@kortix/db';
import { db } from '../../shared/db';
import { appendStream, postBlocks, updateBlocks, type StreamTaskChunk } from '../slack-api';
import { ASK_TTL_MS, STREAM_TTL_MS } from './app';
import {
  claimFinalize,
  deleteStream,
  finalizeStream,
  isDeadStream,
  loadStream,
  markStreamDead,
  openStreamWithFirstStep,
  repaintLivePlan,
  saveStream,
  startTurnStream,
} from './streams';
import { respondViaUrl } from './interactivity';
import { escapeMrkdwn } from './util';
import type { PendingAsk, QuestionInfo, SlackInteractionPayload } from './types';

export type { QuestionInfo } from './types';

const pendingAsks = new Map<string, PendingAsk>();

setInterval(() => {
  const now = Date.now();
  for (const [askId, ask] of pendingAsks) {
    if (ask.expiry < now) {
      pendingAsks.delete(askId);
      ask.resolve(ask.questions.map(() => []));
    }
  }
}, 60_000).unref();

export async function postQuestionAndWait(
  sessionId: string,
  questions: QuestionInfo[],
): Promise<{ ok: boolean; ask_id?: string; answers?: string[][]; error?: string }> {
  const handle = await loadStream(sessionId);
  if (!handle) {
    return { ok: false, error: 'No active Slack turn for this session.' };
  }

  const teamId = handle.teamId;
  const originatingEvent = handle.originatingEvent;

  await finalizeStream(handle, { answer: '_Waiting on your answer below…_' });
  await deleteStream(sessionId);

  const askId = randomUUID();
  const blocks = buildQuestionBlocks(askId, questions);
  const messageTs = await postBlocks(
    handle.token,
    handle.channel,
    questions[0]?.question?.slice(0, 200) ?? 'A question for you',
    blocks,
    handle.triggerTs,
  );
  if (!messageTs) {
    return { ok: false, error: 'Failed to post the form to Slack.' };
  }
  const answers = await new Promise<string[][]>((resolve) => {
    pendingAsks.set(askId, {
      askId,
      questions,
      resolve,
      expiry: Date.now() + ASK_TTL_MS,
      channel: handle.channel,
      messageTs,
      token: handle.token,
      sessionId,
      projectId: handle.projectId,
      teamId,
      originatingEvent,
    });
  });
  return { ok: true, ask_id: askId, answers };
}

function buildQuestionBlocks(askId: string, questions: QuestionInfo[]): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  questions.forEach((q, i) => {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${escapeMrkdwn(q.question)}*` },
    });
    if (q.options.length > 0) {
      const options = q.options.map((o) => {
        const opt: Record<string, unknown> = {
          text: { type: 'plain_text', text: o.label.slice(0, 75), emoji: true },
          value: o.label.slice(0, 75),
        };
        if (o.description) {
          opt.description = {
            type: 'plain_text',
            text: o.description.slice(0, 75),
            emoji: true,
          };
        }
        return opt;
      });
      blocks.push({
        type: 'input',
        block_id: `q_${i}_choice`,
        label: { type: 'plain_text', text: 'Choose', emoji: true },
        element: q.multiple
          ? { type: 'checkboxes', action_id: 'value', options }
          : { type: 'radio_buttons', action_id: 'value', options },
        optional: q.custom !== false,
      });
    }
    if (q.custom !== false) {
      blocks.push({
        type: 'input',
        block_id: `q_${i}_custom`,
        label: { type: 'plain_text', text: q.options.length > 0 ? 'Or type your own answer' : 'Your answer', emoji: true },
        element: { type: 'plain_text_input', action_id: 'value', multiline: false },
        optional: q.options.length > 0,
      });
    }
  });
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'Submit', emoji: true },
        style: 'primary',
        action_id: 'ask_submit',
        value: askId,
      },
    ],
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
  const handle = await loadStream(sessionId);
  if (!handle || handle.finalized) {
    console.warn('[slack-webhook] turn-stream step relay dropped — no active stream', {
      sessionId,
      title: title.slice(0, 80),
      finalized: handle?.finalized ?? null,
    });
    return false;
  }

  if (!handle.streaming && !isDeadStream(handle)) {
    const firstStep: StreamTaskChunk = {
      type: 'task_update',
      id: 'step-0',
      title: title.slice(0, 200),
      status: 'in_progress',
    };
    if (opts.detail) firstStep.details = opts.detail.slice(0, 500);
    const opened = await openStreamWithFirstStep(handle, firstStep);
    if (!opened) return false;
    handle.expiry = Date.now() + STREAM_TTL_MS;
    await saveStream(handle);
    return true;
  }
  const chunks: StreamTaskChunk[] = [];
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
    chunks.push({
      type: 'task_update',
      id: last.id,
      title: last.title,
      status: 'complete',
      ...(last.output ? { output: last.output } : {}),
      ...(last.sources ? { sources: last.sources } : {}),
    });
  }
  const next: StreamTaskChunk = {
    type: 'task_update',
    id: `step-${handle.steps.length}`,
    title: title.slice(0, 200),
    status: 'in_progress',
  };
  if (opts.detail) next.details = opts.detail.slice(0, 500);
  handle.steps.push(next);
  chunks.push(next);
  handle.expiry = Date.now() + STREAM_TTL_MS;
  if (handle.streaming) {
    const appended = await appendStream(handle.token, handle.channel, handle.ts, chunks);
    if (!appended.ok) {
      // Slack auto-completed the stream mid-turn (inactivity). Without this the
      // step would silently vanish and the message would keep Slack's
      // "Something went wrong" rendering. Drop to repaint mode instead.
      markStreamDead(handle);
      await repaintLivePlan(handle);
    }
  } else {
    await repaintLivePlan(handle);
  }
  await saveStream(handle);
  return true;
}

export async function relayTurnAnswer(
  sessionId: string,
  text: string,
  blocks?: unknown[],
): Promise<boolean> {
  const handle = await loadStream(sessionId);
  if (!handle || handle.finalized) return false;
  // Win the finalize race against the watchdog / a duplicate send before we
  // run stopStream, so the message is closed exactly once.
  if (!(await claimFinalize(sessionId))) return false;
  await finalizeStream(handle, { answer: text, blocks });
  await deleteStream(sessionId);
  return true;
}

// Called when the agent's turn ends — opencode `session.idle` (finished) or
// `session.error` (died) on the root session, relayed by the sandbox. If the
// agent already delivered its reply via `slack send`, the stream is gone and
// there's nothing to do. If it ended WITHOUT sending — e.g. it judged the
// message needed no reply — close the live stream so the streaming plan / ⏳
// reaction doesn't hang until a timeout paints it as a failure. Idle closes
// silently (no "_Done._" filler — see finalizeStream's silent path); error
// surfaces an honest failure line.
export async function relayTurnEnd(
  sessionId: string,
  status: 'idle' | 'error' = 'idle',
  opencodeSessionId?: string,
): Promise<boolean> {
  const handle = await loadStream(sessionId);
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
  await finalizeStream(
    handle,
    status === 'error'
      ? { error: '_The run hit an error — open the session for details._' }
      : {},
  );
  await deleteStream(sessionId);
  return true;
}

export async function handleAskSubmit(payload: SlackInteractionPayload, askId: string): Promise<void> {
  const pending = pendingAsks.get(askId);
  if (!pending) {
    await respondViaUrl(payload.response_url, {
      response_type: 'ephemeral',
      text: 'This form has already been submitted or expired.',
    });
    return;
  }
  pendingAsks.delete(askId);

  const values = payload.state?.values ?? {};
  const answers: string[][] = pending.questions.map((q, i) => {
    const out: string[] = [];
    const choice = values[`q_${i}_choice`]?.value;
    if (choice) {
      if (q.multiple) {
        for (const opt of choice.selected_options ?? []) {
          if (opt?.value) out.push(opt.value);
        }
      } else if (choice.selected_option?.value) {
        out.push(choice.selected_option.value);
      }
    }
    const custom = values[`q_${i}_custom`]?.value?.value?.trim();
    if (custom) out.push(custom);
    return out;
  });

  // Spin up a fresh stream BELOW the form so the agent's continuation
  // (more `slack step`s + the final `slack send`) lands in chronological
  // order under the user's submitted answers. Without this, the old
  // (parked) stream message above the form gets edited in-place.
  try {
    const newHandle = await startTurnStream(
      pending.projectId,
      pending.teamId,
      pending.originatingEvent,
      'Continuing…',
    );
    if (newHandle) {
      newHandle.sessionId = pending.sessionId;
      await saveStream(newHandle);
    }
  } catch (err) {
    console.warn('[slack-webhook] post-question stream re-open failed', err);
  }

  pending.resolve(answers);

  if (pending.messageTs) {
    const recap: Array<Record<string, unknown>> = [];
    pending.questions.forEach((q, i) => {
      recap.push({
        type: 'section',
        text: { type: 'mrkdwn', text: `*${escapeMrkdwn(q.question)}*` },
      });
      const picked = answers[i] ?? [];
      if (picked.length > 0) {
        recap.push({
          type: 'context',
          elements: [{ type: 'mrkdwn', text: `→ ${picked.map(escapeMrkdwn).join(', ')}` }],
        });
      }
    });
    recap.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: '✅  Submitted' }],
    });
    await updateBlocks(pending.token, pending.channel, pending.messageTs, 'Submitted.', recap);
  }
}
