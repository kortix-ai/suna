/**
 * The block functions a transcript draws a turn with: segments (bursts, text, standalone
 * calls, show groups), the settled-turn work split, burst steps, and the activity line. Each
 * runs the v1 rule (`core/turns/segments`) on the blocks' v1 parts and maps the answer back
 * to the blocks, so the two layers agree (`oracle.test.ts`). `segments.test.ts` holds the
 * block-native cases.
 */
import type { Part, ToolPart } from '../../runtime/runtime-types';
import { classifyTurn, toToolView, type ClassifiedTurn } from '../../turns/classify';
import { isReasoningPart, isToolPart } from '../../turns/parts';
import { burstSummary, burstWorkLabel, type BurstSummary } from '../../turns/segments/burst-summary';
import { mergeBurstSteps, reasoningIsRunning, type BurstStep } from '../../turns/segments/merge-steps';
import type { StepFamily } from '../../turns/segments/narration';
import { segmentTurn, type SegmentTurnOptions } from '../../turns/segments/segment-turn';
import { isQuestionTool } from '../../turns/segments/session-activity-groups';
import { groupShowSegments, showGroupItems, type ShowGroupItem, type ShowGroupedSegment } from '../../turns/segments/show-group';
import { stepLabel } from '../../turns/segments/step-label';
import { splitTurnWork } from '../../turns/segments/work-split';
import { getTurnStatus } from '../../turns/state';
import { parseQuestionAnswersFromOutput } from '../../turns/tools/question-helpers';
import { toolCallBlock, toolPartOf } from '../tool-call';
import type { SessionLogBlock, SessionLogMessage, TextBlock, ToolCallBlock } from '../types';
import { isClosedByRule, type SessionLogTurn } from './turn';
import { blockOf, messageOfBlock, partOf, partsOf, v1RowsOf } from './v1-parts';

export type SessionLogSegment =
  | { kind: 'burst'; blocks: SessionLogBlock[] }
  | { kind: 'text'; block: TextBlock }
  | { kind: 'standalone'; block: ToolCallBlock }
  /** Two or more adjacent `show` calls, one carousel. */
  | { kind: 'show-group'; blocks: ToolCallBlock[] };


export interface SessionLogTurnWorkSplit {
  /** Folded behind the "Worked for" row. Never empty. */
  work: SessionLogSegment[];
  /** The `show` deliverables, in call order. */
  hoisted: SessionLogSegment[];
  /** The final text segment, or empty when the turn did not end on text. */
  final: SessionLogSegment[];
}

export type SessionLogBurstStep =
  | { kind: 'thought'; key: string; texts: string[]; running: boolean; durationMs?: number }
  | { kind: 'block'; key: string; block: SessionLogBlock }
  | { kind: 'group'; key: string; blocks: ToolCallBlock[]; family: StepFamily; label: string; status: 'running' | 'error' | 'done'; durationMs?: number };

const call = (p: object) => blockOf(p) as ToolCallBlock;

/** The segments of a turn's blocks: a burst is a run of non-text blocks, closed by a text block; `show` and sub-agent calls stand alone. */
export function sessionLogTurnSegments(blocks: ReadonlyArray<SessionLogBlock>, options: SegmentTurnOptions = {}): SessionLogSegment[] {
  return groupShowSegments(segmentTurn(partsOf(blocks), options), options).map((s) =>
    s.kind === 'burst' ? { kind: s.kind, blocks: s.parts.map(blockOf) }
    : s.kind === 'show-group' ? { kind: s.kind, blocks: s.parts.map(call) }
    : s.kind === 'text' ? { kind: s.kind, block: blockOf(s.part) as TextBlock }
    : { kind: s.kind, block: call(s.part) },
  );
}

const v1Segment = (s: SessionLogSegment): ShowGroupedSegment =>
  s.kind === 'burst' || s.kind === 'show-group' ? ({ kind: s.kind, parts: partsOf(s.blocks) } as ShowGroupedSegment) : ({ kind: s.kind, part: partOf(s.block) } as ShowGroupedSegment);

/** The settled-turn fold of `segments`: `null` while the turn works, or when it has no work to fold. */
export function splitSessionLogTurnWork(segments: ReadonlyArray<SessionLogSegment>, options: { working: boolean }): SessionLogTurnWorkSplit | null {
  const by = new Map(segments.map((s) => [v1Segment(s), s] as const));
  const split = splitTurnWork([...by.keys()], options);
  if (!split) return null;
  const back = (list: ShowGroupedSegment[]) => list.map((s) => by.get(s)!);
  return { work: back(split.work), hoisted: back(split.hoisted), final: back(split.final) };
}

/** A `question` call with the questions asked and the user's answers (from the harness's metadata, else the tool's output). */
function isAnswered(part: Part): boolean {
  if (!isToolPart(part) || !isQuestionTool(part.tool)) return false;
  const questions = (part.state as { input?: { questions?: unknown } }).input?.questions;
  if (!Array.isArray(questions) || !questions.length) return false;
  const view = toToolView(part);
  return (view.answers ?? parseQuestionAnswersFromOutput(view.outputText ?? '', questions.length) ?? []).length > 0;
}

/**
 * The rows a burst renders: plumbing never shows, consecutive reasoning is one thought row,
 * consecutive same-family calls are one group row; an answered question is its own row. A
 * thought runs only while its message streams (a native reasoning block carries no end time).
 */
export function sessionLogBurstSteps(blocks: ReadonlyArray<SessionLogBlock>): SessionLogBurstStep[] {
  const steps = mergeBurstSteps(partsOf(blocks), (p) => stepLabel(p).tier).flatMap((step): BurstStep[] =>
    step.kind === 'group' && step.step.parts.some(isAnswered) ? step.step.parts.map((part) => ({ kind: 'part', key: part.id, part })) : [step],
  );
  return steps.map((s) => {
    if (s.kind === 'part') return { kind: 'block', key: s.key, block: blockOf(s.part) };
    if (s.kind === 'group') return { kind: 'group', key: s.key, blocks: s.step.parts.map(call), family: s.step.family, label: s.step.label, status: s.step.status, durationMs: s.step.durationMs };
    const first = blocks.find((b) => b.id === s.key.slice('thought-'.length));
    const message = first && messageOfBlock.get(first);
    return { kind: 'thought', key: s.key, texts: s.texts, running: s.running && (!message || message.status === 'streaming'), durationMs: s.durationMs };
  });
}

/** The activity line of a live turn ("Reading files..."); a running task reads its sub-thread's `childMessages`. */
export function sessionLogActivityText(turn: Pick<SessionLogTurn, 'blocks'>, childMessages?: readonly SessionLogMessage[]): string {
  return getTurnStatus(partsOf(turn.blocks).map((part) => ({ part })), childMessages?.flatMap(v1RowsOf));
}

/** How much work a burst holds (`burstSummary`): what its summary line says ("Completed 3 of 4 steps"). */
export function sessionLogBurstSummary(blocks: ReadonlyArray<SessionLogBlock>): BurstSummary {
  return burstSummary(partsOf(blocks));
}

/** What a settled burst did (`burstWorkLabel`): "Ran 3 commands, read 2 files · 1 failed". */
export function sessionLogBurstWorkLabel(blocks: ReadonlyArray<SessionLogBlock>): string {
  return burstWorkLabel(partsOf(blocks));
}

/**
 * The burst is in progress: never once the turn stops working; the trailing burst for the whole
 * working turn (so a gap between two calls does not close it); another burst while a call is open
 * or a thought is still written (a v1 thought until its end time, a native one while its message streams).
 */
export function sessionLogBurstRunning(blocks: ReadonlyArray<SessionLogBlock>, options: { working: boolean; trailing?: boolean }): boolean {
  if (!options.working) return false;
  if (options.trailing) return true;
  return blocks.some((block) => {
    if (block.type === 'tool_call') return block.status === 'pending' || block.status === 'running';
    if (block.type !== 'reasoning') return false;
    const part = partOf(block);
    const message = messageOfBlock.get(block);
    return !!part && isReasoningPart(part) && reasoningIsRunning(part) && (!message || message.status === 'streaming');
  });
}

const reopened = new WeakMap<ToolCallBlock, ToolCallBlock>();

/**
 * The call with the status {@link sessionLogCallStatus} gives it on a live turn: a call the
 * closure rule closed at rest (C2/F11: `error`, `result.synthetic` or `result.error.code:
 * 'interrupted'`) reads open again, `running` once started, else `pending`, with no result,
 * as the v1 live view holds it; every other call is itself. One object per call, so a
 * renderer's memos hold. `sessionLogCallStatus(call, turn.live)` says whether it is interrupted.
 */
export function sessionLogOpenCall(call: ToolCallBlock): ToolCallBlock {
  if (!isClosedByRule(call)) return call;
  let open = reopened.get(call);
  if (!open) {
    const { result: _result, ...rest } = call;
    open = { ...rest, status: call.started_at ? 'running' : 'pending' };
    reopened.set(call, open);
  }
  return open;
}

/** A failed call keeps its slot as an `error` item whose `content` is the message. */
function carouselItem(item: ShowGroupItem): Omit<ShowGroupItem, 'callID' | 'error'> {
  const { callID: _callID, error, ...rest } = item;
  return item.status === 'error' ? { ...rest, type: 'error', content: error || 'This output failed to load.' } : rest;
}

/**
 * A run of adjacent `show` calls (a `show-group` segment) as ONE `show` call: the first call's
 * id and call id, `input.items` the carousel of every call's items, `running` while any call
 * is open, else `complete`. N single calls and one N-item call render the same card.
 */
export function sessionLogShowGroupCall(calls: ReadonlyArray<ToolCallBlock>): ToolCallBlock {
  const parts = calls.map(toolPartOf);
  const first = parts[0]!;
  const running = parts.some((p) => p.state.status === 'running' || p.state.status === 'pending');
  const items = showGroupItems(parts).map(carouselItem);
  return toolCallBlock({ ...first, state: { ...first.state, status: running ? 'running' : 'completed', input: { items } } } as ToolPart);
}

/**
 * A `question` call as answered with `answers` (one list per question) the harness has not
 * confirmed yet (an answer just sent, or answers read back from the tool's output): `complete`,
 * the answers in its metadata (`toToolView(call).answers`), `input` replaced when given.
 */
export function sessionLogAnsweredQuestionCall(call: ToolCallBlock, answers: string[][], input?: Record<string, unknown>): ToolCallBlock {
  const part = toolPartOf(call);
  const state = part.state as ToolPart['state'] & { metadata?: Record<string, unknown> };
  return toolCallBlock({
    ...part,
    state: { ...state, status: 'completed', ...(input !== undefined && { input }), metadata: { ...(state.metadata ?? {}), answers } },
  } as ToolPart);
}

/**
 * `classifyTurn` of one session-log message: its blocks as `ClassifiedPart`s, through the v1 rows
 * `toV1` gives the message (exact for a converted record, the builder's rows for a native one),
 * and its error normalized with the gateway's own sentence. A compaction is one message: the
 * marker's parts, then the summary's. Transitional, as `toolCallBlock`: it goes with
 * `ClassifiedPart` (P8.4).
 */
export function classifySessionLogMessage(message: SessionLogMessage): ClassifiedTurn {
  const rows = v1RowsOf(message).map((row) => classifyTurn(row));
  const error = rows.find((row) => row.error)?.error;
  return { parts: rows.flatMap((row) => row.parts), error, isEmpty: rows.every((row) => row.isEmpty) && !error };
}
