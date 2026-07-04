'use client';

import { UnifiedMarkdown } from '@/components/markdown/unified-markdown';
import { TextShimmer } from '@/components/ui/text-shimmer';
import {
  BasicTool,
  MD_FLUSH_CLASSES,
  partInput,
  partMetadata,
  partOutput,
  ToolEmptyState,
} from '@/features/session/tool/shared/infrastructure';
import {
  type ParsedQuestion,
  parseQuestionAnswersFromOutput,
} from '@/features/session/tool/shared/question-helpers';
import { ToolRegistry } from '@/features/session/tool/shared/registry';
import type { ToolProps } from '@/features/session/tool/shared/types';
import { cn } from '@/lib/utils';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';

function AnswerText({
  answers,
  options,
}: {
  answers: string[];
  options: ParsedQuestion['options'];
}) {
  if (answers.length === 0) {
    return <p className="text-muted-foreground text-xs">—</p>;
  }

  return (
    <div className="space-y-0.5">
      {answers.map((label) => {
        const opt = options.find((o) => o.label === label);
        return (
          <p key={label} className="text-foreground text-xs leading-snug">
            <span className="font-medium">{label}</span>
            {opt?.description ? (
              <span className="text-muted-foreground ml-1">{opt.description}</span>
            ) : null}
          </p>
        );
      })}
    </div>
  );
}

function QuestionAnswerBlock({
  question,
  index,
  answers,
}: {
  question: ParsedQuestion;
  index: number;
  answers: string[];
}) {
  const fallback = question.header?.trim() || `Question ${index + 1}`;

  return (
    <div className="space-y-1.5">
      <div className={cn('text-foreground/80 text-xs text-pretty', MD_FLUSH_CLASSES)}>
        <UnifiedMarkdown content={question.question || question.header || fallback} />
      </div>
      <AnswerText answers={answers} options={question.options} />
    </div>
  );
}

export function QuestionTool({
  part,
  defaultOpen,
  forceOpen,
  locked,
  hasActiveQuestion,
}: ToolProps) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const input = partInput(part);
  const metadata = partMetadata(part);
  const output = partOutput(part);

  const questions = useMemo<ParsedQuestion[]>(() => {
    const raw = Array.isArray(input.questions) ? input.questions : [];
    return raw.flatMap((q: any) => {
      if (!q || typeof q !== 'object') return [];
      return [
        {
          question: typeof q.question === 'string' ? q.question : '',
          header: typeof q.header === 'string' ? q.header : undefined,
          options: Array.isArray(q.options)
            ? q.options.flatMap((o: any) =>
                o && typeof o.label === 'string'
                  ? [
                      {
                        label: o.label,
                        description: typeof o.description === 'string' ? o.description : undefined,
                      },
                    ]
                  : [],
              )
            : [],
        },
      ];
    });
  }, [input.questions]);

  const answers = useMemo<string[][]>(() => {
    if (Array.isArray(metadata.answers) && metadata.answers.length > 0) {
      return metadata.answers as string[][];
    }
    return parseQuestionAnswersFromOutput(output, questions.length) ?? [];
  }, [metadata.answers, output, questions.length]);

  const total = questions.length;
  const answeredCount = answers.filter((a) => a && a.length > 0).length;
  const single = total === 1;

  const triggerBadge =
    !single && total > 0 && answeredCount > 0 ? `${answeredCount}/${total}` : undefined;

  const subtitle = (() => {
    if (hasActiveQuestion) return undefined;
    if (single && answers[0]?.length) return answers[0].join(', ');
    if (!single && total && answeredCount > 0 && answeredCount < total) {
      return `${answeredCount} of ${total} answered`;
    }
    return undefined;
  })();

  const trigger = hasActiveQuestion ? (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="text-foreground text-xs font-medium whitespace-nowrap">
        {single ? 'Question' : 'Questions'}
      </span>
      <TextShimmer duration={1} spread={2} className="text-xs italic">
        Waiting for your answer
      </TextShimmer>
    </div>
  ) : (
    <div className="flex min-w-0 flex-1 items-center gap-1.5">
      <span className="text-foreground text-xs font-medium whitespace-nowrap">
        {single ? 'Question' : 'Questions'}
      </span>
      {subtitle ? (
        <span className="text-muted-foreground min-w-0 truncate text-xs font-medium">
          {subtitle}
        </span>
      ) : null}
      {triggerBadge ? (
        <span className="text-primary/70 ml-auto shrink-0 text-xs font-medium whitespace-nowrap tabular-nums">
          {triggerBadge}
        </span>
      ) : null}
    </div>
  );

  return (
    <BasicTool trigger={trigger} defaultOpen={defaultOpen} forceOpen={forceOpen} locked={locked}>
      {total > 0 ? (
        <div data-scrollable className="space-y-3 overflow-auto">
          {questions.map((q, i) => (
            <div key={i} className={cn(i > 0 && 'border-border border-t pt-3')}>
              <QuestionAnswerBlock question={q} index={i} answers={answers[i] ?? []} />
            </div>
          ))}
        </div>
      ) : (
        <ToolEmptyState
          message={tI18nHardcoded.raw(
            'autoFeaturesSessionToolRenderersJsxAttrMessageNoQuestions511286a8',
          )}
        />
      )}
    </BasicTool>
  );
}
ToolRegistry.register('question', QuestionTool);
ToolRegistry.register('ask', QuestionTool);
