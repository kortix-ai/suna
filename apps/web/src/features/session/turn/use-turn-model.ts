'use client';

/**
 * The turn's view model — every derived value a turn's rows read, computed once
 * per turn in one place.
 *
 * Extracted verbatim from `SessionTurnImpl`'s body (session-chat.tsx) so the
 * turn can be split into independently-rendered rows (head / segments / tail)
 * without each row re-deriving the same state. Nothing here is new logic: the
 * hooks, their order, their dependency arrays and their bodies are the ones that
 * used to sit inline in the component.
 *
 * Three values are additions, and only because the row split needs them as data
 * rather than as inline JSX expressions:
 *   - `segments` — the `segmentTurn(...)` call that used to run inline in the
 *     render, filters and options unchanged.
 *   - `showSegments` — the gate that used to wrap that call.
 *   - `singleRowKind` — which of the two short-circuit renders (shell mode /
 *     compaction card) applies, in place of the two early returns.
 *
 * ## Why half of this file is plain functions
 *
 * Row-granularity virtualization has to build the FLAT row list across every
 * turn before it renders any of them, so it needs each turn's `segments`,
 * `singleRowKind` and the three values a segment reads — in a plain loop, where
 * `useTurnModel` cannot be called (rules of hooks).
 *
 * So the derivation is split in two, by dependency set rather than by taste:
 *
 *   - `computeTurnParts` — everything derived from the turn's PARTS alone
 *     (`turn`, `questions`, `permissions`, `sessionId`).
 *   - `computeTurnRowInputs` — that, plus the four values that also need the
 *     session's live status (`sessionStatus`, `isLastUserTurn`, `isBusy`,
 *     `isCompaction`): `working`, `response`, `showSegments`, `singleRowKind`.
 *
 * `useTurnModel` calls both, one `useMemo` each, with exactly the dependency
 * sets the individual memos had. That split is not cosmetic: `segments` lives
 * in the parts stage, so it keeps its identity across a status tick the way it
 * did when it was its own memo — which is what the virtualizer's row model
 * keys off. Every value has exactly ONE definition; the hook reads them, it
 * does not recompute them.
 */

import { detectCommandFromText } from '@/features/session/detect-command';
import { useModelPricingLookup } from '@/lib/model-pricing';
import {
  type KortixSystemMessage,
  type SessionReport,
  extractKortixSystemMessages,
  extractSessionReport,
  stripKortixSystemTags,
} from '@/lib/utils/kortix-system-tags';
import {
  type MessageWithParts,
  type Part,
  type PermissionRequest,
  type RetryInfo,
  type TextPart,
  type ToolPart,
  type TurnCostInfo,
  collectTurnParts,
  findLastTextPart,
  formatDuration,
  getRetryInfo,
  getRetryMessage,
  getShellModePart,
  getTurnCost,
  getTurnError,
  getTurnErrorDetails,
  getTurnStatus,
  getWorkingState,
  isAgentPart,
  isAttachment,
  isReasoningPart,
  isTextPart,
  isToolPart,
  shouldShowToolPart,
} from '@/ui';
import { useTranslations } from 'next-intl';
import { type Dispatch, type SetStateAction, useEffect, useMemo, useRef, useState } from 'react';
import { stripSystemPtyText } from '../message-parsing';
import type { SessionTurnProps } from '../session-chat';
import {
  sessionTurnDurationMs,
  sessionTurnEndedAt,
  sessionTurnSpan,
} from '../session-turn-meta-rows';
import { type Segment, segmentTurn } from './segment-turn';

// ============================================================================
// Optimistic answers cache
// ============================================================================
// When a user answers a question, we save the answers here immediately.
// This survives SSE `message.part.updated` events that may overwrite the
// tool part's state before the server has merged the answers.  The cache
// is keyed by the question tool part's `id` (stable across updates).
// Entries are cleaned up once the server's authoritative part arrives with
// real `metadata.answers`.

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

function parseAnswersFromOutput(
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

/** One entry of the interleaved text / answered-question stream. */
export type InlineContentItem =
  { type: 'text'; part: TextPart; id: string } | { type: 'question'; part: ToolPart; id: string };

// ============================================================================
// Pure computation — no hooks, safe to run in a loop
// ============================================================================

/** `collectTurnParts(turn)` — one assistant part paired with its message. */
export type TurnPartWithMessage = { part: Part; message: MessageWithParts };

/** The props `computeTurnParts` reads. `SessionTurnProps` satisfies it. */
export type TurnPartsProps = Pick<
  SessionTurnProps,
  'turn' | 'sessionId' | 'permissions' | 'questions'
>;

/**
 * The props `computeTurnRowInputs` reads. `SessionTurnProps` satisfies it.
 *
 * Narrower than `SessionTurnProps` on purpose: it is the exact dependency set
 * of the row model, so a prop added to the turn cannot silently join it.
 */
export type TurnRowInputProps = TurnPartsProps &
  Pick<SessionTurnProps, 'isLastUserTurn' | 'sessionStatus' | 'isBusy' | 'isCompaction'>;

/** Everything a turn derives from its PARTS alone — no session status. */
export interface TurnPartsComputation {
  allParts: TurnPartWithMessage[];
  hasSteps: boolean;
  hasReasoning: boolean;
  /** Concatenated text of the still-streaming assistant message. */
  streamingResponseRaw: string;
  /** The last non-empty text part's raw text. */
  responseRaw: string;
  /** All non-empty text, joined — only when the turn errored and lost its last part. */
  abortedTextFallback: string;
  /** Every non-empty text part's trimmed text, in order. */
  completedTextParts: string[];
  shellModePart: (Part & { type: 'tool' }) | undefined;
  answeredQuestionParts: { part: ToolPart; messageId: string }[];
  answeredQuestionPartsById: Map<string, ToolPart>;
  inlineContentParts: InlineContentItem[] | null;
  shouldUseInlineContent: boolean;
  standaloneCallIds: Set<string>;
  /** `segmentTurn(...)` over the turn's filtered parts. */
  segments: Segment[];
}

/** What a row-granularity transcript needs, per turn, before it renders any. */
export interface TurnRowInputs {
  segments: Segment[];
  /** The gate currently stored as `showSegments`. */
  showSegments: boolean;
  singleRowKind: 'shell' | 'compaction' | null;
  /** The three fields TurnSegment reads. */
  working: boolean;
  hasSteps: boolean;
  answeredQuestionPartsById: Map<string, ToolPart>;
}

/**
 * `TurnRowInputs` plus every intermediate the hook also needs, so nothing is
 * computed twice. `computeTurnRowInputs` returns this; the six-field
 * `TurnRowInputs` view is what a caller building the row model reads.
 */
export interface TurnRowComputation extends TurnPartsComputation, TurnRowInputs {
  working: boolean;
  response: string;
  showSegments: boolean;
  singleRowKind: 'shell' | 'compaction' | null;
}

/**
 * Answered question parts — shown inline alongside streamed text.
 *
 * Uses the optimisticAnswersCache as a fallback: when the user answers a
 * question we cache {answers, input} immediately. SSE message.part.updated
 * events can overwrite the tool part's state (wiping metadata.answers)
 * before the server has merged them. By checking the cache we guarantee
 * the answered card stays visible regardless of SSE timing.
 * Only skip tool parts whose callID matches a currently-pending question.
 *
 * NOT pure in one respect, and deliberately so: it DELETES a cache entry once
 * the server's authoritative answers arrive. The delete is idempotent — a
 * second call over the same data produces the same result — which is what lets
 * this run both in the transcript's row-model loop and in `useTurnModel`.
 */
function collectAnsweredQuestionParts(
  props: TurnPartsProps,
): { part: ToolPart; messageId: string }[] {
  const { turn, sessionId, questions } = props;

  const pendingCallIds = new Set(
    questions
      .filter((q) => q.sessionID === sessionId)
      .map((q) => q.tool?.callID)
      .filter(Boolean),
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
    const cached = optimisticAnswersCache.get(tool.id);
    const toolOutput = (tool.state as any)?.output as string | undefined;

    if (serverAnswers && serverAnswers.length > 0) {
      // Server has real answers — clean up cache if present
      if (cached) optimisticAnswersCache.delete(tool.id);
      result.push({ part: tool, messageId: msgId });
    } else if (cached) {
      // Server hasn't confirmed yet — use cached answers.
      // Build a synthetic tool part with the cached data so
      // AnsweredQuestionCard can render.
      const syntheticPart = {
        ...tool,
        state: {
          ...(tool.state as any),
          status: 'completed',
          input: cached.input,
          metadata: {
            ...((tool.state as any)?.metadata ?? {}),
            answers: cached.answers,
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
  return result;
}

/**
 * Everything a turn derives from its parts, session id, permissions and
 * questions — the half of the model that a live status tick cannot change.
 */
export function computeTurnParts(props: TurnPartsProps): TurnPartsComputation {
  const { turn, sessionId, permissions } = props;

  const allParts = collectTurnParts(turn);

  // Check if there are visible steps that actually render inside the
  // collapsible steps section. Tool parts that are rendered elsewhere
  // (todowrite, task, question) don't count as "steps".
  const hasSteps = allParts.some(({ part }) => {
    if (part.type === 'compaction' || part.type === 'snapshot' || part.type === 'patch')
      return true;
    if (isToolPart(part)) {
      if (part.tool === 'todowrite' || part.tool === 'task' || part.tool === 'question')
        return false;
      return shouldShowToolPart(part);
    }
    return false;
  });

  const hasReasoning = allParts.some(({ part }) => isReasoningPart(part) && !!part.text?.trim());

  const activeAssistantMessage = (() => {
    if (turn.assistantMessages.length === 0) return undefined;
    for (let i = turn.assistantMessages.length - 1; i >= 0; i--) {
      const msg = turn.assistantMessages[i];
      if (!(msg.info as any)?.time?.completed) return msg;
    }
    return turn.assistantMessages[turn.assistantMessages.length - 1];
  })();

  const streamingResponseRaw = !activeAssistantMessage
    ? ''
    : activeAssistantMessage.parts
        .filter(isTextPart)
        .map((p) => p.text ?? '')
        .join('');

  const lastTextPart = findLastTextPart(allParts);
  const responseRaw = lastTextPart?.text ?? '';

  // Fallback: when aborted, collect ALL non-empty text parts if the
  // primary response is empty.  The last text part may have been lost
  // (timing between text-start and first text-delta) but earlier parts
  // might still have content.
  const abortedTextFallback = (() => {
    if (responseRaw) return ''; // primary response exists — no fallback needed
    // Only activate for aborted/errored turns
    const hasError = turn.assistantMessages.some((m) => (m.info as any).error);
    if (!hasError) return '';
    const texts: string[] = [];
    for (const { part } of allParts) {
      if (isTextPart(part) && part.text?.trim()) {
        texts.push(part.text);
      }
    }
    return texts.join('\n\n').trim();
  })();

  const completedTextParts = allParts
    .map(({ part }) => (isTextPart(part) ? part.text?.trim() : ''))
    .filter((text): text is string => Boolean(text));

  // Shell mode detection
  const shellModePart = getShellModePart(turn);

  const answeredQuestionParts = collectAnsweredQuestionParts(props);

  // Inline content parts — interleaves text and answered question parts in natural order.
  // When a turn contains answered questions, we need to render text and questions
  // in their original order rather than extracting the last text as a separate "response".
  // This works both during streaming and after completion so that answered questions
  // stay in the correct position while the AI continues responding.
  // Important: for question parts we use the (possibly synthetic) part from
  // answeredQuestionParts — NOT the raw store part — so that optimistic
  // answers from the cache are included even if the server hasn't confirmed yet.
  const answeredQuestionPartsById = new Map(
    answeredQuestionParts.map(({ part }) => [part.id, part]),
  );

  const inlineContentParts = (() => {
    if (answeredQuestionParts.length === 0) return null;
    const items: InlineContentItem[] = [];
    for (const { part } of allParts) {
      if (isTextPart(part) && part.text?.trim()) {
        items.push({ type: 'text', part, id: part.id });
      } else if (
        isToolPart(part) &&
        part.tool === 'question' &&
        answeredQuestionPartsById.has(part.id)
      ) {
        // Use the answered part (may be synthetic with cached answers)
        items.push({
          type: 'question',
          part: answeredQuestionPartsById.get(part.id)!,
          id: part.id,
        });
      }
    }
    // Only use inline rendering if there are both text and question items
    const hasText = items.some((i) => i.type === 'text');
    const hasQuestion = items.some((i) => i.type === 'question');
    if (!hasText || !hasQuestion) return null;
    return items;
  })();

  const shouldUseInlineContent = !hasSteps && !!inlineContentParts;

  // Parts with a pending permission need a visible, actionable surface — they
  // must never fold into a collapsed burst. Answered questions get the same
  // standalone treatment for a different reason: they record a decision the
  // USER made, not agent activity, so the "collapse the agent's work into one
  // row" goal doesn't apply to them (they render via AnsweredQuestionCard, not
  // ToolPartRenderer — see the standalone branch below). Pending/dismissed
  // questions are deliberately NOT standalone: the real, actionable prompt for
  // a pending question lives in the composer (SessionChatInput's questionSlot),
  // which has the answer-reply plumbing this component doesn't; surfacing an
  // inert, answer-less card here would only be a confusing duplicate. Those
  // are filtered out of the turn body entirely below, matching the old
  // behaviour of rendering nothing for them in the steps list.
  const standaloneCallIds = (() => {
    const ids = new Set<string>();
    for (const permission of permissions) {
      if (permission.sessionID === sessionId && permission.tool?.callID) {
        ids.add(permission.tool.callID);
      }
    }
    for (const { part } of answeredQuestionParts) {
      ids.add(part.callID);
    }
    return ids;
  })();

  // ── Assistant parts content ──
  // Segments the turn into bursts (collapsed activity), standalone
  // parts (deliverables, sub-agents, and any part with a pending
  // permission or an active question), and text (prose between
  // bursts). Replaces the old same-tool / reasoning grouping — see
  // features/session/turn/segment-turn.ts.
  // Two part kinds are filtered out before segmentation:
  //   - `todowrite` — the plan card beneath the user message is now
  //     the single canonical todo surface; showing the same checklist
  //     again inside a burst would just duplicate it.
  //   - `question`: only answered questions are kept. Pending and
  //     dismissed questions are dropped entirely. Additionally,
  //     answered questions are dropped when rendering inline content
  //     (below), since that mode shows them already, in natural order.
  const segments = segmentTurn(
    allParts
      .map(({ part }) => part)
      .filter((part) => {
        if (isToolPart(part) && part.tool === 'todowrite') return false;
        if (isToolPart(part) && part.tool === 'question') {
          // Keep only answered questions, and only if not rendering inline
          return answeredQuestionPartsById.has(part.id) && !shouldUseInlineContent;
        }
        return true;
      }),
    { standaloneCallIds },
  );

  return {
    allParts,
    hasSteps,
    hasReasoning,
    streamingResponseRaw,
    responseRaw,
    abortedTextFallback,
    completedTextParts,
    shellModePart,
    answeredQuestionParts,
    answeredQuestionPartsById,
    inlineContentParts,
    shouldUseInlineContent,
    standaloneCallIds,
    segments,
  };
}

/**
 * The full per-turn derivation, hook-free — what a row-granularity transcript
 * runs in a plain loop before it renders anything.
 *
 * Pass `parts` when the caller already has `computeTurnParts(props)` for this
 * turn (that is what `useTurnModel` does, to keep `segments` stable across a
 * status tick). Otherwise it is computed here.
 */
export function computeTurnRowInputs(
  props: TurnRowInputProps,
  parts: TurnPartsComputation = computeTurnParts(props),
): TurnRowComputation {
  const { turn, sessionStatus, isLastUserTurn, isBusy, isCompaction } = props;
  const { hasSteps, hasReasoning, shellModePart } = parts;

  // `isLastUserTurn` and `isPlanAnchor` arrive as props: both used to be derived
  // here from the whole message array — see SessionChat's hoisted memos.
  // A turn is "working" when:
  // 1. The session status says busy/retry (via getWorkingState), OR
  // 2. This is the last turn AND the parent component says isBusy (e.g. we
  //    just sent a message but sessionStatus hasn't updated to busy yet).
  //    This covers the race between sending and the server acknowledging.
  const working = getWorkingState(sessionStatus, isLastUserTurn) || (isLastUserTurn && isBusy);

  const response = working
    ? parts.streamingResponseRaw || parts.responseRaw
    : !hasSteps && parts.completedTextParts.length > 0
      ? parts.completedTextParts.join('\n\n')
      : parts.responseRaw.trim() || parts.abortedTextFallback;

  const showSegments = (working || hasSteps || hasReasoning) && turn.assistantMessages.length > 0;

  // Shell mode and the compaction card each short-circuit the turn to a single
  // row. Shell wins, matching the order the two early returns used to run in.
  const singleRowKind: 'shell' | 'compaction' | null = shellModePart
    ? 'shell'
    : isCompaction && !working && response
      ? 'compaction'
      : null;

  return { ...parts, working, response, showSegments, singleRowKind };
}

/** Everything a turn's rows render from. */
export interface TurnModel {
  /** `useTranslations('hardcodedUi')` — used for the retry label. */
  tHardcodedUi: ReturnType<typeof useTranslations<'hardcodedUi'>>;
  copied: boolean;
  handleCopy: () => Promise<void>;
  connectProviderOpen: boolean;
  setConnectProviderOpen: Dispatch<SetStateAction<boolean>>;
  hasSteps: boolean;
  hasReasoning: boolean;
  working: boolean;
  response: string;
  retryInfo: RetryInfo | undefined;
  retryMessage: string | undefined;
  retrySecondsLeft: number;
  costInfo: TurnCostInfo | undefined;
  turnError: string | undefined;
  turnErrorDetails: ReturnType<typeof getTurnErrorDetails>;
  shellModePart: (Part & { type: 'tool' }) | undefined;
  nextPermission: PermissionRequest | undefined;
  answeredQuestionParts: { part: ToolPart; messageId: string }[];
  answeredQuestionPartsById: Map<string, ToolPart>;
  inlineContentParts: InlineContentItem[] | null;
  shouldUseInlineContent: boolean;
  sessionReport: SessionReport | null;
  sessionReportModalOpen: boolean;
  setSessionReportModalOpen: Dispatch<SetStateAction<boolean>>;
  systemMessages: KortixSystemMessage[];
  hasVisibleUserContent: boolean;
  commandForTurn: { name: string; args?: string } | undefined;
  throttledStatus: string;
  turnEndedAt: number | null;
  turnDurationMs: number | null;
  standaloneCallIds: Set<string>;
  /** `segmentTurn(...)` over the turn's filtered parts. */
  segments: Segment[];
  /** Gate for the segment region. */
  showSegments: boolean;
  /** Which short-circuit render applies, if any. */
  singleRowKind: 'shell' | 'compaction' | null;
}

export function useTurnModel(props: SessionTurnProps): TurnModel {
  const {
    turn,
    isLastUserTurn,
    sessionId,
    sessionStatus,
    permissions,
    questions,
    isBusy,
    isCompaction,
    providers,
    commandMessages,
    commands,
  } = props;

  const tHardcodedUi = useTranslations('hardcodedUi');
  const [copied, setCopied] = useState(false);
  const [connectProviderOpen, setConnectProviderOpen] = useState(false);
  const pricingLookup = useModelPricingLookup(providers);

  // ── The pure model, in the two stages `computeTurnRowInputs` is split into ──
  // Two memos rather than one, because their dependency sets genuinely differ.
  // Everything below `turnParts` survives a status tick — including `segments`,
  // whose identity the transcript's row model keys off. Folding it into the
  // wider memo would hand the virtualizer a new `Segment[]` for every turn on
  // every SSE status change.
  const turnParts = useMemo(
    () => computeTurnParts({ turn, sessionId, permissions, questions }),
    [turn, sessionId, permissions, questions],
  );
  const rowInputs = useMemo(
    () =>
      computeTurnRowInputs(
        {
          turn,
          sessionId,
          permissions,
          questions,
          sessionStatus,
          isLastUserTurn,
          isBusy,
          isCompaction,
        },
        turnParts,
      ),
    [
      turn,
      sessionId,
      permissions,
      questions,
      sessionStatus,
      isLastUserTurn,
      isBusy,
      isCompaction,
      turnParts,
    ],
  );

  const {
    allParts,
    hasSteps,
    hasReasoning,
    shellModePart,
    answeredQuestionParts,
    answeredQuestionPartsById,
    inlineContentParts,
    shouldUseInlineContent,
    standaloneCallIds,
    segments,
    working,
    response,
    showSegments,
    singleRowKind,
  } = rowInputs;

  // Retry info (only on last turn)
  const retryInfo = useMemo(
    () => (isLastUserTurn ? getRetryInfo(sessionStatus) : undefined),
    [sessionStatus, isLastUserTurn],
  );
  const retryMessage = useMemo(
    () => (isLastUserTurn ? getRetryMessage(sessionStatus) : undefined),
    [sessionStatus, isLastUserTurn],
  );

  // Cost info (only when not working)
  const costInfo = useMemo(
    () => (!working ? getTurnCost(allParts, pricingLookup) : undefined),
    [allParts, working, pricingLookup],
  );

  // Turn error — derived directly from message data (same approach as SolidJS reference).
  // Falls back to checking for dismissed question tool errors when no message-level error exists.
  const turnError = useMemo(() => {
    const msgError = getTurnError(turn);
    if (msgError) return msgError;
    // Check for dismissed question tool errors
    for (const msg of turn.assistantMessages) {
      for (const part of msg.parts) {
        if (part.type !== 'tool') continue;
        const tool = part as ToolPart;
        if (tool.tool === 'question' && tool.state.status === 'error' && 'error' in tool.state) {
          return (tool.state as { error: string }).error.replace(/^Error:\s*/, '');
        }
      }
    }
    return undefined;
  }, [turn]);

  // The gateway's structured fields (provider/suggestion/request_id) for
  // `turnError`, when recoverable — lets TurnErrorDisplay render WHICH
  // provider failed and WHAT to do about it instead of only the raw message.
  const turnErrorDetails = useMemo(() => getTurnErrorDetails(turn), [turn]);

  // Permission matching for this session (used for tool-level permission overlays)
  const nextPermission = useMemo(
    () => permissions.filter((p) => p.sessionID === sessionId)[0],
    [permissions, sessionId],
  );

  const answeredQuestionIds = useMemo(
    () => new Set(answeredQuestionParts.map(({ part }) => part.id)),
    [answeredQuestionParts],
  );

  // Whether the user message has any visible content (non-synthetic, non-ignored
  // text, or attachments). Background task notifications inject synthetic-only
  // user messages that should not render a user bubble.
  // Extract session report from user message (if present)
  const sessionReport = useMemo<SessionReport | null>(() => {
    for (const p of turn.userMessage.parts) {
      if (isTextPart(p)) {
        const report = extractSessionReport((p as TextPart).text || '');
        if (report) return report;
      }
    }
    return null;
  }, [turn.userMessage.parts]);
  const [sessionReportModalOpen, setSessionReportModalOpen] = useState(false);

  // Extract kortix_system messages for inline rendering (goal continuations, etc.)
  const systemMessages = useMemo<KortixSystemMessage[]>(() => {
    const msgs: KortixSystemMessage[] = [];
    for (const p of turn.userMessage.parts) {
      if (isTextPart(p) && (p as TextPart).text) {
        msgs.push(...extractKortixSystemMessages((p as TextPart).text!));
      }
    }
    return msgs;
  }, [turn.userMessage.parts]);

  const hasVisibleUserContent = useMemo(() => {
    // Session reports render as their own card — don't show as user bubble
    if (sessionReport) return false;
    const parts = turn.userMessage.parts;
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
  }, [turn.userMessage.parts, sessionReport]);

  // User message text — for copy action
  const userMessageText = useMemo(() => {
    const textParts = turn.userMessage.parts.filter(
      (p) => isTextPart(p) && !(p as TextPart).synthetic && !(p as any).ignored,
    ) as TextPart[];
    return textParts
      .map((p) => stripSystemPtyText(p.text))
      .filter((t) => t.trim())
      .join('\n')
      .trim();
  }, [turn.userMessage.parts]);

  const commandForTurn = useMemo(() => {
    const mapped = commandMessages?.get(turn.userMessage.info.id);
    if (mapped) return mapped;
    if (!userMessageText) return undefined;
    return detectCommandFromText(userMessageText, commands);
  }, [commandMessages, turn.userMessage.info.id, userMessageText, commands]);

  // ---- Status throttling (2.5s) ----
  const lastStatusChangeRef = useRef(Date.now());
  const statusTimeoutRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const childMessages = undefined as MessageWithParts[] | undefined; // placeholder for child session delegation
  const rawStatus = useMemo(
    () => getTurnStatus(allParts, childMessages),
    [allParts, childMessages],
  );
  const [throttledStatus, setThrottledStatus] = useState('');

  useEffect(() => {
    const newStatus = rawStatus;
    if (newStatus === throttledStatus || !newStatus) return;
    const elapsed = Date.now() - lastStatusChangeRef.current;
    if (elapsed >= 2500) {
      setThrottledStatus(newStatus);
      lastStatusChangeRef.current = Date.now();
    } else {
      clearTimeout(statusTimeoutRef.current);
      statusTimeoutRef.current = setTimeout(() => {
        setThrottledStatus(getTurnStatus(allParts, childMessages));
        lastStatusChangeRef.current = Date.now();
      }, 2500 - elapsed);
    }
    return () => clearTimeout(statusTimeoutRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allParts, rawStatus, throttledStatus]);

  // ---- Retry countdown ----
  const [retrySecondsLeft, setRetrySecondsLeft] = useState(0);
  useEffect(() => {
    if (!retryInfo) {
      setRetrySecondsLeft(0);
      return;
    }
    const update = () =>
      setRetrySecondsLeft(Math.max(0, Math.round((retryInfo.next - Date.now()) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [retryInfo]);

  // ---- Duration ticking ----
  // Only a LIVE turn needs a clock. The old effect also ran for settled turns,
  // where it called setDuration on mount and forced every completed turn in the
  // transcript through a second render for a number that never changes. The
  // early return below is what removes that pass. A settled turn's duration is
  // now SessionTurnMeta's job, from turnDurationMs.
  const turnEndedAt = useMemo(() => sessionTurnEndedAt(turn), [turn]);
  const turnDurationMs = useMemo(() => sessionTurnDurationMs(turn), [turn]);
  const [liveDuration, setLiveDuration] = useState('');
  useEffect(() => {
    if (!working) return;
    const { startedAt } = sessionTurnSpan(turn);
    if (startedAt == null) return;
    const update = () => setLiveDuration(formatDuration(Date.now() - startedAt));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [working, turn]);

  // ---- Copy response ----
  const handleCopy = async () => {
    // When inline content is active, copy all text parts (not just the last one)
    const textToCopy = inlineContentParts
      ? inlineContentParts
          .filter((item) => item.type === 'text')
          .map((item) => (item.part as TextPart).text?.trim())
          .filter(Boolean)
          .join('\n\n')
      : response;
    if (!textToCopy) return;
    await navigator.clipboard.writeText(textToCopy);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // `answeredQuestionIds` and `liveDuration` are computed but unread — they
  // came across from SessionTurnImpl unread and are kept rather than deleted,
  // so this extraction stays a pure move.
  void answeredQuestionIds;
  void liveDuration;

  return {
    tHardcodedUi,
    copied,
    handleCopy,
    connectProviderOpen,
    setConnectProviderOpen,
    hasSteps,
    hasReasoning,
    working,
    response,
    retryInfo,
    retryMessage,
    retrySecondsLeft,
    costInfo,
    turnError,
    turnErrorDetails,
    shellModePart,
    nextPermission,
    answeredQuestionParts,
    answeredQuestionPartsById,
    inlineContentParts,
    shouldUseInlineContent,
    sessionReport,
    sessionReportModalOpen,
    setSessionReportModalOpen,
    systemMessages,
    hasVisibleUserContent,
    commandForTurn,
    throttledStatus,
    turnEndedAt,
    turnDurationMs,
    standaloneCallIds,
    segments,
    showSegments,
    singleRowKind,
  };
}
