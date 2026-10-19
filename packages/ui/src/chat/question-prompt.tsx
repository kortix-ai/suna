'use client';

/**
 * A pending agent QUESTION (one or several) and its answer. Without it a
 * session that asks a clarifying question blocks forever. `onAnswer` is
 * `session.answerQuestion`: it drops the question only once the server
 * accepted the reply, so a failed submit stays visible for a retry.
 * `onCancel` stops the run instead of answering.
 */

import { ChatCircleDotsIcon, XIcon } from '@phosphor-icons/react';
import type { QuestionRequest } from '@kortix/sdk';
import { useState } from 'react';

import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { cn } from '../lib/utils';
import { useUiStrings } from '../providers/ui-provider';
import { type ChatErrorHandler, errorMessage } from './permission-prompt';

export function QuestionPrompt({
  request,
  onAnswer,
  onCancel,
  onError,
}: {
  request: QuestionRequest;
  onAnswer: (requestId: string, answers: string[][]) => Promise<void>;
  onCancel: () => void;
  onError?: ChatErrorHandler;
}) {
  const t = useUiStrings().chat;
  const questions = request.questions;
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ''));
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const answerFor = (i: number) =>
    selected[i].length ? selected[i] : custom[i].trim() ? [custom[i].trim()] : [];
  const allAnswered = questions.every((_, i) => answerFor(i).length > 0);
  // One single-choice question with no free text: a click on an option sends it.
  const autoSingle = questions.length === 1 && !questions[0]?.multiple && !questions[0]?.custom;

  function pick(qi: number, label: string, multiple: boolean) {
    setSelected((prev) => {
      const next = prev.map((a) => [...a]);
      const has = next[qi].includes(label);
      next[qi] = multiple ? (has ? next[qi].filter((l) => l !== label) : [...next[qi], label]) : [label];
      return next;
    });
  }

  async function submit(answers: string[][]) {
    if (sending) return;
    setSending(true);
    setError(null);
    try {
      await onAnswer(request.id, answers);
    } catch (err) {
      const message = errorMessage(err, t.answerFailed);
      if (onError) onError(message, err);
      else setError(message);
      setSending(false);
    }
  }

  return (
    <div data-slot="question-prompt" className="border-border bg-card overflow-hidden rounded-md border">
      <div className="border-border flex items-center gap-2 border-b px-3 py-2">
        <ChatCircleDotsIcon className="text-muted-foreground size-4" />
        <span className="text-foreground flex-1 text-xs font-medium">
          {questions.length > 1 ? t.questionsTitle(questions.length) : t.questionTitle}
        </span>
        <Button
          type="button"
          onClick={onCancel}
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground"
          aria-label={t.stopAndCancel}
        >
          <XIcon className="size-3.5" />
        </Button>
      </div>

      <div className="space-y-4 p-3">
        {questions.map((q, qi) => {
          const multiple = !!q.multiple;
          return (
            <div key={qi} className="space-y-2">
              <p className="text-foreground text-sm">{q.question}</p>
              <div className="space-y-1.5" role={multiple ? 'group' : 'radiogroup'}>
                {q.options.map((opt, oi) => {
                  const picked = selected[qi].includes(opt.label);
                  return (
                    <Button
                      key={oi}
                      type="button"
                      variant="outline"
                      role={multiple ? 'checkbox' : 'radio'}
                      aria-checked={picked}
                      disabled={sending}
                      onClick={() => (autoSingle ? submit([[opt.label]]) : pick(qi, opt.label, multiple))}
                      className={cn(
                        'h-auto w-full items-start justify-start gap-2.5 px-3 py-2 text-left whitespace-normal',
                        picked && 'border-foreground bg-muted',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 grid size-4 shrink-0 place-items-center border',
                          multiple ? 'rounded-sm' : 'rounded-full',
                          picked ? 'border-foreground bg-foreground text-background' : 'border-border',
                        )}
                      >
                        {picked && <span className="size-1.5 rounded-full bg-current" />}
                      </span>
                      <span className="min-w-0">
                        <span className="text-foreground block text-sm">{opt.label}</span>
                        {opt.description && (
                          <span className="text-muted-foreground block text-xs">{opt.description}</span>
                        )}
                      </span>
                    </Button>
                  );
                })}
                {q.custom && (
                  <Input
                    value={custom[qi]}
                    disabled={sending}
                    placeholder={t.customAnswerPlaceholder}
                    aria-label={t.customAnswerLabel}
                    onChange={(e) =>
                      setCustom((prev) => prev.map((v, i) => (i === qi ? e.target.value : v)))
                    }
                  />
                )}
              </div>
            </div>
          );
        })}

        {error && (
          <p role="alert" className="text-foreground text-xs">
            {error}
          </p>
        )}

        {!autoSingle && (
          <Button
            size="sm"
            disabled={!allAnswered || sending}
            onClick={() => submit(questions.map((_, i) => answerFor(i)))}
            className="w-full"
          >
            {sending ? t.sending : t.submitAnswer}
          </Button>
        )}
      </div>
    </div>
  );
}
