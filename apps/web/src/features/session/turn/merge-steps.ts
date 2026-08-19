/**
 * Burst parts → the rows a reader actually sees.
 *
 * Three rules, all about reducing the row count rather than the information:
 *
 *   1. Plumbing never appears. Memory reads/writes and context compaction are
 *      machinery the reader did not ask for and cannot act on.
 *   2. A run of consecutive thinking collapses into ONE row. The model emits
 *      reasoning in fragments; rendering a row per fragment turns a single
 *      train of thought into a wall of near-identical lines.
 *   3. A run of consecutive same-family tool calls collapses into ONE group
 *      row that opens to its members. Two reads and two commands are two pieces
 *      of work, not four; expanding a burst to seven flat siblings un-groups
 *      exactly what makes a 60-call run readable.
 *
 * A thought row also carries whether IT is the one still being written. That
 * cannot be answered by the burst around it: a trailing burst reports "running"
 * for the whole turn on purpose (so the disclosure does not blink shut between
 * SSE tool calls), so a burst-wide flag makes every thought a turn ever emitted
 * claim to be live — shimmering, and forcing its paragraph open, twenty steps
 * after it closed. See `reasoningIsRunning` and the settle pass at the end of
 * `mergeBurstSteps`.
 *
 * Rule 3 reuses `groupSteps` — the same model the Easy action panel renders
 * from — rather than restating the family table here. There is one grouping
 * implementation; two that must agree forever is the trap this avoids.
 *
 * No React import — every rule here is unit-tested.
 */

import { isReasoningPart, isToolPart, type Part, type ToolPart } from '@/ui';
import { groupSteps, type Step } from '../action-panel/shared/group-steps';
import type { StepTier } from './step-label';

export type BurstStep =
  | { kind: 'thought'; key: string; texts: string[]; running: boolean }
  | { kind: 'part'; key: string; part: Part }
  | { kind: 'group'; key: string; step: Step };

/**
 * True while the model is still writing this reasoning fragment.
 *
 * A closed reasoning block carries `time.end`; an open one has a start and
 * nothing else. Exported so `burstIsRunning` asks the same question in the same
 * words — two copies of this predicate is exactly how a burst and the rows
 * inside it end up disagreeing about who is still working.
 */
export function reasoningIsRunning(part: Part): boolean {
  const end = (part as { time?: { end?: number } }).time?.end;
  return !(typeof end === 'number' && end > 0);
}

/**
 * `tierOf` is injected rather than imported so the merge rules can be tested
 * without dragging the whole tool-name table in behind them.
 */
export function mergeBurstSteps(
  parts: ReadonlyArray<Part>,
  tierOf: (part: Part) => StepTier,
): BurstStep[] {
  const steps: BurstStep[] = [];
  let pending: { key: string; texts: string[]; running: boolean } | null = null;
  let tools: ToolPart[] = [];

  const flushThought = () => {
    if (pending && pending.texts.length > 0) {
      steps.push({
        kind: 'thought',
        key: pending.key,
        texts: pending.texts,
        running: pending.running,
      });
    }
    pending = null;
  };

  /**
   * The buffered run → its group rows, in order.
   *
   * A group of one is NOT wrapped. An expandable row holding a single call
   * hides that call behind a click and says nothing the call did not already
   * say — strictly worse than the flat row it replaced.
   */
  const flushTools = () => {
    if (tools.length === 0) return;
    for (const step of groupSteps(tools)) {
      steps.push(
        step.parts.length === 1
          ? { kind: 'part', key: step.parts[0].id, part: step.parts[0] }
          : { kind: 'group', key: `group-${step.parts[0].id}`, step },
      );
    }
    tools = [];
  };

  for (const part of parts) {
    // Machinery is dropped outright, and — importantly — without breaking the
    // run around it, thinking or tool. A memory write between two thoughts
    // should not split them into two rows, and one between two shells should
    // not split "Ran 2 commands" into two singles.
    if (tierOf(part) === 'plumbing') continue;

    if (isReasoningPart(part)) {
      // Read the text before flushing: an empty fragment renders nothing, so
      // it must not break the tool run it happens to sit inside either.
      const text = (part as { text?: string }).text?.trim();
      if (!text) continue;
      flushTools();
      if (!pending) pending = { key: `thought-${part.id}`, texts: [], running: false };
      pending.texts.push(text);
      // The LAST fragment decides. Fragments arrive one at a time and each
      // closes as the next opens, so an early `time.end` says nothing about
      // whether the run as a whole is still being written.
      pending.running = reasoningIsRunning(part);
      continue;
    }

    flushThought();

    if (isToolPart(part)) {
      tools.push(part);
      continue;
    }

    // Neither tool nor reasoning. `groupSteps` has no family for it and
    // `ActivityStep` renders it as a bare label row — but it is still a part,
    // and this module never silently drops one.
    flushTools();
    steps.push({ kind: 'part', key: part.id, part });
  }

  flushThought();
  flushTools();

  /**
   * Only the final row can still be live.
   *
   * `time.end` is the provider's answer and this is the structural one: the
   * model cannot call a tool and then keep writing the same reasoning block —
   * more reasoning after the tool arrives as a NEW row. So a thought with any
   * later step is finished, whatever its own timestamps say, and the rule holds
   * even against a provider that never writes `time.end` at all.
   *
   * Dropped plumbing is not a later step: it renders no row, so it is no
   * evidence the model stopped thinking.
   */
  for (let i = 0; i < steps.length - 1; i++) {
    const step = steps[i];
    if (step.kind === 'thought') step.running = false;
  }

  return steps;
}

/** Words that already announce a thought, so the prefix would double up. */
const ALREADY_THINKING =
  /^(thinking|thought|considering|planning|deciding|weighing|exploring|analy[sz]ing|reasoning|working out|figuring)/i;

/** Markdown that carries no meaning once the block becomes a single sentence. */
function stripMarkdown(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/(^|\s)[*_]([^*_]+)[*_]/g, '$1$2')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A run of thinking fragments → the one sentence the row shows.
 *
 * Fragments are joined, stripped of document markup, and given a "Thinking
 * about" lead-in — unless they already open with a thinking verb, where the
 * prefix would read as a stutter ("Thinking about thinking about…").
 */
export function flattenThought(texts: ReadonlyArray<string>): string {
  const joined = texts
    .flatMap((text) => {
      const stripped = stripMarkdown(text);
      return stripped ? [stripped] : [];
    })
    .join(' ')
    .trim();

  if (!joined) return 'Thinking';
  if (ALREADY_THINKING.test(joined)) return joined;

  // Lower-case the lead-in so it reads as one sentence — but only when the
  // opening word is ordinary sentence case. Lowering "API" to "aPI" would be
  // worse than the capital it replaced.
  const isSentenceCased = /^[A-Z][a-z]/.test(joined);
  const body = isSentenceCased ? joined[0].toLowerCase() + joined.slice(1) : joined;
  return `Thinking about ${body}`;
}
