/**
 * Pure rules for `QuestionPrompt` (components/session/QuestionPrompt.tsx).
 *
 * The prompt shows one question at a time. A step's answer is the picked
 * options plus the typed text: a single-choice question keeps only one (the
 * typed text wins over a pick), a multi-choice question keeps both.
 */
import type { QuestionAnswer, QuestionInfo } from '@/lib/opencode/types';

/** The answer a step sends when the user moves past it. */
export function questionStepAnswer(
  question: QuestionInfo,
  picked: QuestionAnswer,
  draft: string,
): QuestionAnswer {
  const typed = question.custom === false ? '' : draft.trim();
  if (!question.multiple) return typed ? [typed] : picked.slice(0, 1);
  return typed && !picked.includes(typed) ? [...picked, typed] : [...picked];
}

/** Picks an option: single-choice replaces the answer, multi-choice toggles it. */
export function pickQuestionOption(
  question: QuestionInfo,
  picked: QuestionAnswer,
  label: string,
): QuestionAnswer {
  if (!question.multiple) return [label];
  return picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label];
}

/** "2 of 3" for a multi-question request, null for a single question. */
export function questionStepLabel(step: number, total: number): string | null {
  return total > 1 ? `${step + 1} of ${total}` : null;
}
