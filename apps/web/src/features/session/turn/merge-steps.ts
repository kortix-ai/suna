/**
 * Burst parts → the rows a reader actually sees.
 *
 * Two rules, both about reducing the row count rather than the information:
 *
 *   1. Plumbing never appears. Memory reads/writes and context compaction are
 *      machinery the reader did not ask for and cannot act on.
 *   2. A run of consecutive thinking collapses into ONE row. The model emits
 *      reasoning in fragments; rendering a row per fragment turns a single
 *      train of thought into a wall of near-identical lines.
 *
 * No React import — every rule here is unit-tested.
 */

import { isReasoningPart, type Part } from '@/ui';
import type { StepTier } from './step-label';

export type BurstStep =
  { kind: 'thought'; key: string; texts: string[] } | { kind: 'part'; key: string; part: Part };

/**
 * `tierOf` is injected rather than imported so the merge rules can be tested
 * without dragging the whole tool-name table in behind them.
 */
export function mergeBurstSteps(
  parts: ReadonlyArray<Part>,
  tierOf: (part: Part) => StepTier,
): BurstStep[] {
  const steps: BurstStep[] = [];
  let pending: { key: string; texts: string[] } | null = null;

  const flush = () => {
    if (pending && pending.texts.length > 0) {
      steps.push({ kind: 'thought', key: pending.key, texts: pending.texts });
    }
    pending = null;
  };

  for (const part of parts) {
    // Machinery is dropped outright, and — importantly — without breaking the
    // thinking run around it. A memory write between two thoughts should not
    // split them into two rows.
    if (tierOf(part) === 'plumbing') continue;

    if (isReasoningPart(part)) {
      const text = (part as { text?: string }).text?.trim();
      if (!text) continue;
      if (!pending) pending = { key: `thought-${part.id}`, texts: [] };
      pending.texts.push(text);
      continue;
    }

    flush();
    steps.push({ kind: 'part', key: part.id, part });
  }

  flush();
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
  const joined = texts.map(stripMarkdown).filter(Boolean).join(' ').trim();

  if (!joined) return 'Thinking';
  if (ALREADY_THINKING.test(joined)) return joined;

  // Lower-case the lead-in so it reads as one sentence — but only when the
  // opening word is ordinary sentence case. Lowering "API" to "aPI" would be
  // worse than the capital it replaced.
  const isSentenceCased = /^[A-Z][a-z]/.test(joined);
  const body = isSentenceCased ? joined[0].toLowerCase() + joined.slice(1) : joined;
  return `Thinking about ${body}`;
}
