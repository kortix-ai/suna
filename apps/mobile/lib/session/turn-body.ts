/**
 * Pure rules behind the assistant side of a turn — which blocks render, in
 * which section, and when the busy indicator, error, and action bar show.
 *
 * Ported from apps/web `features/session/session-chat/transcript.tsx`
 * (`isStepBlock`, `response`, `collectAnsweredQuestions`, the inline content,
 * the segments input, `resolveTurnError`, `deriveTurnErrorAbortState`, the
 * action bar gate, the compaction branch), `session-chat.tsx`
 * (`suppressWorkingTurnBusy`, `someTurnDrawsBusyRow`, `hasCompactionTurn`,
 * `lastCompactionTurnIndex`, `suppressedFailedCompaction`),
 * `turn-busy-visibility.ts`, and `use-oc-file-open.ts` `toDisplayPath`.
 *
 * Every rule reads the SDK's block turn (`SessionLogTurn`, `sessionLogTurns`).
 * No React, no React Native. `components/session/SessionTurn.tsx` composes it.
 */

import {
  sessionLogActivityText,
  sessionLogAnsweredQuestionCall,
  sessionLogOpenCall,
  sessionLogTurnSegments,
  shouldShowToolPart,
  splitSessionLogTurnWork,
  toolCallMetadata,
  type SessionLogBlock,
  type SessionLogCompaction,
  type SessionLogMessage,
  type SessionLogSegment,
  type SessionLogTurn,
  type SessionLogTurnWorkSplit,
  type TextBlock,
  type ToolCallBlock,
} from '@kortix/sdk';

import { burstView } from './activity';
import { connectorHandoffCallIds } from './connector-handoff';
import { partRawOutput } from './tool-part-accessors';
import { messageAborted } from './turn-error';

/** Web `isPlanWriteTool` (turn/plan-anchor.ts): the runtime emits both spellings. */
function isPlanWriteTool(tool: string): boolean {
  return tool === 'todowrite' || tool === 'todo_write';
}

// ─── Blocks ──────────────────────────────────────────────────────────────────

const visibleBlocks = new WeakMap<SessionLogTurn, SessionLogBlock[]>();

/**
 * The turn's reply blocks without reasoning (mobile never shows thinking),
 * each call in its open shape (`sessionLogOpenCall`): the v1 live view and the
 * v2 page at rest hand every rule below one shape. One array per turn object.
 */
export function turnBlocks(turn: SessionLogTurn): SessionLogBlock[] {
  let list = visibleBlocks.get(turn);
  if (!list) {
    list = turn.blocks.flatMap((b) => (b.type === 'reasoning' ? [] : [b.type === 'tool_call' ? sessionLogOpenCall(b) : b]));
    visibleBlocks.set(turn, list);
  }
  return list;
}

// ─── Sections ────────────────────────────────────────────────────────────────

/**
 * A block that renders in the steps section: a snapshot, a patch or a
 * compaction, or a visible call other than the plan write, `task` and
 * `question` (each rendered elsewhere).
 */
function isStepBlock(block: SessionLogBlock): boolean {
  if (block.type === 'compaction') return true;
  if (block.type === 'harness') return block.kind === 'compaction' || block.kind === 'snapshot' || block.kind === 'patch';
  if (block.type !== 'tool_call') return false;
  if (isPlanWriteTool(block.name) || block.name === 'task' || block.name === 'question') return false;
  return shouldShowToolPart(block);
}

/** True when the turn has work that renders in the steps section. */
export function turnHasSteps(blocks: ReadonlyArray<SessionLogBlock>): boolean {
  return blocks.some(isStepBlock);
}

/**
 * The turn's activity line ("Reading files..."). A thought stays in, with its
 * text blanked, so the line is a bare "Thinking..." (the SDK's status scan
 * returns the last tool's phrase otherwise) and no thought text or heading
 * reaches the screen.
 */
export function busyStatusText(blocks: ReadonlyArray<SessionLogBlock>): string {
  return sessionLogActivityText({ blocks: blocks.map((b) => (b.type === 'reasoning' ? { ...b, text: '' } : b)) });
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

/**
 * The turn's question calls that were answered, in order. A question that is
 * pending (its call id is in `pendingCallIds`) with nothing after it is still
 * being asked and is left out. When the server has not attached
 * `metadata.answers`, the answers come from the output, or a placeholder when
 * the agent visibly continued (`sessionLogAnsweredQuestionCall`). Web also
 * consults an optimistic answer cache; mobile has none.
 */
export function answeredQuestionCalls(
  replies: ReadonlyArray<SessionLogMessage>,
  pendingCallIds: ReadonlySet<string>,
): ToolCallBlock[] {
  const result: ToolCallBlock[] = [];
  for (let mi = 0; mi < replies.length; mi++) {
    const blocks = replies[mi].blocks;
    for (let bi = 0; bi < blocks.length; bi++) {
      const block = blocks[bi];
      if (block.type !== 'tool_call' || block.name !== 'question') continue;
      const call = sessionLogOpenCall(block);

      let hasSubsequentContent = mi < replies.length - 1;
      for (let next = bi + 1; next < blocks.length && !hasSubsequentContent; next++) {
        if (blocks[next].type !== 'step') hasSubsequentContent = true;
      }

      if (pendingCallIds.has(call.call_id) && !hasSubsequentContent) continue;

      const input = (typeof call.input === 'object' && call.input !== null ? call.input : {}) as QuestionInput;
      const output = call.status === 'complete' ? partRawOutput(call) : '';
      const serverAnswers = toolCallMetadata(call).answers;
      if (Array.isArray(serverAnswers) && serverAnswers.length > 0) {
        result.push(call);
      } else if (output && hasSubsequentContent) {
        const parsed = parseAnswersFromOutput(output, input);
        if (parsed) result.push(sessionLogAnsweredQuestionCall(call, parsed));
      } else if (!output && hasSubsequentContent) {
        const asked = Array.isArray(input.questions) ? input.questions : [];
        if (asked.length > 0) result.push(sessionLogAnsweredQuestionCall(call, asked.map(() => ['Answered'])));
      }
    }
  }
  return result;
}

export type InlineContentItem =
  | { type: 'text'; block: TextBlock; id: string }
  | { type: 'question'; call: ToolCallBlock; id: string };

/**
 * Text and answered questions in natural order — only when the turn has both.
 * The question entry carries the answered (possibly synthetic) call.
 */
export function inlineContentItems(
  blocks: ReadonlyArray<SessionLogBlock>,
  answeredById: ReadonlyMap<string, ToolCallBlock>,
): InlineContentItem[] | null {
  if (answeredById.size === 0) return null;
  const items: InlineContentItem[] = [];
  for (const block of blocks) {
    if (block.type === 'text' && block.text.trim()) {
      items.push({ type: 'text', block, id: block.id });
    } else if (block.type === 'tool_call' && block.name === 'question' && answeredById.has(block.id)) {
      items.push({ type: 'question', call: answeredById.get(block.id)!, id: block.id });
    }
  }
  const hasText = items.some((i) => i.type === 'text');
  const hasQuestion = items.some((i) => i.type === 'question');
  return hasText && hasQuestion ? items : null;
}

// ─── Segments ────────────────────────────────────────────────────────────────

/**
 * The blocks the segments receive. Only answered questions stay, as their
 * answered call, and not when the inline content already shows them.
 *
 * Deviation from web: web also drops plan writes (`todowrite`) because its
 * Plan card is the canonical todo surface. Mobile has no plan card, so the
 * plan write stays in its burst.
 */
export function segmentInputBlocks(
  blocks: ReadonlyArray<SessionLogBlock>,
  answeredById: ReadonlyMap<string, ToolCallBlock>,
  useInlineContent: boolean,
): SessionLogBlock[] {
  const out: SessionLogBlock[] = [];
  for (const block of blocks) {
    if (block.type === 'tool_call' && block.name === 'question') {
      if (!answeredById.has(block.id) || useInlineContent) continue;
      out.push(answeredById.get(block.id) ?? block);
      continue;
    }
    out.push(block);
  }
  return out;
}

/** A turn segment as mobile draws it: a burst, a text block, or one standalone call (no show carousel). */
export type TurnSegment = Exclude<SessionLogSegment, { kind: 'show-group' }>;

/**
 * The SDK's segments (`sessionLogTurnSegments`) with each run of `show` calls
 * back as one standalone segment per call: mobile draws every `show` call as
 * its own card.
 */
export function turnSegments(
  blocks: ReadonlyArray<SessionLogBlock>,
  standaloneCallIds: ReadonlySet<string>,
): TurnSegment[] {
  return sessionLogTurnSegments(blocks, { standaloneCallIds }).flatMap((segment): TurnSegment[] =>
    segment.kind === 'show-group' ? segment.blocks.map((block) => ({ kind: 'standalone', block })) : [segment],
  );
}

/**
 * Call ids that always render as standalone rows, never inside a burst:
 * - a pending permission in this session;
 * - a `kortix-connectors_call` that asks the user to connect an app or to
 *   approve the call (`connectorHandoffCallIds`). Its Connect row and approval
 *   prompt read the transcript's `ConnectorHandoffContext`; inside a burst they
 *   would render in the activity sheet, outside that context, and the connect
 *   sheet would stack on the activity sheet.
 */
export function standaloneCallIdsFor(
  permissions: ReadonlyArray<{ sessionID?: string; tool?: { callID?: string } }>,
  sessionId: string | undefined,
  blocks: ReadonlyArray<SessionLogBlock> = [],
): Set<string> {
  const ids = new Set<string>();
  for (const permission of permissions) {
    if (permission.sessionID === sessionId && permission.tool?.callID) ids.add(permission.tool.callID);
  }
  for (const callId of connectorHandoffCallIds(blocks)) ids.add(callId);
  return ids;
}

/** The id of the last text segment — the one that can still be streaming. */
export function lastTextBlockId(segments: ReadonlyArray<TurnSegment>): string | undefined {
  for (let i = segments.length - 1; i >= 0; i--) {
    const segment = segments[i];
    if (segment.kind === 'text') return segment.block.id;
  }
  return undefined;
}

function messageOfBlockId(assistant: ReadonlyArray<SessionLogMessage>, blockId: string) {
  return assistant.find((m) => m.blocks.some((b) => b.id === blockId));
}

/**
 * KRTX-2933: the text block that can still grow, by the part's own state, not
 * only the turn's. It is the last text segment, its message still streams,
 * and no later block of that message follows it. Call only while the turn is
 * live: `turn.live` follows the session's busy flag, which can read busy
 * after the reply ended.
 */
export function liveTextBlockId(
  assistant: ReadonlyArray<SessionLogMessage>,
  segments: ReadonlyArray<TurnSegment>,
): string | undefined {
  const id = lastTextBlockId(segments);
  return id !== undefined && isOpenTextBlock(assistant, id) ? id : undefined;
}

/** The block's message still streams and the block is that message's last block. */
export function isOpenTextBlock(assistant: ReadonlyArray<SessionLogMessage>, blockId: string): boolean {
  const message = messageOfBlockId(assistant, blockId);
  return message?.status === 'streaming' && message.blocks[message.blocks.length - 1]?.id === blockId;
}

/** `message_id:block_id`: the key the stream pacer remembers a part's revealed length under. */
export function textBlockRevealKey(assistant: ReadonlyArray<SessionLogMessage>, blockId: string): string {
  const message = messageOfBlockId(assistant, blockId);
  return message ? `${message.message_id}:${blockId}` : blockId;
}

// ─── Settled-turn fold (KRTX-2113) ───────────────────────────────────────────

/** False when `SessionTurn` draws nothing for the segment (a plumbing-only burst, a hidden tool, blank text). */
function segmentRendersSomething(segment: TurnSegment): boolean {
  if (segment.kind === 'burst') return !burstView(segment.blocks, false).hidden;
  if (segment.kind === 'standalone') return shouldShowToolPart(segment.block);
  return !!segment.block.text.trim();
}

/**
 * The SDK's `splitSessionLogTurnWork` over the segments that draw something,
 * so the "Worked for" row never opens onto nothing and an invisible segment
 * never stands between the final text and the end of the turn. `null` =
 * render as today (working, or no work to fold). Interim text is work: the
 * opened row shows it inline, between the bursts it narrates.
 */
export function turnWorkSplit(
  segments: ReadonlyArray<TurnSegment>,
  working: boolean,
): { [K in keyof SessionLogTurnWorkSplit]: TurnSegment[] } | null {
  if (working) return null;
  // The split hands back the segments it was given: no show group goes in, none comes out.
  return splitSessionLogTurnWork(segments.filter(segmentRendersSomething), { working }) as {
    [K in keyof SessionLogTurnWorkSplit]: TurnSegment[];
  } | null;
}

// ─── Layout ──────────────────────────────────────────────────────────────────

export interface TurnBodyLayout {
  /** The segments list (bursts, standalone rows, and text when `text` is 'segments') renders. */
  segments: boolean;
  /**
   * Where the reply text renders:
   * - 'segments': each text block in the segments list, keyed by its block id;
   * - 'response': one block, in the slash-command card;
   * - 'inline': the inline content (text + answered questions).
   */
  text: 'segments' | 'response' | 'inline';
}

/**
 * Where each block of a turn renders (KRTX-1678). The reply text stays in the
 * segments list for the whole stream: it does not depend on `working` or on
 * whether a tool ran yet. A text-only reply that moved into the segments list
 * on the first tool call remounted mid-stream, a visible jump, and the
 * streaming block showed only the active message while the settled one joined
 * every message. A slash-command reply keeps its card until a step arrives.
 */
export function turnBodyLayout({
  working,
  hasSteps,
  hasAssistantContent,
  showInlineContent,
  isCommand,
}: {
  working: boolean;
  hasSteps: boolean;
  hasAssistantContent: boolean;
  showInlineContent: boolean;
  isCommand: boolean;
}): TurnBodyLayout {
  const text = showInlineContent ? 'inline' : isCommand && !hasSteps ? 'response' : 'segments';
  const segments = hasAssistantContent && (text === 'segments' || working || hasSteps);
  return { segments, text };
}

// ─── Response ────────────────────────────────────────────────────────────────

/**
 * The turn's response text (web `response`):
 * - working: the text of the active (not yet completed) reply, falling back
 *   to the last text block;
 * - settled without steps: every non-blank text block, joined by a blank line;
 * - settled with steps: the last text block, trimmed; when that is empty and
 *   the turn errored, every non-blank text block.
 */
export function turnResponse({
  turn,
  blocks,
  working,
  hasSteps,
}: {
  turn: SessionLogTurn;
  blocks: ReadonlyArray<SessionLogBlock>;
  working: boolean;
  hasSteps: boolean;
}): string {
  const lastText = turn.response?.text ?? '';

  if (working) {
    const replies = turn.assistant;
    let active = replies[replies.length - 1];
    for (let i = replies.length - 1; i >= 0; i--) {
      if (replies[i].completed_at === null) {
        active = replies[i];
        break;
      }
    }
    let streaming = '';
    for (const block of active?.blocks ?? []) {
      if (block.type === 'text') streaming += block.text;
    }
    return streaming || lastText;
  }

  const texts = blocks
    .map((block) => (block.type === 'text' ? block.text.trim() : ''))
    .filter((value): value is string => Boolean(value));

  if (!hasSteps && texts.length > 0) return texts.join('\n\n');
  if (lastText.trim()) return lastText.trim();
  const errored = turn.assistant.some((m) => m.error);
  return errored ? texts.join('\n\n').trim() : '';
}

// ─── Errors ──────────────────────────────────────────────────────────────────

/** The text a call's result carries (a v1 part's `output` or `error`). */
function resultText(call: ToolCallBlock): string {
  return (call.result?.content ?? []).flatMap((c) => (c.type === 'text' ? [c.text] : [])).join('');
}

/** The reply error, else a dismissed question's error without its "Error:" prefix. */
export function turnErrorText(turn: SessionLogTurn): string | undefined {
  if (turn.error) return turn.error.message;
  for (const block of turn.blocks) {
    if (block.type !== 'tool_call' || block.name !== 'question') continue;
    const call = sessionLogOpenCall(block);
    if (call.status === 'error' && call.result) {
      return (call.result.error?.message ?? resultText(call)).replace(/^Error:\s*/, '');
    }
  }
  return undefined;
}

/** Web `deriveTurnErrorAbortState`: the first errored message (a compaction's marker first) decides. */
export function turnErrorIsAbort(turn: Pick<SessionLogTurn, 'user' | 'assistant'>): boolean {
  const sources = turn.user.kind === 'compaction' ? [turn.user, ...turn.assistant] : turn.assistant;
  const message = sources.find((m) => m.error);
  return !!message && messageAborted(message);
}

// ─── Visibility ──────────────────────────────────────────────────────────────

/** Web `turn-busy-visibility.ts`: an error hides the busy row unless a retry runs. */
export function showTurnBusyIndicator(input: { working: boolean; hasError: boolean; isRetrying: boolean }): boolean {
  if (!input.working) return false;
  if (input.isRetrying) return true;
  return !input.hasError;
}

/**
 * Web `SessionChat` `suppressWorkingTurnBusy`: the live turn has a COMPLETED
 * answer while prompts wait below it. Its busy row would sit above the queued
 * prompt and jump down once that prompt runs, so the turn draws no row. A
 * turn still streaming has an open reply and never suppresses.
 */
export function suppressWorkingTurnBusy(turns: ReadonlyArray<SessionLogTurn>): boolean {
  const live = turns.find((t) => t.live);
  if (!live || live.assistant.length === 0 || !turns.some((t) => t.queued)) return false;
  return live.assistant[live.assistant.length - 1].completed_at !== null;
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
 * - running (`working || inFlight`), a summary, or a compaction block → the
 *   divider marker;
 * - otherwise the failed row, with the turn error (the marker's own error
 *   first) and whether that error is an abort.
 */
export function compactionTurnView(input: {
  working: boolean;
  compaction: Pick<SessionLogCompaction, 'inFlight' | 'hasContent'>;
  response: string;
  turnError?: string;
  turnErrorIsAbort: boolean;
}): CompactionTurnView {
  const running = input.working || input.compaction.inFlight;
  if (running || input.response || input.compaction.hasContent) return { kind: 'marker', running };
  return { kind: 'failed', error: input.turnError, isAbort: input.turnErrorIsAbort };
}

/** Web `lastCompactionTurnIndex`: the index of the last compaction turn, else -1. */
export function lastCompactionTurnIndex(turns: ReadonlyArray<Pick<SessionLogTurn, 'compaction'>>): number {
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].compaction) return i;
  }
  return -1;
}

/**
 * Web `suppressedFailedCompaction`: a failed attempt (no content, not in
 * flight, not the working turn) with a later compaction turn is history —
 * retries collapse to the latest row.
 */
export function isSuppressedFailedCompaction(input: {
  compaction: Pick<SessionLogCompaction, 'hasContent' | 'inFlight'> | null;
  isTurnWorking: boolean;
  turnIndex: number;
  lastCompactionTurnIndex: number;
}): boolean {
  const { compaction } = input;
  const failed = !!compaction && !compaction.hasContent && !compaction.inFlight && !input.isTurnWorking;
  return failed && input.turnIndex < input.lastCompactionTurnIndex;
}

// ─── Command ─────────────────────────────────────────────────────────────────

/** The user's visible prompt text, for slash-command detection (web `userMessageText`). */
export function commandPromptText(blocks: ReadonlyArray<SessionLogBlock>): string {
  const texts: string[] = [];
  for (const block of blocks) {
    if (block.type !== 'text' || block.synthetic) continue;
    if (block.text.trim()) texts.push(block.text);
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
