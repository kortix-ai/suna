/**
 * The block functions a transcript draws a turn with: segments (bursts, text, standalone
 * calls, show groups), the settled-turn work split, burst steps, and the activity line. Each
 * runs the v1 rule (`core/turns/segments`) on the blocks' v1 parts and maps the answer back
 * to the blocks, so the two layers agree (`oracle.test.ts`). `segments.test.ts` holds the
 * block-native cases.
 */
import type { Part } from '../../runtime/runtime-types';
import { toToolView } from '../../turns/classify';
import { isToolPart } from '../../turns/parts';
import { mergeBurstSteps, type BurstStep } from '../../turns/segments/merge-steps';
import type { StepFamily } from '../../turns/segments/narration';
import { segmentTurn, type SegmentTurnOptions } from '../../turns/segments/segment-turn';
import { isQuestionTool } from '../../turns/segments/session-activity-groups';
import { groupShowSegments, type ShowGroupedSegment } from '../../turns/segments/show-group';
import { stepLabel } from '../../turns/segments/step-label';
import { splitTurnWork } from '../../turns/segments/work-split';
import { getTurnStatus } from '../../turns/state';
import { parseQuestionAnswersFromOutput } from '../../turns/tools/question-helpers';
import type { SessionLogBlock, SessionLogMessage, TextBlock, ToolCallBlock } from '../types';
import type { LogTurn } from './turn';
import { blockOf, messageOfBlock, partOf, partsOf, v1RowsOf } from './v1-parts';

export type LogSegment =
  | { kind: 'burst'; blocks: SessionLogBlock[] }
  | { kind: 'text'; block: TextBlock }
  | { kind: 'standalone'; block: ToolCallBlock }
  /** Two or more adjacent `show` calls, one carousel. */
  | { kind: 'show-group'; blocks: ToolCallBlock[] };

export type { SegmentTurnOptions as LogSegmentOptions };

export interface LogTurnWorkSplit {
  /** Folded behind the "Worked for" row. Never empty. */
  work: LogSegment[];
  /** The `show` deliverables, in call order. */
  hoisted: LogSegment[];
  /** The final text segment, or empty when the turn did not end on text. */
  final: LogSegment[];
}

export type LogBurstStep =
  | { kind: 'thought'; key: string; texts: string[]; running: boolean; durationMs?: number }
  | { kind: 'block'; key: string; block: SessionLogBlock }
  | { kind: 'group'; key: string; blocks: ToolCallBlock[]; family: StepFamily; label: string; status: 'running' | 'error' | 'done'; durationMs?: number };

const call = (p: object) => blockOf(p) as ToolCallBlock;

/** The segments of a turn's blocks: a burst is a run of non-text blocks, closed by a text block; `show` and sub-agent calls stand alone. */
export function logTurnSegments(blocks: ReadonlyArray<SessionLogBlock>, options: SegmentTurnOptions = {}): LogSegment[] {
  return groupShowSegments(segmentTurn(partsOf(blocks), options), options).map((s) =>
    s.kind === 'burst' ? { kind: s.kind, blocks: s.parts.map(blockOf) }
    : s.kind === 'show-group' ? { kind: s.kind, blocks: s.parts.map(call) }
    : s.kind === 'text' ? { kind: s.kind, block: blockOf(s.part) as TextBlock }
    : { kind: s.kind, block: call(s.part) },
  );
}

const v1Segment = (s: LogSegment): ShowGroupedSegment =>
  s.kind === 'burst' || s.kind === 'show-group' ? ({ kind: s.kind, parts: partsOf(s.blocks) } as ShowGroupedSegment) : ({ kind: s.kind, part: partOf(s.block) } as ShowGroupedSegment);

/** The settled-turn fold of `segments`: `null` while the turn works, or when it has no work to fold. */
export function splitLogTurnWork(segments: ReadonlyArray<LogSegment>, options: { working: boolean }): LogTurnWorkSplit | null {
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
export function logBurstSteps(blocks: ReadonlyArray<SessionLogBlock>): LogBurstStep[] {
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
export function logActivityText(turn: Pick<LogTurn, 'blocks'>, childMessages?: readonly SessionLogMessage[]): string {
  return getTurnStatus(partsOf(turn.blocks).map((part) => ({ part })), childMessages?.flatMap(v1RowsOf));
}
