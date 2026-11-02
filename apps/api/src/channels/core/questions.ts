/**
 * The agent's questions in a chat, for a platform whose port has `questions`
 * (conversation.ts `ChannelPort`). The core decides what is posted and what a
 * tap answers. The port renders, sends and edits. The adapter keeps intake and
 * the sender gate: it hands the core only taps from admitted senders.
 *
 *   post       → buttons: one single-select question gets one button per
 *                option; several questions or a multi-select show one question
 *                at a time (`QuestionSteps`). Options past `maxButtons` turn
 *                pages. A numbered list only where a tap cannot arrive or a
 *                question has no option to tap. Posted only where the agent's
 *                own call would run without approval
 *   a message  → on a question shown one at a time that takes typed text: its
 *                answer (`answerQuestionInChat`); else it carries the answers
 *                so far (`questionPicksSoFar`), the buttons go, and the footer
 *                says why (`clearQuestionButtons`)
 *   a tap      → a pick, a tick, Done or a page turn; the last answer goes in
 *                the turn the question still blocks, else as a follow-up into
 *                the question's own session that quotes it
 *   a press    → the same answer for an adapter that acknowledges and edits
 *                itself: `decideQuestionPress`, then `settleQuestionAnswer`
 */
import type { RuntimeQuestion } from '@kortix/api-contract/transcript';
import { chatEventDedup, projectSessions } from '@kortix/db';
import { desc, eq, inArray, like } from 'drizzle-orm';
import { connectorActionAlwaysRuns } from '../../connectors/db-deps-rows';
import { logger } from '../../lib/logger';
import {
  advancePendingQuestionSteps,
  getPendingQuestion,
  pendingQuestionStepsBy,
  releaseRuntimeQuestion,
  renderAnswerPrompt,
  resolvePendingQuestion,
} from '../../projects/surface';
import { db } from '../../shared/db';
import { type ChannelMessage, type ChannelPort, type ChannelTarget, type SessionQuestion, routeChannelMessage } from './conversation';
import { parseQuestionButton, parseQuestionControl, questionButtonData, questionDoneData, questionPageData } from './question-token';
import { findChatThread, findChatThreadSession } from './threads';

export { parseQuestionButton, questionButtonData };

/** The last line of a question message. The port words it, as it words a `ChannelNotice`. */
export type QuestionFooter =
  | { kind: 'ask'; buttons: boolean; numbered: boolean }
  /** A question shown one at a time: `many` ticks options for Done; `typed`: a typed message answers it. */
  | { kind: 'step'; many: boolean; typed: boolean }
  | { kind: 'answered'; label: string }
  | { kind: 'answered_in_chat' }
  | { kind: 'new_conversation' }
  | { kind: 'earlier' };

/** Structured content. The port renders, escapes and clips it. */
export interface QuestionMessage {
  /** Empty when the stored question is gone: the footer only. */
  questions: RuntimeQuestion[];
  footer: QuestionFooter;
  /** One per option on this page; `ticked` on a multi-select. Absent: no buttons, and an edit removes them. */
  buttons?: Array<{ label: string; data: string; ticked?: boolean }>;
  /** The page turns of a question with more options than `maxButtons`. */
  back?: string;
  more?: string;
  /** A multi-select's Done. */
  done?: string;
  /** Several questions: the one shown, from 1, of `count`. */
  step?: { at: number; count: number };
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

export type QuestionTapReply =
  | { kind: 'answered'; label: string }
  | { kind: 'earlier' }
  /** A tap on a step already answered: a double tap, two people, an old copy. */
  | { kind: 'already_answered' }
  /** Done with no option ticked. */
  | { kind: 'none_ticked' };

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
 * A chat's answers so far (`session_pending_questions.chat_steps`), written
 * only by compare-and-set on the value read. Persisted: add fields, never
 * change one.
 */
export interface QuestionSteps {
  /** The question on screen, from 0; the question count once every answer is in. */
  step: number;
  /** One per question before `step`. */
  picks: QuestionPick[];
  /** The options ticked on a multi-select `step`. */
  ticked: number[];
  /** The tap or message that wrote this: its retry changes nothing. */
  by: string;
  /** The message that shows the questions. */
  ref: string;
}

const NO_STEPS: QuestionSteps = { step: 0, picks: [], ticked: [], by: '', ref: '' };

/** Several questions, or a multi-select: shown one at a time, answered with the last one. */
const isStepped = (questions: RuntimeQuestion[]) => questions.length > 1 || !!questions[0]?.multiple;

/**
 * Deliver an answer as a follow-up: only into its `sessionId`, never creating
 * or reviving a session, with one idempotency key per press. 'gone': the
 * session is gone or the conversation moved on. Throws to ask for a retry.
 */
export type AnswerDelivery = (answer: QuestionAnswer) => Promise<'handled' | 'gone'>;

/** What a platform does to show agent questions. */
export interface QuestionPort {
  /** Option buttons on one page; more options turn pages. At most 100 (a two-digit index). */
  maxButtons: number;
  /**
   * The agent's own call this post stands in for. `args` is the exact body the
   * port sends, so the connector policy decides on what is sent. Absent: no gate.
   */
  agentCall?(target: ChannelTarget, m: QuestionMessage): { slug: string; actionPath: string; args: Record<string, unknown> };
  /** Whether a tap can arrive. False: the question is posted as a numbered list. Absent: true. */
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
    // A button names its question and option in two digits each (question-token.ts).
    const tappable = questions.length >= 1 && questions.length <= 100 && questions.every((q) => q.options.length >= 1 && q.options.length <= 100);
    const list: QuestionMessage = { questions, footer: { kind: 'ask', buttons: false, numbered: questions.length > 1 } };
    const runsUnattended = async (m: QuestionMessage) => {
      const call = port.agentCall?.(target, m);
      return !call || connectorActionAlwaysRuns({ principal, ...call });
    };
    let m = tappable ? stepMessage(port, pendingId, questions, NO_STEPS) : list;
    // Questions shown one at a time reach the chat by edits the gate never sees: it decides on the list, which holds every one.
    if (!(await runsUnattended(m)) || (m !== list && isStepped(questions) && !(await runsUnattended(list)))) {
      logger.info('[channel] question left to the agent: its own call needs approval', { platform: target.platform, sessionId });
      return false;
    }
    if (m.buttons && port.tapsReady && !(await port.tapsReady(target))) {
      m = list;
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
 * The message for `steps`: its question, the options of `page` (clamped) as
 * buttons, the page turns, a multi-select's Done. A single single-select
 * question keeps the one-tap message.
 */
function stepMessage(port: QuestionPort, pendingId: string, questions: RuntimeQuestion[], steps: QuestionSteps, page = 0): QuestionMessage {
  const at = steps.step;
  const q = questions[at]!;
  const per = perPage(port);
  const last = Math.ceil(q.options.length / per) - 1;
  const shown = Math.min(Math.max(page, 0), last);
  const first = shown * per;
  const stepped = isStepped(questions);
  return {
    questions: stepped ? [q] : questions,
    footer: stepped ? { kind: 'step', many: !!q.multiple, typed: q.custom !== false } : { kind: 'ask', buttons: true, numbered: false },
    buttons: q.options.slice(first, first + per).map((o, j) => ({
      label: o.label.trim() || String(first + j + 1),
      data: questionButtonData(pendingId, first + j, at),
      ...(steps.ticked.includes(first + j) ? { ticked: true } : {}),
    })),
    ...(shown > 0 ? { back: questionPageData(pendingId, at, shown - 1) } : {}),
    ...(shown < last ? { more: questionPageData(pendingId, at, shown + 1) } : {}),
    ...(q.multiple ? { done: questionDoneData(pendingId, at) } : {}),
    ...(questions.length > 1 ? { step: { at: at + 1, count: questions.length } } : {}),
  };
}

const perPage = (port: QuestionPort) => Math.min(Math.max(port.maxButtons, 1), 100);

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

/** Message ids grow in a conversation (Telegram's do): the question message `ref` came before the message `target` names. */
const sentBefore = (ref: string, target: ChannelTarget) => Number(ref) < Number(target.messageId);

/**
 * The kept question messages of this conversation that the message `target`
 * names ends: those sent before it, so an older message's retry, or a question
 * posted while the message routes, keeps its buttons. `all`: every one.
 */
async function keptQuestions(target: ChannelTarget, all = false): Promise<Array<{ key: string; ref: string; pendingId: string }>> {
  const prefix = questionButtonsPrefix(target);
  const rows = await db.select({ key: chatEventDedup.eventId }).from(chatEventDedup).where(like(chatEventDedup.eventId, startsWith(prefix)));
  return rows.flatMap(({ key }) => {
    const [ref = '', pendingId = ''] = key.slice(prefix.length).split('|');
    return all || sentBefore(ref, target) ? [{ key, ref, pendingId }] : [];
  });
}

/**
 * Take the buttons off the questions still showing them in this conversation,
 * and say why in the message's last line: the person answered in the chat (the
 * questions sent before that message), or started a new conversation (every
 * one). Best-effort.
 */
export async function clearQuestionButtons(
  port: QuestionPort,
  target: ChannelTarget,
  why: 'answered_in_chat' | 'new_conversation',
): Promise<void> {
  const kept = await keptQuestions(target, why === 'new_conversation').catch(() => []);
  if (!kept.length) return;
  const rows = await db
    .delete(chatEventDedup)
    .where(inArray(chatEventDedup.eventId, kept.map((k) => k.key)))
    .returning({ key: chatEventDedup.eventId })
    .catch(() => []);
  for (const { key } of rows) {
    const { ref, pendingId } = kept.find((k) => k.key === key)!;
    const asked = pendingId ? await getPendingQuestion(target.projectId, pendingId).catch(() => null) : null;
    await editQuestion(port, target, ref, { questions: asked?.questions ?? [], footer: { kind: why } });
  }
}

/**
 * The answers given so far on the questions shown one at a time that a message
 * ends (`clearQuestionButtons`), as a follow-up quotes them: every question, an
 * unanswered one saying so. Null: none. Read before the message routes, and the
 * buttons cleared after it, so a retry of the message carries them again.
 */
export async function questionPicksSoFar(target: ChannelTarget): Promise<string | null> {
  const said: string[] = [];
  for (const { ref, pendingId } of await keptQuestions(target)) {
    const asked = await getPendingQuestion(target.projectId, pendingId);
    const picks = (asked?.chatSteps as QuestionSteps | null | undefined)?.picks ?? [];
    // Answered another way (the web, or a whole answer in the turn): nothing waits on these picks.
    if (!asked || asked.answers != null || !picks.length) continue;
    const decision = await decideQuestionPress({ target, ref, pendingId, picks }, async () => target.threadId);
    if (decision.kind === 'answer') said.push(renderAnswerPrompt(decision.answer.questions, decision.answer.answers));
  }
  return said.length ? said.join('\n\n') : null;
}

/** The follow-up of an answer: the adapter's persisted keys and envelope, delivered into `threadId`. */
type AnswerFollowUp = (threadId: string, answer: string) => Pick<ChannelMessage, 'keys' | 'followUp'>;

/**
 * A tap on a question button. In a conversation of the question's session, a
 * pick answers the question on screen: the next question follows in the same
 * message, and the last answer goes to the question's session: in the turn it
 * still blocks (the server could not release it when it was posted), else as a
 * follow-up that quotes it. A multi-select tap ticks or unticks, Done takes
 * the ticked options, a page turn redraws. A tap on another step changes
 * nothing; a tap on a question from before a reset, or of another session,
 * answers nothing. Throws to ask the transport for a retry, also when another
 * tap moved the steps first (`onFreshSteps`).
 */
export function handleQuestionTap(
  port: ChannelPort & { questions: QuestionPort },
  tap: QuestionTap,
  followUp: AnswerFollowUp,
  run: { finalAttempt: boolean },
): Promise<void> {
  return onFreshSteps(run, () => questionTap(port, tap, followUp, run));
}

/** One read of the steps for `handleQuestionTap`. */
async function questionTap(
  port: ChannelPort & { questions: QuestionPort },
  tap: QuestionTap,
  followUp: AnswerFollowUp,
  run: { finalAttempt: boolean },
): Promise<void> {
  const questions = port.questions;
  const option = parseQuestionButton(tap.data);
  const control = option ? null : parseQuestionControl(tap.data);
  const button = option ?? control;
  // A button Kortix did not post (the agent may post its own).
  if (!button) return settleTap(questions, tap);

  const reply = (r?: QuestionTapReply) => settleTap(questions, tap, r);
  const earlier = async () => {
    await reply({ kind: 'earlier' });
    await editQuestion(questions, tap.target, tap.ref);
  };
  const asked = await getPendingQuestion(tap.target.projectId, button.pendingId);
  const threadOf = questions.threadOfTap?.bind(questions, tap) ?? ownThread(tap.target);
  const threadId = asked && (await threadOf(asked.sessionId));
  if (!asked || !threadId) return earlier();

  const steps = (asked.chatSteps as QuestionSteps | null) ?? NO_STEPS;
  const ctx: StepContext = { port, target: tap.target, ref: tap.ref, pendingId: button.pendingId, asked, threadId, reply, followUp, run };
  if (steps.by === tap.id) return replay(ctx, steps);
  const q = asked.questions[steps.step];
  if (!q || button.question !== steps.step) {
    await reply({ kind: 'already_answered' });
    return redraw(ctx, steps);
  }
  if (control && control.control !== 'done') {
    await reply();
    return editQuestion(questions, tap.target, tap.ref, stepMessage(questions, button.pendingId, asked.questions, steps, control.control));
  }
  const at = { by: tap.id, ref: tap.ref };
  if (control) {
    if (!q.multiple) return earlier();
    if (!steps.ticked.length) return reply({ kind: 'none_ticked' });
    return applySteps(ctx, asked.chatSteps, advance(steps, { question: steps.step, options: steps.ticked }, at));
  }
  const index = option!.index;
  if (!q.options[index]) return earlier();
  if (!q.multiple) return applySteps(ctx, asked.chatSteps, advance(steps, { question: steps.step, options: [index] }, at));
  const ticked = steps.ticked.includes(index) ? steps.ticked.filter((o) => o !== index) : [...steps.ticked, index].sort((a, b) => a - b);
  return applySteps(ctx, asked.chatSteps, { ...steps, ticked, ...at }, Math.floor(index / perPage(questions)));
}

/**
 * A message typed in a conversation whose newest question message shows one
 * question at a time: the answer to the question on screen, with its ticked
 * options, when that question takes typed text, the message was sent after the
 * question message, its session is not deleted and nothing else answered it.
 * Two people typing on one step at once each answer a step: a typed message
 * names no step, as a tap does. The next question follows, and the last answer
 * goes as a tap's does. False: the message is not an answer, and goes to the
 * agent as itself. `message.id` names the message for its retries. Throws to
 * ask the transport for a retry (`onFreshSteps`).
 */
export function answerQuestionInChat(
  port: ChannelPort & { questions: QuestionPort },
  target: ChannelTarget,
  message: { id: string; text: string },
  followUp: AnswerFollowUp,
  run: { finalAttempt: boolean },
): Promise<boolean> {
  return onFreshSteps(run, () => typedAnswer(port, target, message, followUp, run));
}

/** One read of the steps for `answerQuestionInChat`. */
async function typedAnswer(
  port: ChannelPort & { questions: QuestionPort },
  target: ChannelTarget,
  message: { id: string; text: string },
  followUp: AnswerFollowUp,
  run: { finalAttempt: boolean },
): Promise<boolean> {
  const text = message.text.trim();
  const thread = text ? await findChatThreadSession(target) : null;
  // A session deleted in the web is none: the message starts a new one (commands.ts `chatSession`).
  if (!thread || typeof (thread.metadata as Record<string, unknown> | null)?.deletedAt === 'string') return false;
  // A retry finds the question it answered; the buttons may be gone by then.
  const own = await pendingQuestionStepsBy(thread.sessionId, message.id);
  const shown = own ? null : await newestQuestionMessage(target);
  const pendingId = own ?? shown?.pendingId;
  const asked = pendingId ? await getPendingQuestion(target.projectId, pendingId) : null;
  if (!pendingId || !asked || asked.sessionId !== thread.sessionId || !isStepped(asked.questions)) return false;

  const steps = (asked.chatSteps as QuestionSteps | null) ?? NO_STEPS;
  const ref = shown?.ref ?? steps.ref;
  const ctx: StepContext = { port, target, ref, pendingId, asked, threadId: target.threadId, reply: async () => {}, followUp, run };
  if (steps.by === message.id) {
    await replay(ctx, steps);
    return true;
  }
  // Answered another way (the web, or a whole answer in the turn): no step waits on the message.
  if (asked.answers != null) return false;
  // A message sent before the question message (a late retry) is not its answer.
  if (!sentBefore(ref, target)) return false;
  const q = asked.questions[steps.step];
  if (!q || q.custom === false) return false;
  await applySteps(ctx, asked.chatSteps, advance(steps, { question: steps.step, options: steps.ticked, text }, { by: message.id, ref }));
  return true;
}

/** A question message, its stored question and where its answer goes. */
interface StepContext {
  port: ChannelPort & { questions: QuestionPort };
  target: ChannelTarget;
  ref: string;
  pendingId: string;
  asked: NonNullable<Awaited<ReturnType<typeof getPendingQuestion>>>;
  threadId: string;
  /** Settle the tap; a typed message has none. */
  reply: (r?: QuestionTapReply) => Promise<void>;
  followUp: AnswerFollowUp;
  run: { finalAttempt: boolean };
}

/** Another tap or message moved the steps between their read and the write. */
class StepsMoved extends Error {}

/**
 * `once` again on fresh steps after a `StepsMoved`: by the transport's retry, or
 * here on its last attempt, at most 3 more times. Nothing reaches the chat
 * before the write that lost, so a run again shows nothing twice.
 */
async function onFreshSteps<T>(run: { finalAttempt: boolean }, once: () => Promise<T>): Promise<T> {
  // ponytail: 3 more reads on the last attempt; steps that move 4 times in a row
  // drop the tap or message to the dead letters. Raise the bound if that shows up.
  for (let again = run.finalAttempt ? 3 : 0; ; again--) {
    try {
      return await once();
    } catch (error) {
      if (!(error instanceof StepsMoved) || again <= 0) throw error;
    }
  }
}

/** `steps` with `pick` recorded: the next question on screen, nothing ticked. */
const advance = (steps: QuestionSteps, pick: QuestionPick, at: Pick<QuestionSteps, 'by' | 'ref'>): QuestionSteps => ({
  step: steps.step + 1,
  picks: [...steps.picks, pick],
  ticked: [],
  ...at,
});

/**
 * Write `to` over `from` (the value read), then show it: the next question, or
 * the answer once every question has one. A last answer the stored question
 * does not take writes nothing.
 */
async function applySteps(ctx: StepContext, from: unknown, to: QuestionSteps, page = 0): Promise<void> {
  const done = to.step >= ctx.asked.questions.length;
  const decision = done ? await decideQuestionPress(stepsPress(ctx, to), async () => ctx.threadId) : null;
  if (decision?.kind === 'earlier') {
    await ctx.reply({ kind: 'earlier' });
    return editQuestion(ctx.port.questions, ctx.target, ctx.ref);
  }
  // Another tap or message moved the steps since the read: they are read again (`onFreshSteps`).
  if (!(await advancePendingQuestionSteps(ctx.target.projectId, ctx.pendingId, from, to))) {
    throw new StepsMoved(`${ctx.target.platform} question steps moved`);
  }
  if (decision) return sendAnswer(ctx, decision.answer, to);
  await ctx.reply();
  await editQuestion(ctx.port.questions, ctx.target, ctx.ref, stepMessage(ctx.port.questions, ctx.pendingId, ctx.asked.questions, to, page));
}

/** A retry of the tap or message that wrote `steps`: a last answer is sent again (its delivery is idempotent), else redrawn. */
async function replay(ctx: StepContext, steps: QuestionSteps): Promise<void> {
  if (steps.step < ctx.asked.questions.length) {
    await ctx.reply();
    return redraw(ctx, steps);
  }
  const decision = await decideQuestionPress(stepsPress(ctx, steps), async () => ctx.threadId);
  if (decision.kind === 'answer') return sendAnswer(ctx, decision.answer, steps);
  await ctx.reply({ kind: 'earlier' });
  await editQuestion(ctx.port.questions, ctx.target, ctx.ref);
}

/** Show `steps` again, so an edit the platform lost heals on the next tap. Every answer in: the buttons go. */
const redraw = (ctx: StepContext, steps: QuestionSteps) =>
  editQuestion(
    ctx.port.questions,
    ctx.target,
    ctx.ref,
    steps.step < ctx.asked.questions.length ? stepMessage(ctx.port.questions, ctx.pendingId, ctx.asked.questions, steps) : undefined,
  );

const stepsPress = (ctx: StepContext, steps: QuestionSteps): QuestionPress => ({ target: ctx.target, ref: ctx.ref, pendingId: ctx.pendingId, picks: steps.picks });

/** Every question answered: say so on the message, then answer the session. */
async function sendAnswer(ctx: StepContext, answer: QuestionAnswer, steps: QuestionSteps): Promise<void> {
  const questions = ctx.port.questions;
  await ctx.reply({ kind: 'answered', label: answer.label });
  await editQuestion(questions, ctx.target, ctx.ref, { questions: answer.questions, footer: { kind: 'answered', label: answer.label } });
  // Nothing reached the agent (its session is gone, or the conversation moved
  // on to another): the message must not keep saying "Answered".
  if ((await settleQuestionAnswer(stepsPress(ctx, steps), answer, deliverAnswer(ctx), ctx.run)) === 'gone') {
    await editQuestion(questions, ctx.target, ctx.ref, { questions: answer.questions, footer: { kind: 'earlier' } });
  }
}

/** Deliver an answer only into its own session, as a follow-up of the conversation. */
function deliverAnswer({ port, target, followUp, run }: StepContext): AnswerDelivery {
  return async (a) => {
    let gone = false;
    await routeChannelMessage(
      {
        notify: (t, notice) => port.notify(t, notice),
        // Only into the question's own session: a conversation that moved on (a
        // reset, then a new message) since the check refuses it. An answer never
        // restarts a conversation: any verdict but deliver is a refusal.
        prepareFollowUp: async (t, thread) => {
          const verdict = thread.sessionId === a.sessionId ? await (port.prepareFollowUp?.(t, thread) ?? 'deliver') : 'refuse';
          if (verdict === 'deliver') return verdict;
          gone = true;
          return 'refuse';
        },
        ...(port.turnModel ? { turnModel: (t, thread) => port.turnModel!(t, thread) } : {}),
      },
      {
        target: { ...target, threadId: a.threadId },
        ...followUp(a.threadId, a.prompt),
        // An answer never starts a session.
        plan: async () => {
          gone = true;
          return null;
        },
      },
      run,
    );
    return gone ? 'gone' : 'handled';
  };
}

/** The conversation of `sessionId` a press belongs to: its own, when it is that session's. */
const ownThread = (target: ChannelTarget) => async (sessionId: string) =>
  (await findChatThread(target))?.sessionId === sessionId ? target.threadId : null;

/** The newest question message with buttons in this conversation. */
async function newestQuestionMessage(target: ChannelTarget): Promise<{ ref: string; pendingId: string } | null> {
  const prefix = questionButtonsPrefix(target);
  const [row] = await db
    .select({ key: chatEventDedup.eventId })
    .from(chatEventDedup)
    .where(like(chatEventDedup.eventId, startsWith(prefix)))
    .orderBy(desc(chatEventDedup.expiresAt))
    .limit(1)
    .catch(() => []);
  const [ref, pendingId] = row ? row.key.slice(prefix.length).split('|') : [];
  return ref && pendingId ? { ref, pendingId } : null;
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
  threadOf: (sessionId: string) => Promise<string | null> = ownThread(p.target),
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
