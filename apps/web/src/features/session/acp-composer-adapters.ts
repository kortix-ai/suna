/**
 * Pure adapters that translate protocol-native ACP shapes into the UI
 * primitives ported from main (`HarnessModelSelector`, `TodoChip`,
 * `QuestionPrompt`). Kept framework-free and colocated with tests so the
 * mapping rules stay honest as harnesses evolve — no React here.
 */

import type { AcpPendingOption, AcpPendingQuestion, AcpPlan, AcpSessionConfigOption } from '@kortix/sdk';
import type { QuestionAnswer, QuestionRequest } from '@/ui';

/** Heuristic: does this ACP session config option represent the model choice?
 *  There's no fixed `id`/`category` vocabulary across harness bridges yet, so
 *  match on any of them mentioning "model" — the same signal a human would use
 *  reading the option's own name. */
export function isAcpModelConfigOption(option: AcpSessionConfigOption): boolean {
  const haystack = `${option.id} ${option.category ?? ''} ${option.name ?? ''}`.toLowerCase();
  return /\bmodel\b/.test(haystack);
}

export function findAcpModelConfigOption(
  options: readonly AcpSessionConfigOption[],
): AcpSessionConfigOption | null {
  return options.find(isAcpModelConfigOption) ?? null;
}

/** `AcpSessionConfigOption.options` (generic `{value,label,...}` records) into
 *  the `{id,name,source}` preset shape `HarnessModelSelector` expects. */
export function acpConfigOptionPresets(
  option: AcpSessionConfigOption | null,
): Array<{ id: string; name: string; source: string }> {
  if (!option?.options?.length) return [];
  return option.options.map((raw, index) => {
    const record = raw as Record<string, unknown>;
    const id = String(record.value ?? record.id ?? record.optionId ?? index);
    const name = String(record.label ?? record.name ?? record.title ?? id);
    return { id, name, source: 'session' };
  });
}

/** ACP `session/update` plan entries into the `{id,content,status}` shape
 *  `TodoChip` renders. Entries are protocol-untyped (`unknown[]`), so this
 *  degrades gracefully for anything that isn't the expected object shape. */
export function acpTodosFromPlanEntries(
  entries: AcpPlan['entries'] | undefined,
): Array<{ id: string; content: string; status: string }> {
  if (!entries?.length) return [];
  return entries.map((entry, index) => {
    if (entry && typeof entry === 'object') {
      const record = entry as Record<string, unknown>;
      const content = record.content ?? record.title ?? record.text;
      return {
        id: String(record.id ?? index),
        content: typeof content === 'string' ? content : JSON.stringify(entry),
        status: typeof record.status === 'string' ? record.status : 'pending',
      };
    }
    return { id: String(index), content: String(entry), status: 'pending' };
  });
}

/** ACP's pending elicitation/question envelope into the harness-neutral
 *  `QuestionRequest` the ported `QuestionPrompt` chip already renders. */
export function toQuestionRequest(pending: AcpPendingQuestion, sessionId: string): QuestionRequest {
  return {
    id: String(pending.id),
    sessionID: sessionId,
    questions: pending.questions.map((question) => ({
      question: question.question,
      header: question.header,
      options: question.options.map((option) => ({
        label: option.label,
        description: option.description,
      })),
      // ACP's projection carries no multi-select signal today — every
      // question is single-select-or-type, matching the option data we get.
      multiple: false,
      custom: question.allowText !== false,
    })),
  };
}

function questionKey(pending: AcpPendingQuestion, index: number): string {
  return pending.questions[index]?.key ?? `answer_${index + 1}`;
}

/** `QuestionPrompt`'s `onReply(id, answers)` gives back one `string[]` of
 *  chosen option *labels* per question (labels double as values in that
 *  component). Map each chosen label back to the option's real `value`/
 *  `optionId` when the option is a known one, and build the
 *  `{ [key]: value }` content object `use-acp-session`'s `respondQuestion`
 *  sends as the ACP `action:'accept'` payload. */
export function buildAcpQuestionContent(
  pending: AcpPendingQuestion,
  answers: QuestionAnswer[],
): Record<string, unknown> {
  const content: Record<string, unknown> = {};
  pending.questions.forEach((question, index) => {
    const key = questionKey(pending, index);
    const chosen = answers[index] ?? [];
    const values = chosen.map((label) => {
      const match = question.options.find((option: AcpPendingOption) => option.label === label);
      return match?.value ?? match?.optionId ?? match?.id ?? label;
    });
    content[key] = values.length <= 1 ? (values[0] ?? '') : values;
  });
  return content;
}
