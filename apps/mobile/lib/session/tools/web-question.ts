/**
 * Pure logic behind `components/session/tool/tools/question-tool.tsx`.
 *
 * Ported from apps/web `tool/tools/question-tool.tsx`: the questions read off
 * the input, the answers (metadata first, then the `"q"="a"` output pairs via
 * `@kortix/sdk` `parseQuestionAnswersFromOutput`), and the trigger — the
 * waiting shimmer while the question is open, the single answer as subtitle,
 * "N of M answered" and an `N/M` badge for several questions.
 */

import { parseQuestionAnswersFromOutput, type ParsedQuestion } from '@kortix/sdk';

export function parseQuestionsInput(raw: unknown): ParsedQuestion[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((q: any) => {
    if (!q || typeof q !== 'object') return [];
    return [
      {
        question: typeof q.question === 'string' ? q.question : '',
        header: typeof q.header === 'string' ? q.header : undefined,
        options: Array.isArray(q.options)
          ? q.options.flatMap((o: any) =>
              o && typeof o.label === 'string'
                ? [{ label: o.label, description: typeof o.description === 'string' ? o.description : undefined }]
                : [],
            )
          : [],
      },
    ];
  });
}

export function resolveQuestionAnswers(metadataAnswers: unknown, output: string, count: number): string[][] {
  if (Array.isArray(metadataAnswers) && metadataAnswers.length > 0) return metadataAnswers as string[][];
  return parseQuestionAnswersFromOutput(output, count) ?? [];
}

export function questionFallbackLabel(question: ParsedQuestion, index: number): string {
  return question.header?.trim() || `Question ${index + 1}`;
}

export interface QuestionTriggerModel {
  label: 'Question' | 'Questions';
  /** The question is still open: "Waiting for your answer" shimmers. */
  waiting: boolean;
  subtitle: string | undefined;
  badge: string | undefined;
}

export function questionTrigger({
  total,
  answers,
  hasActiveQuestion,
}: {
  total: number;
  answers: string[][];
  hasActiveQuestion: boolean;
}): QuestionTriggerModel {
  const single = total === 1;
  const label = single ? 'Question' : 'Questions';
  if (hasActiveQuestion) return { label, waiting: true, subtitle: undefined, badge: undefined };

  const answeredCount = answers.filter((a) => a && a.length > 0).length;
  const badge = !single && total > 0 && answeredCount > 0 ? `${answeredCount}/${total}` : undefined;
  let subtitle: string | undefined;
  if (single && answers[0]?.length) subtitle = answers[0].join(', ');
  else if (!single && total && answeredCount > 0 && answeredCount < total) {
    subtitle = `${answeredCount} of ${total} answered`;
  }
  return { label, waiting: false, subtitle, badge };
}
