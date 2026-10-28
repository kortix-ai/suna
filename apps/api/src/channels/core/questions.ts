/**
 * The agent's questions in a chat, for a platform whose port has `questions`
 * (conversation.ts `ChannelPort`). The core decides what is posted and what a
 * tap answers. The port renders, sends and edits. The adapter keeps intake and
 * the sender gate: it hands the core only taps from admitted senders.
 *
 *   post       → one single-select question with up to `maxButtons` options gets
 *                one button per option, anything else a numbered list; posted
 *                only where the agent's own call would run without approval
 *   a message  → the buttons go, and the footer says why (`clearQuestionButtons`)
 *   a tap      → the answer: in the turn the question still blocks, else a
 *                follow-up into the question's own session that quotes it
 */
import type { RuntimeQuestion } from '@kortix/api-contract/transcript';
import { chatEventDedup, projectSessions } from '@kortix/db';
import { eq, like } from 'drizzle-orm';
import { connectorActionAlwaysRuns } from '../../connectors/db-deps-rows';
import { logger } from '../../lib/logger';
import { getPendingQuestion, releaseRuntimeQuestion, renderAnswerPrompt, resolvePendingQuestion } from '../../projects/surface';
import { db } from '../../shared/db';
import { isUuid } from '../../shared/validate';
import { type ChannelMessage, type ChannelPort, type ChannelTarget, type SessionQuestion, routeChannelMessage } from './conversation';
import { findChatThread } from './threads';

/** The last line of a question message. The port words it, as it words a `ChannelNotice`. */
export type QuestionFooter =
  | { kind: 'ask'; buttons: boolean; numbered: boolean }
  | { kind: 'answered'; label: string }
  | { kind: 'answered_in_chat' }
  | { kind: 'new_conversation' }
  | { kind: 'earlier' };

/** Structured content. The port renders, escapes and clips it. */
export interface QuestionMessage {
  /** Empty when the stored question is gone: the footer only. */
  questions: RuntimeQuestion[];
  footer: QuestionFooter;
  /** One per option of a one-tap question. Absent: no buttons, and an edit removes them. */
  buttons?: Array<{ label: string; data: string }>;
}

/** A tap from a sender the adapter admitted. */
export interface QuestionTap {
  /** The tapped message's conversation; `messageId` is that message. */
  target: ChannelTarget;
  /** The tapped message, in the form `send` returns. */
  ref: string;
  /** The button's data. */
  data: string;
  /** The platform's handle that settles the tap. */
  id: string;
}

export type QuestionTapReply = { kind: 'answered'; label: string } | { kind: 'earlier' };

/** What a platform does to show agent questions. */
export interface QuestionPort {
  /** One button per option up to this many; more is a numbered list. At most 100 (a two-digit index). */
  maxButtons: number;
  /**
   * The agent's own call this post stands in for. `args` is the exact body the
   * port sends, so the connector policy decides on what is sent. Absent: no gate.
   */
  agentCall?(target: ChannelTarget, m: QuestionMessage): { slug: string; actionPath: string; args: Record<string, unknown> };
  /** Whether a tap can arrive. False: the question is posted as a list. Absent: true. */
  tapsReady?(target: ChannelTarget): Promise<boolean>;
  /** Post the message; returns its ref (no `|`). Throws on a refusal. */
  send(target: ChannelTarget, m: QuestionMessage): Promise<string>;
  /** Replace the message's content and buttons with `m`; no `m`: remove the buttons, keep the text. */
  edit(target: ChannelTarget, ref: string, m?: QuestionMessage): Promise<void>;
  /** Settle the tap; no reply settles it silently. Never throws. */
  answerTap(tap: QuestionTap, reply?: QuestionTapReply): Promise<void>;
  /** The conversation of `sessionId` the tap's message belongs to, or null. Absent: `tap.target` when it is that session's. */
  threadOfTap?(tap: QuestionTap, sessionId: string): Promise<string | null>;
}

/**
 * A question button's data: `kq:<question row id>:<option index>`, at most
 * 42 bytes, so it fits a 64-byte button payload. Persisted in chats: never
 * change the format.
 */
export function questionButtonData(pendingId: string, index: number): string {
  return `kq:${pendingId}:${index}`;
}

/** The question and option a button names, or null for a button Kortix did not post. */
export function parseQuestionButton(data: string): { pendingId: string; index: number } | null {
  const match = /^kq:([^:]+):(0|[1-9]\d?)$/.exec(data);
  return match && isUuid(match[1]) ? { pendingId: match[1], index: Number(match[2]) } : null;
}

/**
 * Post the agent's question in the conversation, as the agent would post it
 * with its own call, and only where that call would run without approval for
 * the agent's principal (its connector account, an admin's `risk` mode, a block
 * rule or a policy set still decide). True when posted. Never throws.
 */
export async function postQuestion(
  port: QuestionPort,
  target: ChannelTarget,
  { sessionId, pendingId, questions, principal }: SessionQuestion,
): Promise<boolean> {
  try {
    if (principal.projectId !== target.projectId || principal.sessionId !== sessionId) return false;
    const q = questions[0];
    const oneTap = questions.length === 1 && !!q && !q.multiple && q.options.length >= 1 && q.options.length <= Math.min(port.maxButtons, 100);
    const message = (buttons: boolean): QuestionMessage => ({
      questions,
      footer: { kind: 'ask', buttons, numbered: questions.length > 1 },
      ...(buttons
        ? { buttons: q!.options.map((o, i) => ({ label: o.label.trim() || String(i + 1), data: questionButtonData(pendingId, i) })) }
        : {}),
    });
    const runsUnattended = async (m: QuestionMessage) => {
      const call = port.agentCall?.(target, m);
      return !call || connectorActionAlwaysRuns({ principal, ...call });
    };
    let m = message(oneTap);
    if (!(await runsUnattended(m))) {
      logger.info('[channel] question left to the agent: its own call needs approval', { platform: target.platform, sessionId });
      return false;
    }
    if (oneTap && port.tapsReady && !(await port.tapsReady(target))) {
      m = message(false);
      if (!(await runsUnattended(m))) return false;
    }
    const ref = await port.send(target, m);
    if (m.buttons) await rememberQuestionButtons(target, ref, pendingId);
    logger.info('[channel] question posted', { platform: target.platform, sessionId, buttons: !!m.buttons });
    return true;
  } catch (error) {
    logger.warn('[channel] question not posted', { platform: target.platform, sessionId, error: String(error) });
    return false;
  }
}

/**
 * A question with buttons stays answerable until someone answers it another
 * way. Its message is kept for 7 days on the TTL key table, so the next message
 * in the conversation can take the buttons away (`clearQuestionButtons`).
 * Key: `<platform>:question-buttons:<project>:<workspace>:<thread>|<message ref>|<question id>`.
 * Persisted: never change the format.
 */
const questionButtonsPrefix = (target: Pick<ChannelTarget, 'platform' | 'projectId' | 'workspaceId' | 'threadId'>) =>
  `${target.platform}:question-buttons:${target.projectId}:${target.workspaceId}:${target.threadId}|`;

/** A LIKE pattern for keys that start with `prefix`; its own wildcards match literally. */
const startsWith = (prefix: string) => `${prefix.replace(/[\\%_]/g, '\\$&')}%`;

async function rememberQuestionButtons(target: ChannelTarget, ref: string, pendingId: string): Promise<void> {
  await db
    .insert(chatEventDedup)
    .values({ eventId: `${questionButtonsPrefix(target)}${ref}|${pendingId}`, expiresAt: new Date(Date.now() + 7 * 24 * 3600_000) })
    .onConflictDoNothing()
    .catch((error) => logger.warn('[channel] question buttons not remembered', { platform: target.platform, error: String(error) }));
}

/** An edit that logs its failure: the message keeps its buttons, and a later tap is answered as before. */
const editQuestion = (port: QuestionPort, target: ChannelTarget, ref: string, m?: QuestionMessage) =>
  Promise.resolve()
    .then(() => port.edit(target, ref, m))
    .catch((error) => logger.warn('[channel] question message not edited', { platform: target.platform, error: String(error) }));

/** Settle a tap; a failure is logged, never thrown. */
const settleTap = (port: QuestionPort, tap: QuestionTap, reply?: QuestionTapReply) =>
  Promise.resolve()
    .then(() => port.answerTap(tap, reply))
    .catch((error) => logger.warn('[channel] question tap not settled', { platform: tap.target.platform, error: String(error) }));

/**
 * Take the buttons off every question still showing them in this conversation,
 * and say why in the message's last line: the person answered in the chat, or
 * started a new conversation. Best-effort.
 */
export async function clearQuestionButtons(
  port: QuestionPort,
  target: ChannelTarget,
  why: 'answered_in_chat' | 'new_conversation',
): Promise<void> {
  const prefix = questionButtonsPrefix(target);
  const rows = await db
    .delete(chatEventDedup)
    .where(like(chatEventDedup.eventId, startsWith(prefix)))
    .returning({ key: chatEventDedup.eventId })
    .catch(() => []);
  for (const { key } of rows) {
    const [ref, pendingId] = key.slice(prefix.length).split('|');
    const asked = pendingId ? await getPendingQuestion(target.projectId, pendingId).catch(() => null) : null;
    await editQuestion(port, target, ref!, { questions: asked?.questions ?? [], footer: { kind: why } });
  }
}

/**
 * A tap on a question button. In a conversation of the question's session, it
 * answers the question: in the turn it still blocks (the server could not
 * release it when it was posted), else as a follow-up that quotes it. A tap on
 * a question from before a reset, or of another session, answers nothing.
 * `followUp`: the adapter's persisted keys and prompt for the answer, delivered
 * into `threadId`. Throws to ask the transport for a retry.
 */
export async function handleQuestionTap(
  port: ChannelPort & { questions: QuestionPort },
  tap: QuestionTap,
  followUp: (threadId: string, answer: string) => Pick<ChannelMessage, 'keys' | 'followUp'>,
  run: { finalAttempt: boolean },
): Promise<void> {
  const questions = port.questions;
  const button = parseQuestionButton(tap.data);
  // A button Kortix did not post (the agent may post its own).
  if (!button) return settleTap(questions, tap);

  const asked = await getPendingQuestion(tap.target.projectId, button.pendingId);
  const option = asked?.questions[0]?.options[button.index];
  const threadId = asked && option ? await threadOfTap(questions, tap, asked.sessionId) : null;
  if (!asked || !option || !threadId) {
    await settleTap(questions, tap, { kind: 'earlier' });
    await editQuestion(questions, tap.target, tap.ref);
    return;
  }

  const answers = [[option.label]];
  await settleTap(questions, tap, { kind: 'answered', label: option.label });
  await editQuestion(questions, tap.target, tap.ref, { questions: asked.questions, footer: { kind: 'answered', label: option.label } });
  // A later message in the conversation must not rewrite this answer.
  await db
    .delete(chatEventDedup)
    .where(like(chatEventDedup.eventId, startsWith(`${questionButtonsPrefix({ ...tap.target, threadId })}${tap.ref}|`)))
    .catch(() => undefined);
  // The server could not release the question when it was posted, so it still
  // blocks the turn: answer it there, as the web does (routes/turn-questions.ts).
  // A retry finds its own answer stored and tries the release again.
  // ponytail: a crash after this release and before the job settles also sends
  // the follow-up once on the retry.
  const inTurn = asked.answeredAt
    ? JSON.stringify(asked.answers) === JSON.stringify(answers)
    : await resolvePendingQuestion({ sessionId: asked.sessionId, requestId: asked.requestId, answers });
  if (inTurn) {
    const released = await releaseRuntimeQuestion(asked.sessionId, asked.requestId, answers);
    if (released === 'released') return;
    // A running session's follow-up would wait behind the turn the question
    // blocks (up to the waiting-turn bound): retry, and the last attempt
    // follows up. A parked or ended session has no such turn: follow up now.
    if (released === 'unreachable' && !run.finalAttempt && (await sessionStatus(asked.sessionId)) === 'running') {
      throw new Error(`${tap.target.platform} question release unreachable`);
    }
  }

  // Nothing reaches the agent (its session is gone, or the conversation moved
  // on to another): the message must not keep saying "Answered".
  const undelivered = async () => {
    await editQuestion(questions, tap.target, tap.ref, { questions: asked.questions, footer: { kind: 'earlier' } });
    return null;
  };
  await routeChannelMessage(
    {
      notify: (target, notice) => port.notify(target, notice),
      // Only into the question's own session: a conversation that moved on (a
      // reset, then a new message) since the check refuses it. A tap never
      // restarts a conversation: any verdict but deliver is a refusal.
      prepareFollowUp: async (target, thread) => {
        const verdict =
          thread.sessionId === asked.sessionId ? await (port.prepareFollowUp?.(target, thread) ?? 'deliver') : 'refuse';
        if (verdict === 'deliver') return verdict;
        await undelivered();
        return 'refuse';
      },
    },
    {
      target: { ...tap.target, threadId },
      ...followUp(threadId, renderAnswerPrompt(asked.questions, answers)),
      // A tap never starts a session.
      plan: undelivered,
    },
    run,
  );
}

async function threadOfTap(port: QuestionPort, tap: QuestionTap, sessionId: string): Promise<string | null> {
  if (port.threadOfTap) return port.threadOfTap(tap, sessionId);
  return (await findChatThread(tap.target))?.sessionId === sessionId ? tap.target.threadId : null;
}

async function sessionStatus(sessionId: string): Promise<string | null> {
  const [row] = await db.select({ status: projectSessions.status }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1);
  return row?.status ?? null;
}
