/**
 * Turn-wide derivations and the row → props projection.
 *
 * PURE, no React. This is the `SessionTurnImpl` body with its ~28 `useMemo`s
 * turned into two cached functions:
 *
 *   - `deriveTurnView(turn, ctx)` — everything the old card computed from its
 *     `turn` and a handful of props. Cached on the turn OBJECT (a `WeakMap`),
 *     so an unchanged turn (`stabilizeTurns` keeps its identity) costs a map
 *     lookup and a six-field context compare. Only the streaming turn's
 *     object changes, so only its view is re-derived.
 *   - `projectTurnPlacements(group, turn, view, …)` — which rows of a turn
 *     render WHAT, and with which props. Every props object is
 *     reference-stable while its inputs (the resolved part objects and a few
 *     scalars) are unchanged, which is what lets `AssistantPartRow`'s memo
 *     bail for every row but the one a delta touched.
 *
 * WHY PLACEMENTS, NOT A ROLE PER ROW. The legacy turn DOM has TWO part
 * sections: the steps block (`<div class="space-y-3">` of bursts, standalone
 * tools and — in steps mode — prose), and the body below it (the streamed
 * response, or the inline text + answered-question list). In response mode a
 * turn's reasoning burst sits in the steps block ABOVE the prose even though
 * the prose part comes first on the wire; in inline mode a context row's
 * answered questions render in the body while its reasoning renders in the
 * steps block. So a row maps to at most two placements — one per section —
 * and the section decides where `TurnFrame` mounts it. Order is preserved
 * within each section. `AssistantPartRow` stays one component per placement.
 */
import { detectCommandFromText } from '@/features/session/detect-command';
import {
  type KortixSystemMessage,
  type SessionReport,
  extractKortixSystemMessages,
  extractSessionReport,
  stripKortixSystemTags,
} from '@/lib/utils/kortix-system-tags';
import type { ConversationDensity } from '@/stores/user-preferences-store';
import {
  type Command,
  type MessageWithParts,
  type ModelPricingLookup,
  type Part,
  type PermissionRequest,
  type QuestionRequest,
  type TextPart,
  type ToolPart,
  type Turn,
  type TurnCostInfo,
  collectTurnParts,
  findLastTextPart,
  getPermissionForTool,
  getShellModePart,
  getTurnCost,
  getTurnError,
  getTurnErrorDetails,
  isAgentPart,
  isAttachment,
  isReasoningPart,
  isTextPart,
  isToolPart,
  shouldShowToolPart,
} from '@/ui';
import type { TimelineAssistantPartRow, TimelinePartRef } from '@kortix/sdk';
import { abortErrorReason, isAbortError } from '@kortix/sdk';

import { stripSystemPtyText } from '../message-parsing';
import { sessionTurnDurationMs, sessionTurnEndedAt } from '../session-turn-meta-rows';
import { isPlanWriteTool } from '../turn/plan-anchor';
import { samePartsList } from '../turn/same-parts';
import type { TurnRowGroup } from './build-chat-rows';

// ============================================================================
// Optimistic answers cache
// ============================================================================
// When a user answers a question, we save the answers here immediately.
// This survives SSE `message.part.updated` events that may overwrite the
// tool part's state before the server has merged the answers.  The cache
// is keyed by the question tool part's `id` (stable across updates).
// Entries are cleaned up once the server's authoritative part arrives with
// real `metadata.answers`. Written by `SessionChat.handleQuestionReply`.

export const optimisticAnswersCache = new Map<
  string,
  { answers: string[][]; input: Record<string, unknown> }
>();

// ============================================================================
// Parse answers from the question tool's output string
// ============================================================================
// When metadata.answers is missing (e.g. after page reload, or the server
// never finalized the tool part), we can try to extract answers from the
// output string. The server formats it as:
//   "User has answered your questions: \"Q1\"=\"A1\". You can now continue..."
// This is a best-effort parser; if it can't match, returns null.

export function parseAnswersFromOutput(
  output: string,
  input?: { questions?: Array<{ question: string }> },
): string[][] | null {
  if (!output) return null;

  const questions = input?.questions;
  if (!questions || questions.length === 0) return null;

  // Try to extract "question"="answer" pairs from the output
  const pairRegex = /"([^"]*)"="([^"]*)"/g;
  const pairs: { question: string; answer: string }[] = [];
  let match;
  while ((match = pairRegex.exec(output)) !== null) {
    pairs.push({ question: match[1], answer: match[2] });
  }

  if (pairs.length > 0) {
    // Match pairs to input questions by order (they correspond 1:1)
    return questions.map((_, i) => {
      const pair = pairs[i];
      return pair ? [pair.answer] : [];
    });
  }

  // Fallback: if we can't parse pairs but the output mentions "answered",
  // return a placeholder to indicate the question was answered
  if (output.toLowerCase().includes('answered')) {
    return questions.map(() => ['Answered']);
  }

  return null;
}

// ============================================================================
// Abort state
// ============================================================================

/**
 * Pure derivation of "was this turn's error an abort, and why" from a turn's
 * assistant messages. Exercised by real behavior tests
 * (`interrupted-label.test.ts`) instead of a source-text pattern match.
 *
 * Scans for the FIRST assistant message carrying an object error (matching
 * `getTurnError`'s own "first wins" rule) and classifies THAT message once —
 * identity/reason come from the SDK's single `isAbortError`/`abortErrorReason`
 * classifier, which recognizes both real producers: the opencode wire's
 * `MessageAbortedError` and the client's synthesized `AbortError` patch
 * applied when the user hits Stop.
 */
export function deriveTurnErrorAbortState(turn: {
  assistantMessages: ReadonlyArray<{ info: unknown }>;
}): { isAbort: boolean; abortReason: string | undefined } {
  for (const msg of turn.assistantMessages) {
    const err = (msg.info as { error?: unknown }).error;
    if (!err || typeof err !== 'object') continue;
    const isAbort = isAbortError(err);
    return { isAbort, abortReason: isAbort ? abortErrorReason(err) : undefined };
  }
  return { isAbort: false, abortReason: undefined };
}

// ============================================================================
// Layer 1 — facts that depend on the turn alone
// ============================================================================

export interface TurnFacts {
  allParts: ReturnType<typeof collectTurnParts<MessageWithParts>>;
  hasSteps: boolean;
  hasReasoning: boolean;
  /** The host's compaction predicate — `info.summary === true` on any
   *  assistant message, or a `compaction` part. (The SDK's
   *  `turn-divider:compaction` row reads the USER message's parts instead;
   *  unverified against a real compaction transcript, so the host predicate
   *  keeps deciding the divider and the card.) */
  hasCompaction: boolean;
  shellModePart: ToolPart | undefined;
  lastTextPart: TextPart | undefined;
  responseRaw: string;
  abortedTextFallback: string;
  completedTextParts: string[];
  streamingResponseRaw: string;
  turnError: string | undefined;
  turnErrorIsAbort: boolean;
  turnErrorAbortReason: string | undefined;
  turnErrorDetails: ReturnType<typeof getTurnErrorDetails>;
  sessionReport: SessionReport | null;
  systemMessages: KortixSystemMessage[];
  hasVisibleUserContent: boolean;
  userMessageText: string;
  turnEndedAt: ReturnType<typeof sessionTurnEndedAt>;
  turnDurationMs: ReturnType<typeof sessionTurnDurationMs>;
}

/**
 * What the USER message alone decides. Keyed on the message object, not the
 * turn: a turn object is replaced whenever its assistant run changes, but its
 * `userMessage` keeps its identity, so the bubble's props stay stable while
 * the reply streams and `UserMessageRow` never re-renders for a delta.
 */
export interface UserMessageFacts {
  sessionReport: SessionReport | null;
  systemMessages: KortixSystemMessage[];
  hasVisibleUserContent: boolean;
  userMessageText: string;
}

const userFactsByMessage = new WeakMap<MessageWithParts, UserMessageFacts>();

export function deriveUserMessageFacts(userMessage: MessageWithParts): UserMessageFacts {
  const cached = userFactsByMessage.get(userMessage);
  if (cached) return cached;

  // Extract session report from user message (if present)
  let sessionReport: SessionReport | null = null;
  for (const p of userMessage.parts) {
    if (isTextPart(p)) {
      const report = extractSessionReport((p as TextPart).text || '');
      if (report) {
        sessionReport = report;
        break;
      }
    }
  }

  // Extract kortix_system messages for inline rendering (goal continuations, etc.)
  const systemMessages: KortixSystemMessage[] = [];
  for (const p of userMessage.parts) {
    if (isTextPart(p) && (p as TextPart).text) {
      systemMessages.push(...extractKortixSystemMessages((p as TextPart).text!));
    }
  }

  // Whether the user message has any visible content (non-synthetic, non-ignored
  // text, or attachments). Background task notifications inject synthetic-only
  // user messages that should not render a user bubble.
  const hasVisibleUserContent = ((): boolean => {
    // Session reports render as their own card — don't show as user bubble
    if (sessionReport) return false;
    const parts = userMessage.parts;
    // Parts not loaded yet (bridging / transient state) — assume visible
    // to prevent a flash where the bubble disappears momentarily.
    if (parts.length === 0) return true;
    // Has any non-synthetic, non-ignored text (including notification XML)?
    const hasVisibleText = parts.some(
      (p) =>
        isTextPart(p) &&
        !(p as TextPart).synthetic &&
        !(p as any).ignored &&
        !!stripKortixSystemTags((p as TextPart).text || '').trim(),
    );
    if (hasVisibleText) return true;
    // Has any attachment (image/PDF)?
    if (parts.some(isAttachment)) return true;
    // Has any agent part?
    if (parts.some(isAgentPart)) return true;
    return false;
  })();

  // User message text — for the command pill fallback
  const userTexts: string[] = [];
  for (const p of userMessage.parts) {
    if (!isTextPart(p) || (p as TextPart).synthetic || (p as any).ignored) continue;
    const text = stripSystemPtyText((p as TextPart).text);
    if (text.trim()) userTexts.push(text);
  }
  const userMessageText = userTexts.join('\n').trim();

  const facts: UserMessageFacts = {
    sessionReport,
    systemMessages,
    hasVisibleUserContent,
    userMessageText,
  };
  userFactsByMessage.set(userMessage, facts);
  return facts;
}

const factsByTurn = new WeakMap<Turn, TurnFacts>();

export function deriveTurnFacts(turn: Turn): TurnFacts {
  const cached = factsByTurn.get(turn);
  if (cached) return cached;

  const allParts = collectTurnParts(turn);
  // Check if there are visible steps that actually render inside the
  // collapsible steps section. Tool parts that are rendered elsewhere
  // (todowrite, task, question) don't count as "steps".
  const hasSteps = allParts.some(({ part }) => {
    if (part.type === 'compaction' || part.type === 'snapshot' || part.type === 'patch')
      return true;
    if (isToolPart(part)) {
      // `isPlanWriteTool` — NOT a bare `=== 'todowrite'`. The runtime emits
      // both spellings, and the plan card owns both (see plan-anchor.ts).
      if (isPlanWriteTool(part.tool) || part.tool === 'task' || part.tool === 'question')
        return false;
      return shouldShowToolPart(part);
    }
    return false;
  });
  const hasReasoning = allParts.some(({ part }) => isReasoningPart(part) && !!part.text?.trim());
  const hasCompaction =
    turn.assistantMessages.some((msg) => (msg.info as any).summary === true) ||
    turn.assistantMessages.some((msg) => msg.parts.some((p) => p.type === 'compaction'));

  let activeAssistantMessage: MessageWithParts | undefined;
  if (turn.assistantMessages.length > 0) {
    for (let i = turn.assistantMessages.length - 1; i >= 0; i--) {
      const msg = turn.assistantMessages[i];
      if (!(msg.info as any)?.time?.completed) {
        activeAssistantMessage = msg;
        break;
      }
    }
    activeAssistantMessage ??= turn.assistantMessages[turn.assistantMessages.length - 1];
  }
  let streamingResponseRaw = '';
  if (activeAssistantMessage) {
    for (const p of activeAssistantMessage.parts) {
      if (isTextPart(p)) streamingResponseRaw += p.text ?? '';
    }
  }
  const lastTextPart = findLastTextPart(allParts);
  const responseRaw = lastTextPart?.text ?? '';
  // Fallback: when aborted, collect ALL non-empty text parts if the
  // primary response is empty.  The last text part may have been lost
  // (timing between text-start and first text-delta) but earlier parts
  // might still have content.
  let abortedTextFallback = '';
  if (!responseRaw) {
    // Only activate for aborted/errored turns
    const hasError = turn.assistantMessages.some((m) => (m.info as any).error);
    if (hasError) {
      const texts: string[] = [];
      for (const { part } of allParts) {
        if (isTextPart(part) && part.text?.trim()) {
          texts.push(part.text);
        }
      }
      abortedTextFallback = texts.join('\n\n').trim();
    }
  }
  const completedTextParts = allParts
    .map(({ part }) => (isTextPart(part) ? part.text?.trim() : ''))
    .filter((text): text is string => Boolean(text));

  // Turn error — derived directly from message data (same approach as SolidJS reference).
  // Falls back to checking for dismissed question tool errors when no message-level error exists.
  let turnError = getTurnError(turn);
  if (!turnError) {
    // Check for dismissed question tool errors
    outer: for (const msg of turn.assistantMessages) {
      for (const part of msg.parts) {
        if (part.type !== 'tool') continue;
        const tool = part as ToolPart;
        if (tool.tool === 'question' && tool.state.status === 'error' && 'error' in tool.state) {
          turnError = (tool.state as { error: string }).error.replace(/^Error:\s*/, '');
          break outer;
        }
      }
    }
  }
  const { isAbort: turnErrorIsAbort, abortReason: turnErrorAbortReason } =
    deriveTurnErrorAbortState(turn);
  const turnErrorDetails = getTurnErrorDetails(turn);

  const shellModePart = getShellModePart(turn) as ToolPart | undefined;
  const { sessionReport, systemMessages, hasVisibleUserContent, userMessageText } =
    deriveUserMessageFacts(turn.userMessage);

  const facts: TurnFacts = {
    allParts,
    hasSteps,
    hasReasoning,
    hasCompaction,
    shellModePart,
    lastTextPart,
    responseRaw,
    abortedTextFallback,
    completedTextParts,
    streamingResponseRaw,
    turnError,
    turnErrorIsAbort,
    turnErrorAbortReason,
    turnErrorDetails,
    sessionReport,
    systemMessages,
    hasVisibleUserContent,
    userMessageText,
    turnEndedAt: sessionTurnEndedAt(turn),
    turnDurationMs: sessionTurnDurationMs(turn),
  };
  factsByTurn.set(turn, facts);
  return facts;
}

// ============================================================================
// Layer 2 — answered questions (turn + pending questions)
// ============================================================================

export interface AnsweredQuestions {
  parts: { part: ToolPart; messageId: string }[];
  ids: ReadonlySet<string>;
  byId: ReadonlyMap<string, ToolPart>;
}

const answeredByTurn = new WeakMap<
  Turn,
  { questions: QuestionRequest[]; sessionId: string; value: AnsweredQuestions }
>();

/**
 * Answered question parts — shown inline alongside streamed text.
 * Uses the optimisticAnswersCache as a fallback: when the user answers a
 * question we cache {answers, input} immediately. SSE message.part.updated
 * events can overwrite the tool part's state (wiping metadata.answers)
 * before the server has merged them. By checking the cache we guarantee
 * the answered card stays visible regardless of SSE timing.
 * Only skip tool parts whose callID matches a currently-pending question.
 */
export function deriveAnsweredQuestions(
  turn: Turn,
  questions: QuestionRequest[],
  sessionId: string,
): AnsweredQuestions {
  const cached = answeredByTurn.get(turn);
  if (cached && cached.questions === questions && cached.sessionId === sessionId) {
    return cached.value;
  }

  const pendingCallIds = new Set(
    questions.flatMap((q) => (q.sessionID === sessionId && q.tool?.callID ? [q.tool.callID] : [])),
  );

  // Collect ALL question tool parts first so we can determine which ones
  // were implicitly answered (i.e. the assistant continued past them).
  const questionInfos: {
    tool: ToolPart;
    msgId: string;
    msgIndex: number;
    partIndex: number;
  }[] = [];
  for (let mi = 0; mi < turn.assistantMessages.length; mi++) {
    const msg = turn.assistantMessages[mi];
    for (let pi = 0; pi < msg.parts.length; pi++) {
      const part = msg.parts[pi];
      if (part.type !== 'tool') continue;
      const tool = part as ToolPart;
      if (tool.tool !== 'question') continue;
      questionInfos.push({
        tool,
        msgId: msg.info.id,
        msgIndex: mi,
        partIndex: pi,
      });
    }
  }

  const result: { part: ToolPart; messageId: string }[] = [];
  for (const qInfo of questionInfos) {
    const { tool, msgId, msgIndex, partIndex } = qInfo;

    // Check if there are subsequent parts/messages AFTER this question
    // in the turn. If the assistant continued, this question was answered.
    const hasSubsequentContent = (() => {
      // Check for later parts in the same message
      const msg = turn.assistantMessages[msgIndex];
      for (let pi = partIndex + 1; pi < msg.parts.length; pi++) {
        const p = msg.parts[pi];
        if (p.type === 'step-finish' || p.type === 'step-start') continue;
        return true;
      }
      // Check for later messages in the turn
      return msgIndex < turn.assistantMessages.length - 1;
    })();

    const isPending = pendingCallIds.has(tool.callID);

    // Skip only if it IS the currently-pending question AND there's no
    // evidence it was already answered (no subsequent content).
    if (isPending && !hasSubsequentContent) continue;

    const serverAnswers = (tool.state as any)?.metadata?.answers;
    const cachedAnswers = optimisticAnswersCache.get(tool.id);
    const toolOutput = (tool.state as any)?.output as string | undefined;

    if (serverAnswers && serverAnswers.length > 0) {
      // Server has real answers — clean up cache if present
      if (cachedAnswers) optimisticAnswersCache.delete(tool.id);
      result.push({ part: tool, messageId: msgId });
    } else if (cachedAnswers) {
      // Server hasn't confirmed yet — use cached answers.
      // Build a synthetic tool part with the cached data so
      // AnsweredQuestionCard can render.
      const syntheticPart = {
        ...tool,
        state: {
          ...(tool.state as any),
          status: 'completed',
          input: cachedAnswers.input,
          metadata: {
            ...((tool.state as any)?.metadata ?? {}),
            answers: cachedAnswers.answers,
          },
        },
      } as unknown as ToolPart;
      result.push({ part: syntheticPart, messageId: msgId });
    } else if (toolOutput && hasSubsequentContent) {
      // Question was answered (output exists and assistant continued)
      // but metadata.answers was never set (e.g. after page reload).
      // Parse answers from the output string as a fallback.
      const parsed = parseAnswersFromOutput(toolOutput, (tool.state as any)?.input);
      if (parsed) {
        const syntheticPart = {
          ...tool,
          state: {
            ...(tool.state as any),
            status: 'completed',
            metadata: {
              ...((tool.state as any)?.metadata ?? {}),
              answers: parsed,
            },
          },
        } as unknown as ToolPart;
        result.push({ part: syntheticPart, messageId: msgId });
      }
    } else if (!toolOutput && hasSubsequentContent) {
      // Question was implicitly answered (assistant continued past it)
      // but neither metadata.answers nor output is available.
      // Show a minimal answered card using the input questions
      // with placeholder answers extracted from context.
      const input = (tool.state as any)?.input;
      const questionsList: { question: string }[] = Array.isArray(input?.questions)
        ? input.questions
        : [];
      if (questionsList.length > 0) {
        const placeholderAnswers = questionsList.map(() => ['Answered']);
        const syntheticPart = {
          ...tool,
          state: {
            ...(tool.state as any),
            status: 'completed',
            metadata: {
              ...((tool.state as any)?.metadata ?? {}),
              answers: placeholderAnswers,
            },
          },
        } as unknown as ToolPart;
        result.push({ part: syntheticPart, messageId: msgId });
      }
    }
  }

  const value: AnsweredQuestions = {
    parts: result,
    ids: new Set(result.map(({ part }) => part.id)),
    byId: new Map(result.map(({ part }) => [part.id, part])),
  };
  answeredByTurn.set(turn, { questions, sessionId, value });
  return value;
}

/**
 * The session-wide set of answered question part ids — what
 * `webIsRenderablePart` consults so an unanswered question never gets a row.
 * One pass over the turns; each turn's answer set is cached on the turn.
 */
export function deriveAnsweredQuestionIds(
  turns: readonly Turn[],
  questions: QuestionRequest[],
  sessionId: string,
): ReadonlySet<string> {
  const ids = new Set<string>();
  for (const turn of turns) {
    for (const id of deriveAnsweredQuestions(turn, questions, sessionId).ids) ids.add(id);
  }
  return ids;
}

// ============================================================================
// Layer 3 — the view (turn + context)
// ============================================================================

export interface CommandInfo {
  name: string;
  args?: string;
  split?: { before: string; after: string };
}

export interface TurnViewContext {
  sessionId: string;
  questions: QuestionRequest[];
  /** `isWorkingTurn && sessionWorking` — resolved by the list per turn. */
  working: boolean;
  commandMessages: ReadonlyMap<string, CommandInfo> | undefined;
  commands: Command[] | undefined;
  pricingLookup: ModelPricingLookup;
}

export type InlineContentItem =
  { type: 'text'; part: TextPart; id: string } | { type: 'question'; part: ToolPart; id: string };

export interface TurnView extends TurnFacts {
  working: boolean;
  answeredQuestionParts: AnsweredQuestions['parts'];
  answeredQuestionPartsById: AnsweredQuestions['byId'];
  inlineContentParts: InlineContentItem[] | null;
  shouldUseInlineContent: boolean;
  response: string;
  /** `isCompaction && !working && response` — the card replaces the turn. */
  isCompactionCard: boolean;
  /** `(working || hasSteps || hasReasoning) && assistantMessages.length > 0`. */
  showStepsBlock: boolean;
  costInfo: TurnCostInfo | undefined;
  commandForTurn: CommandInfo | undefined;
}

const viewByTurn = new WeakMap<Turn, { ctx: TurnViewContext; view: TurnView }>();

function sameContext(a: TurnViewContext, b: TurnViewContext): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.questions === b.questions &&
    a.working === b.working &&
    a.commandMessages === b.commandMessages &&
    a.commands === b.commands &&
    a.pricingLookup === b.pricingLookup
  );
}

function sameCost(a: TurnCostInfo | undefined, b: TurnCostInfo | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.cost === b.cost &&
    a.tokens.input === b.tokens.input &&
    a.tokens.output === b.tokens.output &&
    a.tokens.reasoning === b.tokens.reasoning &&
    a.tokens.cacheRead === b.tokens.cacheRead &&
    a.tokens.cacheWrite === b.tokens.cacheWrite
  );
}

export function deriveTurnView(turn: Turn, ctx: TurnViewContext): TurnView {
  const cached = viewByTurn.get(turn);
  if (cached && sameContext(cached.ctx, ctx)) return cached.view;

  const facts = deriveTurnFacts(turn);
  const { working } = ctx;
  const answered = deriveAnsweredQuestions(turn, ctx.questions, ctx.sessionId);

  // Inline content parts — interleaves text and answered question parts in natural order.
  // When a turn contains answered questions, we need to render text and questions
  // in their original order rather than extracting the last text as a separate "response".
  // This works both during streaming and after completion so that answered questions
  // stay in the correct position while the AI continues responding.
  // Important: for question parts we use the (possibly synthetic) part from
  // answeredQuestionParts — NOT the raw store part — so that optimistic
  // answers from the cache are included even if the server hasn't confirmed yet.
  let inlineContentParts: InlineContentItem[] | null = null;
  if (answered.parts.length > 0) {
    const items: InlineContentItem[] = [];
    for (const { part } of facts.allParts) {
      if (isTextPart(part) && part.text?.trim()) {
        items.push({ type: 'text', part, id: part.id });
      } else if (isToolPart(part) && part.tool === 'question' && answered.byId.has(part.id)) {
        // Use the answered part (may be synthetic with cached answers)
        items.push({ type: 'question', part: answered.byId.get(part.id)!, id: part.id });
      }
    }
    // Only use inline rendering if there are both text and question items
    const hasText = items.some((i) => i.type === 'text');
    const hasQuestion = items.some((i) => i.type === 'question');
    inlineContentParts = hasText && hasQuestion ? items : null;
  }
  const shouldUseInlineContent = !facts.hasSteps && !!inlineContentParts;

  const response = working
    ? facts.streamingResponseRaw || facts.responseRaw
    : !facts.hasSteps && facts.completedTextParts.length > 0
      ? facts.completedTextParts.join('\n\n')
      : facts.responseRaw.trim() || facts.abortedTextFallback;

  // Cost info (only when not working). Identity-stable by VALUE: the pricing
  // lookup is replaced once when the price table loads, which re-derives every
  // settled turn's cost to the same numbers — handing back the previous object
  // keeps every `TurnTailRow` from re-rendering for nothing.
  const nextCost = !working ? getTurnCost(facts.allParts, ctx.pricingLookup) : undefined;
  const prevCost = cached?.view.costInfo;
  const costInfo = sameCost(prevCost, nextCost) ? prevCost : nextCost;

  const mapped = ctx.commandMessages?.get(turn.userMessage.info.id);
  const commandForTurn =
    mapped ??
    (facts.userMessageText
      ? detectCommandFromText(facts.userMessageText, ctx.commands)
      : undefined);

  const view: TurnView = {
    ...facts,
    working,
    answeredQuestionParts: answered.parts,
    answeredQuestionPartsById: answered.byId,
    inlineContentParts,
    shouldUseInlineContent,
    response,
    isCompactionCard: facts.hasCompaction && !working && !!response,
    showStepsBlock:
      (working || facts.hasSteps || facts.hasReasoning) && turn.assistantMessages.length > 0,
    costInfo,
    commandForTurn,
  };
  viewByTurn.set(turn, { ctx, view });
  return view;
}

// ============================================================================
// Projection — rows → placements
// ============================================================================

/** What an `AssistantPartRow` renders. See the module doc for the sections. */
export type AssistantPartRole =
  /** Shell mode: the single bash part, `defaultOpen`, with the turn's permission. */
  | 'shell-only'
  /** A context group → `ActivityBurst`. (steps section) */
  | 'burst'
  /** A standalone tool → `ToolPartRenderer`. (steps section) */
  | 'standalone'
  /** Prose between bursts in steps mode → `ThrottledMarkdown`. (steps section) */
  | 'text-step'
  /** The turn's single response block, on the LAST text row. (body) */
  | 'response'
  /** One text item of the inline list. (body) */
  | 'inline-text'
  /** The answered questions of one context row, as cards. (body) */
  | 'inline-questions';

export interface AssistantPartRowProps {
  /** Unique per placement: the row key, `:body` suffixed for a body placement. */
  key: string;
  role: AssistantPartRole;
  /** The resolved part OBJECTS this placement renders, in order. */
  parts: Part[];
  sessionId: string;
  working: boolean;
  /** Bursts only: the last segment of the turn stays open across SSE gaps. */
  isTrailing: boolean;
  disableNavigation: boolean;
  density: ConversationDensity;
  /** `standalone` / `shell-only`: the pending permission for this call. */
  permission: PermissionRequest | undefined;
  onPermissionReply: (requestId: string, reply: 'once' | 'always' | 'reject') => Promise<void>;
  /** `response`: the turn's command, for the pill + expandable output. */
  commandForTurn: CommandInfo | undefined;
  /** `response` / `text-step` / `inline-text`: the string to render. */
  text: string;
  /** `response` / `text-step` / `inline-text`: streaming markdown mode. */
  isStreaming: boolean;
}

export interface TurnPlacements {
  /** Shell mode: the one placement; steps and body are empty. */
  shell: AssistantPartRowProps | null;
  steps: AssistantPartRowProps[];
  body: AssistantPartRowProps[];
}

export interface ProjectionOptions {
  sessionId: string;
  disableNavigation: boolean;
  density: ConversationDensity;
  permissions: PermissionRequest[];
  onPermissionReply: AssistantPartRowProps['onPermissionReply'];
}

export interface ProjectionCache {
  props: Map<string, AssistantPartRowProps>;
  /** Per message object: its parts by id. A message keeps its identity while
   *  unchanged, so only the changed bucket is re-indexed. */
  partsByMessage: WeakMap<MessageWithParts, Map<string, Part>>;
}

export function createProjectionCache(): ProjectionCache {
  return { props: new Map(), partsByMessage: new WeakMap() };
}

function indexParts(message: MessageWithParts, cache: ProjectionCache): Map<string, Part> {
  let index = cache.partsByMessage.get(message);
  if (!index) {
    index = new Map(message.parts.map((p) => [p.id, p]));
    cache.partsByMessage.set(message, index);
  }
  return index;
}

/** Resolve a row's refs to the live part objects of `turn`. */
function resolveParts(
  refs: readonly TimelinePartRef[],
  turn: Turn,
  cache: ProjectionCache,
  substitute: ReadonlyMap<string, ToolPart>,
): Part[] {
  const out: Part[] = [];
  for (const ref of refs) {
    let found: Part | undefined;
    for (const message of turn.assistantMessages) {
      if (message.info.id !== ref.messageID) continue;
      found = indexParts(message, cache).get(ref.partID);
      break;
    }
    if (!found && turn.userMessage.info.id === ref.messageID) {
      found = indexParts(turn.userMessage, cache).get(ref.partID);
    }
    if (!found) continue;
    // A kept question rides as the ANSWERED part — possibly synthetic with
    // optimistically-cached or output-parsed answers the raw store part does
    // not carry yet. Without this substitution the burst row would show
    // "0 answered" until the server confirms.
    out.push(substitute.get(found.id) ?? found);
  }
  return out;
}

const isQuestionPart = (part: Part): boolean => isToolPart(part) && part.tool === 'question';

/**
 * Hand back the previous props object when every input is unchanged, so the
 * memo'd row bails. `parts` compares element-wise (`samePartsList`), the rest
 * by identity.
 */
function stableProps(cache: ProjectionCache, next: AssistantPartRowProps): AssistantPartRowProps {
  const prev = cache.props.get(next.key);
  if (
    prev &&
    prev.role === next.role &&
    prev.sessionId === next.sessionId &&
    prev.working === next.working &&
    prev.isTrailing === next.isTrailing &&
    prev.disableNavigation === next.disableNavigation &&
    prev.density === next.density &&
    prev.permission === next.permission &&
    prev.onPermissionReply === next.onPermissionReply &&
    prev.commandForTurn === next.commandForTurn &&
    prev.text === next.text &&
    prev.isStreaming === next.isStreaming &&
    samePartsList(prev.parts, next.parts)
  ) {
    return prev;
  }
  cache.props.set(next.key, next);
  return next;
}

/**
 * Project one turn's rows onto its placements. See the module doc.
 *
 * Mirrors the legacy render, branch for branch:
 *   - shell mode short-circuits to one placement;
 *   - the compaction card short-circuits to none;
 *   - steps section: bursts, standalone tools, and prose when `hasSteps`;
 *   - body: inline items when `shouldUseInlineContent`, else the response
 *     block on the last text row (when `!hasSteps` and `response` is set).
 *
 * `isTrailing` counts SEGMENTS — every row that is a segment of the legacy
 * `segmentTurn` pass, including prose rows that render null in response
 * mode and excluding a context row left with no non-question part in inline
 * mode — exactly `index === segments.length - 1`.
 */
export function projectTurnPlacements(
  group: TurnRowGroup,
  turn: Turn,
  view: TurnView,
  opts: ProjectionOptions,
  cache: ProjectionCache,
): TurnPlacements {
  const base = {
    sessionId: opts.sessionId,
    working: view.working,
    disableNavigation: opts.disableNavigation,
    density: opts.density,
    onPermissionReply: opts.onPermissionReply,
    commandForTurn: undefined as CommandInfo | undefined,
    permission: undefined as PermissionRequest | undefined,
    text: '',
    isStreaming: false,
    isTrailing: false,
  };

  const partRows = group.rows.filter(
    (r): r is TimelineAssistantPartRow => r.kind === 'assistant-part',
  );

  // ---- Shell mode — short-circuit ----
  if (view.shellModePart) {
    const shellPart = view.shellModePart;
    const host = partRows.find((r) =>
      r.group.type === 'part'
        ? r.group.ref.partID === shellPart.id
        : r.group.refs.some((ref) => ref.partID === shellPart.id),
    );
    // Permission matching for this session (used for tool-level permission overlays)
    const nextPermission = opts.permissions.filter((p) => p.sessionID === opts.sessionId)[0];
    const shell = stableProps(cache, {
      ...base,
      key: host?.key ?? `shell:${turn.userMessage.info.id}`,
      role: 'shell-only',
      parts: [shellPart],
      permission: nextPermission?.tool ? nextPermission : undefined,
    });
    return { shell, steps: [], body: [] };
  }

  // ---- Compaction card — the card replaces every part ----
  if (view.isCompactionCard) {
    return { shell: null, steps: [], body: [] };
  }

  // ---- Resolve every row once ----
  const resolved = partRows.map((row) => {
    const refs = row.group.type === 'part' ? [row.group.ref] : row.group.refs;
    const parts = resolveParts(refs, turn, cache, view.answeredQuestionPartsById);
    return { row, parts };
  });

  // The legacy segment list: text → text, standalone part → standalone,
  // context → burst of its non-question parts in inline mode (dropped when
  // empty) / all parts otherwise.
  type Segment =
    | { kind: 'text'; row: TimelineAssistantPartRow; part: TextPart }
    | { kind: 'standalone'; row: TimelineAssistantPartRow; part: ToolPart }
    | { kind: 'burst'; row: TimelineAssistantPartRow; parts: Part[] };
  const segments: Segment[] = [];
  /** Context rows' answered questions, for the inline body (row key → parts). */
  const inlineQuestionsByRow = new Map<string, Part[]>();
  for (const { row, parts } of resolved) {
    if (parts.length === 0) continue;
    if (row.group.type === 'part') {
      const part = parts[0];
      if (isTextPart(part)) segments.push({ kind: 'text', row, part });
      else if (isToolPart(part)) segments.push({ kind: 'standalone', row, part });
      continue;
    }
    if (view.shouldUseInlineContent) {
      const burstParts = parts.filter((p) => !isQuestionPart(p));
      const questionParts = parts.filter(isQuestionPart);
      if (questionParts.length > 0) inlineQuestionsByRow.set(row.key, questionParts);
      if (burstParts.length > 0) segments.push({ kind: 'burst', row, parts: burstParts });
      continue;
    }
    segments.push({ kind: 'burst', row, parts });
  }

  // ---- Steps section ----
  const steps: AssistantPartRowProps[] = [];
  if (view.showStepsBlock) {
    segments.forEach((segment, index) => {
      const isLast = index === segments.length - 1;
      if (segment.kind === 'burst') {
        steps.push(
          stableProps(cache, {
            ...base,
            key: segment.row.key,
            role: 'burst',
            parts: segment.parts,
            isTrailing: isLast,
          }),
        );
        return;
      }
      if (segment.kind === 'standalone') {
        steps.push(
          stableProps(cache, {
            ...base,
            key: segment.row.key,
            role: 'standalone',
            parts: [segment.part],
            permission: getPermissionForTool(opts.permissions, segment.part.callID),
          }),
        );
        return;
      }
      // Text segments render as prose between bursts. Text rendering
      // for no-step turns is handled below in the dedicated response
      // section, to avoid duplicate output.
      if (!view.hasSteps) return;
      const text = segment.part.text?.trim();
      if (!text) return;
      steps.push(
        stableProps(cache, {
          ...base,
          key: segment.row.key,
          role: 'text-step',
          parts: [segment.part],
          text,
          isStreaming: view.working,
        }),
      );
    });
  }

  // ---- Body ----
  const body: AssistantPartRowProps[] = [];
  if (view.shouldUseInlineContent) {
    // Find the last text item — it might still be streaming.
    let lastTextRowKey: string | null = null;
    if (view.working) {
      for (let i = resolved.length - 1; i >= 0; i--) {
        const { row, parts } = resolved[i];
        if (row.group.type === 'part' && parts[0] && isTextPart(parts[0])) {
          lastTextRowKey = row.key;
          break;
        }
      }
    }
    for (const { row, parts } of resolved) {
      if (parts.length === 0) continue;
      if (row.group.type === 'part') {
        const part = parts[0];
        if (!isTextPart(part)) continue;
        const isStreaming = row.key === lastTextRowKey;
        const text = isStreaming ? part.text! : part.text!.trim();
        body.push(
          stableProps(cache, {
            ...base,
            key: `${row.key}:body`,
            role: 'inline-text',
            parts: [part],
            text,
            isStreaming,
          }),
        );
        continue;
      }
      const questionParts = inlineQuestionsByRow.get(row.key);
      if (!questionParts) continue;
      body.push(
        stableProps(cache, {
          ...base,
          key: `${row.key}:body`,
          role: 'inline-questions',
          parts: questionParts,
        }),
      );
    }
  } else if (!view.hasSteps && view.response) {
    // The single response block — on the LAST text row of the turn. (A
    // whitespace-only streaming text part has no row; the block waits for
    // its first non-blank character.)
    for (let i = resolved.length - 1; i >= 0; i--) {
      const { row, parts } = resolved[i];
      if (row.group.type !== 'part' || !parts[0] || !isTextPart(parts[0])) continue;
      body.push(
        stableProps(cache, {
          ...base,
          key: `${row.key}:body`,
          role: 'response',
          parts: [parts[0]],
          text: view.response,
          isStreaming: view.working,
          commandForTurn: view.commandForTurn,
        }),
      );
      break;
    }
  }

  return { shell: null, steps, body };
}
