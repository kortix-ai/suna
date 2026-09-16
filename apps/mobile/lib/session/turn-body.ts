/**
 * Pure rules behind the assistant side of a turn — which parts render, in which
 * section, and when the busy indicator, error, and action bar show.
 *
 * Ported from apps/web `features/session/session-chat.tsx` `SessionTurnImpl`
 * (`hasSteps`, `hasReasoning`, `answeredQuestionParts`, `inlineContentParts`,
 * the `segments` input, `response`, `turnError`, the action bar gate, the
 * compaction branch), `SessionChat` (`suppressWorkingTurnBusy`,
 * `someTurnDrawsBusyRow`, `hasCompactionTurn`, `lastCompactionTurnIndex`,
 * `suppressedFailedCompaction`), `turn-busy-visibility.ts`, and
 * `use-oc-file-open.ts` `toDisplayPath`.
 *
 * No React, no React Native. `components/session/SessionTurn.tsx` composes it.
 */

import {
  compactionTurnInfo,
  findLastTextPart,
  getTurnError,
  isAbortError,
  isReasoningPart,
  isTextPart,
  isToolPart,
  shouldShowToolPart,
  unwrapError,
  type CompactionTurnInfo,
  type Part,
  type Segment,
  type TextPart,
  type ToolPart,
  type WorkingTurnResolution,
} from '@kortix/sdk';

/** The turn fields these rules read. Structural, so mobile and SDK turns both fit. */
export interface TurnBodyTurn {
  userMessage: { info: { id: string }; parts: ReadonlyArray<Part> };
  assistantMessages: ReadonlyArray<{
    info: { id: string; error?: unknown; time?: { completed?: number } };
    parts: ReadonlyArray<Part>;
  }>;
}

type PartEntry = { part: Part };

/** Web `isPlanWriteTool` (turn/plan-anchor.ts): the runtime emits both spellings. */
function isPlanWriteTool(tool: string): boolean {
  return tool === 'todowrite' || tool === 'todo_write';
}

// ─── Sections ────────────────────────────────────────────────────────────────

/**
 * True when the turn has work that renders in the steps section. Plan writes,
 * `task`, and `question` render elsewhere and do not count.
 */
export function turnHasSteps(allParts: ReadonlyArray<PartEntry>): boolean {
  return allParts.some(({ part }) => {
    const type = (part as { type: string }).type;
    if (type === 'compaction' || type === 'snapshot' || type === 'patch') return true;
    if (isToolPart(part)) {
      if (isPlanWriteTool(part.tool) || part.tool === 'task' || part.tool === 'question') return false;
      return shouldShowToolPart(part);
    }
    return false;
  });
}

export function turnHasReasoning(allParts: ReadonlyArray<PartEntry>): boolean {
  return allParts.some(({ part }) => isReasoningPart(part) && !!part.text?.trim());
}

// ─── Answered questions ──────────────────────────────────────────────────────

type QuestionInput = { questions?: ReadonlyArray<{ question: string }> };

/**
 * Answers from the question tool's output when `metadata.answers` is missing.
 * The server writes `"Q1"="A1"` pairs; an output that only says "answered"
 * yields a placeholder per question. `null` when nothing is recoverable.
 */
export function parseAnswersFromOutput(output: string, input?: QuestionInput): string[][] | null {
  if (!output) return null;
  const questions = input?.questions;
  if (!questions || questions.length === 0) return null;

  const pairRegex = /"([^"]*)"="([^"]*)"/g;
  const answers: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = pairRegex.exec(output)) !== null) answers.push(match[2]);

  if (answers.length > 0) return questions.map((_, i) => (answers[i] !== undefined ? [answers[i]] : []));
  if (output.toLowerCase().includes('answered')) return questions.map(() => ['Answered']);
  return null;
}

function withAnswers(part: ToolPart, answers: string[][]): ToolPart {
  const state = part.state as unknown as Record<string, unknown>;
  return {
    ...part,
    state: {
      ...state,
      status: 'completed',
      metadata: { ...((state.metadata as Record<string, unknown>) ?? {}), answers },
    },
  } as unknown as ToolPart;
}

/**
 * The turn's question calls that were answered, in order. A question that is
 * pending (its call id is in `pendingCallIds`) with nothing after it is still
 * being asked and is left out. When the server has not attached
 * `metadata.answers`, the answers come from the output, or a placeholder when
 * the agent visibly continued. Web also consults an optimistic answer cache;
 * mobile has none.
 */
export function answeredQuestionParts(turn: TurnBodyTurn, pendingCallIds: ReadonlySet<string>): ToolPart[] {
  const result: ToolPart[] = [];
  const messages = turn.assistantMessages;
  for (let mi = 0; mi < messages.length; mi++) {
    const parts = messages[mi].parts;
    for (let pi = 0; pi < parts.length; pi++) {
      const part = parts[pi];
      if (!isToolPart(part) || part.tool !== 'question') continue;

      let hasSubsequentContent = mi < messages.length - 1;
      for (let next = pi + 1; next < parts.length && !hasSubsequentContent; next++) {
        const type = (parts[next] as { type: string }).type;
        if (type !== 'step-finish' && type !== 'step-start') hasSubsequentContent = true;
      }

      if (pendingCallIds.has(part.callID) && !hasSubsequentContent) continue;

      const state = part.state as unknown as {
        input?: QuestionInput;
        output?: string;
        metadata?: { answers?: string[][] };
      };
      const serverAnswers = state.metadata?.answers;
      if (serverAnswers && serverAnswers.length > 0) {
        result.push(part);
      } else if (state.output && hasSubsequentContent) {
        const parsed = parseAnswersFromOutput(state.output, state.input);
        if (parsed) result.push(withAnswers(part, parsed));
      } else if (!state.output && hasSubsequentContent) {
        const asked = Array.isArray(state.input?.questions) ? state.input!.questions! : [];
        if (asked.length > 0) result.push(withAnswers(part, asked.map(() => ['Answered'])));
      }
    }
  }
  return result;
}

export type InlineContentItem =
  | { type: 'text'; part: TextPart; id: string }
  | { type: 'question'; part: ToolPart; id: string };

/**
 * Text and answered questions in natural order — only when the turn has both.
 * The question entry carries the answered (possibly synthetic) part.
 */
export function inlineContentItems(
  allParts: ReadonlyArray<PartEntry>,
  answeredById: ReadonlyMap<string, ToolPart>,
): InlineContentItem[] | null {
  if (answeredById.size === 0) return null;
  const items: InlineContentItem[] = [];
  for (const { part } of allParts) {
    if (isTextPart(part) && part.text?.trim()) {
      items.push({ type: 'text', part, id: part.id });
    } else if (isToolPart(part) && part.tool === 'question' && answeredById.has(part.id)) {
      items.push({ type: 'question', part: answeredById.get(part.id)!, id: part.id });
    }
  }
  const hasText = items.some((i) => i.type === 'text');
  const hasQuestion = items.some((i) => i.type === 'question');
  return hasText && hasQuestion ? items : null;
}

// ─── Segments ────────────────────────────────────────────────────────────────

/**
 * The parts `segmentTurn` receives. Only answered questions stay, as their
 * answered part, and not when the inline content already shows them.
 *
 * Deviation from web: web also drops plan writes (`todowrite`) because its
 * Plan card is the canonical todo surface. Mobile has no plan card, so the
 * plan write stays in its burst.
 */
export function segmentInputParts(
  allParts: ReadonlyArray<PartEntry>,
  answeredById: ReadonlyMap<string, ToolPart>,
  useInlineContent: boolean,
): Part[] {
  const parts: Part[] = [];
  for (const { part } of allParts) {
    if (isToolPart(part) && part.tool === 'question') {
      if (!answeredById.has(part.id) || useInlineContent) continue;
      parts.push(answeredById.get(part.id) ?? part);
      continue;
    }
    parts.push(part);
  }
  return parts;
}

/** Call ids with a pending permission in this session — always standalone rows. */
export function standaloneCallIdsFor(
  permissions: ReadonlyArray<{ sessionID?: string; tool?: { callID?: string } }>,
  sessionId: string | undefined,
): Set<string> {
  const ids = new Set<string>();
  for (const permission of permissions) {
    if (permission.sessionID === sessionId && permission.tool?.callID) ids.add(permission.tool.callID);
  }
  return ids;
}

/** The id of the last text segment — the one that can still be streaming. */
export function lastTextPartId(segments: ReadonlyArray<Segment>): string | undefined {
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment.kind === 'text') return segment.part.id;
  }
  return undefined;
}

// ─── Response ────────────────────────────────────────────────────────────────

/**
 * The turn's response text (web `response`):
 * - working: the text of the active (not yet completed) assistant message,
 *   falling back to the last text part;
 * - settled without steps: every non-blank text part, joined by a blank line;
 * - settled with steps: the last text part, trimmed; when that is empty and
 *   the turn errored, every non-blank text part.
 */
export function turnResponse({
  turn,
  allParts,
  working,
  hasSteps,
}: {
  turn: TurnBodyTurn;
  allParts: ReadonlyArray<PartEntry>;
  working: boolean;
  hasSteps: boolean;
}): string {
  const lastText = (findLastTextPart(allParts as PartEntry[]) as TextPart | undefined)?.text ?? '';

  if (working) {
    const messages = turn.assistantMessages;
    let active = messages[messages.length - 1];
    for (let i = messages.length - 1; i >= 0; i--) {
      if (!messages[i].info.time?.completed) {
        active = messages[i];
        break;
      }
    }
    let streaming = '';
    for (const part of active?.parts ?? []) {
      if (isTextPart(part)) streaming += part.text ?? '';
    }
    return streaming || lastText;
  }

  const texts = allParts
    .map(({ part }) => (isTextPart(part) ? part.text?.trim() : ''))
    .filter((value): value is string => Boolean(value));

  if (!hasSteps && texts.length > 0) return texts.join('\n\n');
  if (lastText.trim()) return lastText.trim();
  const errored = turn.assistantMessages.some((m) => m.info.error);
  return errored ? texts.join('\n\n').trim() : '';
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The message-level error, else a dismissed question's error without its "Error:" prefix. */
export function turnErrorText(turn: TurnBodyTurn): string | undefined {
  const messageError = getTurnError(turn as never);
  if (messageError) return messageError;
  for (const message of turn.assistantMessages) {
    for (const part of message.parts) {
      if (!isToolPart(part) || part.tool !== 'question') continue;
      const state = part.state as { status: string; error?: string };
      if (state.status === 'error' && typeof state.error === 'string') {
        return state.error.replace(/^Error:\s*/, '');
      }
    }
  }
  return undefined;
}

/** Web `deriveTurnErrorAbortState`: the first structured message error decides. */
export function turnErrorIsAbort(turn: TurnBodyTurn): boolean {
  for (const message of turn.assistantMessages) {
    const error = message.info.error;
    if (!error || typeof error !== 'object') continue;
    return isAbortError(error);
  }
  return false;
}

// ─── Visibility ──────────────────────────────────────────────────────────────

/** Web `turn-busy-visibility.ts`: an error hides the busy row unless a retry runs. */
export function showTurnBusyIndicator(input: { working: boolean; hasError: boolean; isRetrying: boolean }): boolean {
  if (!input.working) return false;
  if (input.isRetrying) return true;
  return !input.hasError;
}

/**
 * Web `SessionChat` `suppressWorkingTurnBusy`: the resolved working turn has a
 * COMPLETED answer while prompts wait below it. Its busy row would sit above
 * the queued prompt and jump down once that prompt runs, so the turn draws no
 * row. A turn still streaming has an open assistant message and never
 * suppresses.
 */
export function suppressWorkingTurnBusy(
  turns: ReadonlyArray<TurnBodyTurn>,
  resolution: Pick<WorkingTurnResolution, 'workingTurnId' | 'pendingTurnIds'>,
): boolean {
  if (resolution.pendingTurnIds.length === 0) return false;
  const working = turns.find((t) => t.userMessage.info.id === resolution.workingTurnId);
  if (!working || working.assistantMessages.length === 0) return false;
  const newest = working.assistantMessages[working.assistantMessages.length - 1];
  return !!newest.info.time?.completed;
}

/**
 * Web's transcript-end busy row: the session is busy and no turn draws the
 * row itself — no working turn (every prompt unanswered and held), or the
 * working turn is suppressed.
 */
export function transcriptBusyRowVisible(input: {
  isBusy: boolean;
  workingTurnId: string | null;
  suppressWorkingTurnBusy: boolean;
}): boolean {
  const someTurnDrawsBusyRow = input.workingTurnId !== null && !input.suppressWorkingTurnBusy;
  return input.isBusy && !someTurnDrawsBusyRow;
}

/**
 * Web gates the action bar on `!working` only: a turn that ends in tool calls
 * still has its finished-at, duration, and cost. Copy hides itself without a
 * response; the details button hides itself without rows.
 */
export function showTurnActions(input: { working: boolean }): boolean {
  return !input.working;
}

// ─── Compaction ──────────────────────────────────────────────────────────────

export type CompactionTurnView =
  | { kind: 'marker'; running: boolean }
  | { kind: 'failed'; error: string | undefined; isAbort: boolean };

/**
 * Web `SessionTurnImpl`'s compaction branch — the whole render of a compaction
 * turn:
 * - running (`working || info.inFlight`), a summary, or a compaction part →
 *   the divider marker;
 * - otherwise the failed row. Its error is the turn error, else the summary
 *   message's own error (a SYNTHETIC turn has no assistant messages for
 *   `getTurnError` to read), unwrapped. An abort is the turn's structured
 *   abort or a structured abort on the summary message.
 */
export function compactionTurnView(input: {
  working: boolean;
  info: Pick<CompactionTurnInfo, 'inFlight' | 'hasContent' | 'error'>;
  response: string;
  turnError?: string;
  turnErrorIsAbort: boolean;
}): CompactionTurnView {
  const running = input.working || input.info.inFlight;
  if (running || input.response || input.info.hasContent) return { kind: 'marker', running };
  const raw = input.info.error;
  const error = input.turnError ?? (raw != null ? unwrapError(raw) : undefined);
  const isAbort = input.turnErrorIsAbort || (typeof raw === 'object' && raw !== null && isAbortError(raw));
  return { kind: 'failed', error, isAbort };
}

/** Web `hasCompactionTurn`: any turn, in any state, is a compaction. */
export function hasCompactionTurn(turns: ReadonlyArray<TurnBodyTurn>): boolean {
  return turns.some((turn) => compactionTurnInfo(turn as never).isCompaction);
}

/** Web `lastCompactionTurnIndex`: the index of the last compaction turn, else -1. */
export function lastCompactionTurnIndex(turns: ReadonlyArray<TurnBodyTurn>): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (compactionTurnInfo(turns[i] as never).isCompaction) return i;
  }
  return -1;
}

/**
 * Web `suppressedFailedCompaction`: a failed attempt (no content, not in
 * flight, not the working turn) with a later compaction turn is history —
 * retries collapse to the latest row.
 */
export function isSuppressedFailedCompaction(input: {
  info: Pick<CompactionTurnInfo, 'isCompaction' | 'hasContent' | 'inFlight'>;
  isTurnWorking: boolean;
  turnIndex: number;
  lastCompactionTurnIndex: number;
}): boolean {
  const { info } = input;
  const failed = info.isCompaction && !info.hasContent && !info.inFlight && !input.isTurnWorking;
  return failed && input.turnIndex < input.lastCompactionTurnIndex;
}

// ─── Command ─────────────────────────────────────────────────────────────────

/** The user's visible prompt text, for slash-command detection (web `userMessageText`). */
export function commandPromptText(parts: ReadonlyArray<Part>): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (!isTextPart(part)) continue;
    const flags = part as TextPart & { synthetic?: boolean; ignored?: boolean };
    if (flags.synthetic || flags.ignored) continue;
    if (part.text?.trim()) texts.push(part.text);
  }
  return texts.join('\n').trim();
}

// ─── Display path ────────────────────────────────────────────────────────────

/**
 * The sandbox workspace root. Web discovers its roots from `/project/current`
 * and `/path`; every mobile file surface (file mentions, the Files page) uses
 * this fixed root.
 */
export const WORKSPACE_ROOTS: readonly string[] = ['/workspace'];

/**
 * Absolute sandbox path → the project-relative path a reader sees. The
 * longest matching root wins; `/` is never stripped; anything else is
 * returned unchanged.
 */
export function toDisplayPath(absPath: string, roots: readonly string[] = WORKSPACE_ROOTS): string {
  if (!absPath || !absPath.startsWith('/')) return absPath;
  const sorted = [...roots].sort((a, b) => b.length - a.length);
  for (const root of sorted) {
    if (!root || root === '/') continue;
    const prefix = root.endsWith('/') ? root : `${root}/`;
    if (absPath.startsWith(prefix)) return absPath.slice(prefix.length);
  }
  return absPath;
}
