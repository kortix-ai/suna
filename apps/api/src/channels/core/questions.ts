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
 *   a press    → the same answer for an adapter that acknowledges and edits
 *                itself: `decideQuestionPress`, then `settleQuestionAnswer`
 */
import type { RuntimeQuestion } from '@kortix/api-contract/transcript';
import { chatEventDedup, projectSessions } from '@kortix/db';
import { eq, like } from 'drizzle-orm';
import { connectorActionAlwaysRuns } from '../../connectors/db-deps-rows';
import { logger } from '../../lib/logger';
import { getPendingQuestion, releaseRuntimeQuestion, renderAnswerPrompt, resolvePendingQuestion } from '../../projects/surface';
import { db } from '../../shared/db';
import { type ChannelMessage, type ChannelPort, type ChannelTarget, type SessionQuestion, routeChannelMessage } from './conversation';
import { parseQuestionButton, questionButtonData } from './question-token';
import { findChatThread } from './threads';

export { parseQuestionButton, questionButtonData };

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

/** One question's answer in a press: indexes into the stored question's options, and free text. */
export interface QuestionPick {
  question: number;
  options: number[];
  text?: string;
}

/** A press or a form submit from a sender the adapter admitted. */
export interface QuestionPress {
  /** The pressed message's conversation; `projectId` is the thread's project. */
  target: ChannelTarget;
  /** The pressed message, in the form the port stores it (no `|`). */
  ref: string;
  /** The stored question (`session_pending_questions.id`) the token names. */
  pendingId: string;
  picks: QuestionPick[];
}

/** A press the stored question takes. */
export interface QuestionAnswer {
  sessionId: string;
  requestId: string;
  /** The conversation of `sessionId` the press belongs to. */
  threadId: string;
  /** The stored questions. */
  questions: RuntimeQuestion[];
  /** One per stored question; `[]`: this press does not answer it. */
  answers: string[][];
  /** Every question is answered. */
  whole: boolean;
  /** The picked labels and text, `, `-joined: the acknowledgement and the footer. */
  label: string;
  /** The follow-up text: the answered questions, each with its answer. */
  prompt: string;
}

export type QuestionDecision = { kind: 'earlier'; questions: RuntimeQuestion[] } | { kind: 'answer'; answer: QuestionAnswer };

/**
 * Deliver an answer as a follow-up: only into its `sessionId`, never creating
 * or reviving a session, with one idempotency key per press. 'gone': the
 * session is gone or the conversation moved on. Throws to ask for a retry.
 */
export type AnswerDelivery = (answer: QuestionAnswer) => Promise<'handled' | 'gone'>;

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
    if (m.buttons) await rememberQuestionMessage(target, ref, pendingId);
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

/** `text` as a LIKE pattern whose wildcards match literally. */
const literal = (text: string) => text.replace(/[\\%_]/g, '\\$&');

/** A LIKE pattern for keys that start with `prefix`. */
const startsWith = (prefix: string) => `${literal(prefix)}%`;

/** Keep a posted question's message (`ref`, no `|`) for 7 days. Never throws. */
export async function rememberQuestionMessage(target: ChannelTarget, ref: string, pendingId: string): Promise<void> {
  await db
    .insert(chatEventDedup)
    .values({ eventId: `${questionButtonsPrefix(target)}${ref}|${pendingId}`, expiresAt: new Date(Date.now() + 7 * 24 * 3600_000) })
    .onConflictDoNothing()
    .catch((error) => logger.warn('[channel] question buttons not remembered', { platform: target.platform, error: String(error) }));
}

/** The kept message of a question in this conversation, or null once it is answered or cleared. */
export async function rememberedQuestionRef(target: ChannelTarget, pendingId: string): Promise<string | null> {
  const prefix = questionButtonsPrefix(target);
  const [row] = await db
    .select({ key: chatEventDedup.eventId })
    .from(chatEventDedup)
    .where(like(chatEventDedup.eventId, `${startsWith(prefix)}|${literal(pendingId)}`))
    .limit(1);
  return row ? row.key.slice(prefix.length).split('|')[0]! : null;
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

  const press: QuestionPress = {
    target: tap.target,
    ref: tap.ref,
    pendingId: button.pendingId,
    picks: [{ question: button.question, options: [button.index] }],
  };
  const decision = await decideQuestionPress(press, questions.threadOfTap?.bind(questions, tap));
  if (decision.kind === 'earlier') {
    await settleTap(questions, tap, { kind: 'earlier' });
    await editQuestion(questions, tap.target, tap.ref);
    return;
  }

  const { answer } = decision;
  await settleTap(questions, tap, { kind: 'answered', label: answer.label });
  await editQuestion(questions, tap.target, tap.ref, { questions: answer.questions, footer: { kind: 'answered', label: answer.label } });
  const deliver: AnswerDelivery = async (a) => {
    let gone = false;
    await routeChannelMessage(
      {
        notify: (target, notice) => port.notify(target, notice),
        // Only into the question's own session: a conversation that moved on (a
        // reset, then a new message) since the check refuses it. A tap never
        // restarts a conversation: any verdict but deliver is a refusal.
        prepareFollowUp: async (target, thread) => {
          const verdict = thread.sessionId === a.sessionId ? await (port.prepareFollowUp?.(target, thread) ?? 'deliver') : 'refuse';
          if (verdict === 'deliver') return verdict;
          gone = true;
          return 'refuse';
        },
      },
      {
        target: { ...tap.target, threadId: a.threadId },
        ...followUp(a.threadId, a.prompt),
        // A tap never starts a session.
        plan: async () => {
          gone = true;
          return null;
        },
      },
      run,
    );
    return gone ? 'gone' : 'handled';
  };
  // Nothing reached the agent (its session is gone, or the conversation moved
  // on to another): the message must not keep saying "Answered".
  if ((await settleQuestionAnswer(press, answer, deliver, run)) === 'gone') {
    await editQuestion(questions, tap.target, tap.ref, { questions: answer.questions, footer: { kind: 'earlier' } });
  }
}

/**
 * What a press answers. Reads only, so an adapter can decide inside the
 * platform's acknowledgement window. `earlier`: the stored question is gone or
 * of another project, the picks do not fit it, or the press is not in a
 * conversation of its session. `threadOf`: the conversation of that session the
 * press belongs to, or null; absent: the press's own, when it is that session's.
 */
export async function decideQuestionPress(
  p: QuestionPress,
  threadOf: (sessionId: string) => Promise<string | null> = async (sessionId) =>
    (await findChatThread(p.target))?.sessionId === sessionId ? p.target.threadId : null,
): Promise<QuestionDecision> {
  const asked = await getPendingQuestion(p.target.projectId, p.pendingId);
  if (!asked) return { kind: 'earlier', questions: [] };
  const earlier: QuestionDecision = { kind: 'earlier', questions: asked.questions };
  const answers = asked.questions.map((): string[] => []);
  const seen = new Set<number>();
  for (const { question, options, text } of p.picks) {
    const q = asked.questions[question];
    const typed = text?.trim();
    // Each question once, each option once, several options only on a
    // multi-select, and text only where the question takes its own answer.
    if (
      !q ||
      seen.has(question) ||
      options.some((o, i) => !q.options[o] || options.indexOf(o) !== i) ||
      (options.length > 1 && !q.multiple) ||
      (typed && q.custom === false && q.options.length > 0)
    ) {
      return earlier;
    }
    seen.add(question);
    answers[question] = [...options.map((o) => q.options[o]!.label), ...(typed ? [typed] : [])];
  }
  if (answers.every((a) => a.length === 0)) return earlier;
  const threadId = await threadOf(asked.sessionId);
  if (!threadId) return earlier;

  const answered = answers.flatMap((a, i) => (a.length ? [i] : []));
  return {
    kind: 'answer',
    answer: {
      sessionId: asked.sessionId,
      requestId: asked.requestId,
      threadId,
      questions: asked.questions,
      answers,
      whole: answered.length === answers.length,
      label: answers.flat().join(', '),
      prompt: renderAnswerPrompt(
        answered.map((i) => asked.questions[i]),
        answered.map((i) => answers[i]),
      ),
    },
  };
}

/**
 * Answer the question with a press `decideQuestionPress` accepted: in the turn
 * it still blocks (the server could not release it when it was posted), else
 * as a follow-up through `deliver`. Only a whole answer goes to the turn: the
 * runtime takes every answer at once. Throws to ask the transport for a retry.
 */
export async function settleQuestionAnswer(
  p: QuestionPress,
  a: QuestionAnswer,
  deliver: AnswerDelivery,
  run: { finalAttempt: boolean },
): Promise<'in_turn' | 'delivered' | 'gone'> {
  if (a.whole) {
    // A later message in the conversation must not rewrite this answer.
    await db
      .delete(chatEventDedup)
      .where(like(chatEventDedup.eventId, startsWith(`${questionButtonsPrefix({ ...p.target, threadId: a.threadId })}${p.ref}|`)))
      .catch(() => undefined);
    // An open question still blocks the turn (the server could not release it
    // when it was posted): answer it there, as the web does
    // (routes/turn-questions.ts). A retry finds its own answer stored and
    // tries the release again.
    // ponytail: a crash after this release and before the job settles also sends
    // the follow-up once on the retry.
    const inTurn =
      (await resolvePendingQuestion({ sessionId: a.sessionId, requestId: a.requestId, answers: a.answers })) ||
      JSON.stringify((await getPendingQuestion(p.target.projectId, p.pendingId))?.answers) === JSON.stringify(a.answers);
    if (inTurn) {
      const released = await releaseRuntimeQuestion(a.sessionId, a.requestId, a.answers);
      if (released === 'released') return 'in_turn';
      // A running session's follow-up would wait behind the turn the question
      // blocks (up to the waiting-turn bound): retry, and the last attempt
      // follows up. A parked or ended session has no such turn: follow up now.
      if (released === 'unreachable' && !run.finalAttempt && (await sessionStatus(a.sessionId)) === 'running') {
        throw new Error(`${p.target.platform} question release unreachable`);
      }
    }
  }
  return (await deliver(a)) === 'gone' ? 'gone' : 'delivered';
}

async function sessionStatus(sessionId: string): Promise<string | null> {
  const [row] = await db.select({ status: projectSessions.status }).from(projectSessions).where(eq(projectSessions.sessionId, sessionId)).limit(1);
  return row?.status ?? null;
}
