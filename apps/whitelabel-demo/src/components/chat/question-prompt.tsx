'use client';

/**
 * Renders a pending agent QUESTION (possibly several at once) and sends the
 * answer. Without this, a session that asks a clarifying question blocks forever.
 * `replyToQuestion(requestId, answers)` unblocks the run; answers is a 2D array
 * of selected option labels (or freetext) per question. `onResolved` drops it
 * from the pending store; `onCancel` aborts the run instead of answering.
 */

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { replyToQuestion } from '@kortix/sdk/react';
import { MessageCircleQuestion, X } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type AnyQuestion = Record<string, any>;

export function QuestionPrompt({
  request,
  onResolved,
  onCancel,
}: {
  request: Record<string, any>;
  onResolved: () => void;
  onCancel: () => void;
}) {
  const questions: AnyQuestion[] = request.questions ?? [];
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));
  const [custom, setCustom] = useState<string[]>(() => questions.map(() => ''));
  const [sending, setSending] = useState(false);

  const answerFor = (i: number) =>
    selected[i].length ? selected[i] : custom[i].trim() ? [custom[i].trim()] : [];
  const allAnswered = questions.every((_, i) => answerFor(i).length > 0);
  const autoSingle = questions.length === 1 && !questions[0]?.multiple && !questions[0]?.custom;

  function pick(qi: number, label: string, multiple: boolean) {
    setSelected((prev) => {
      const next = prev.map((a) => [...a]);
      next[qi] = multiple
        ? next[qi].includes(label)
          ? next[qi].filter((l) => l !== label)
          : [...next[qi], label]
        : [label];
      return next;
    });
  }

  async function submit(answers: string[][]) {
    if (sending) return;
    setSending(true);
    onResolved(); // hide immediately; SSE will also drop it
    try {
      await replyToQuestion(request.id, answers);
    } catch {
      toast.error('Could not send your answer');
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-brand/30 bg-brand/[0.06]">
      <div className="flex items-center gap-2 border-b border-brand/15 px-3 py-2">
        <MessageCircleQuestion className="size-4 text-brand" />
        <span className="flex-1 text-xs font-medium text-foreground">
          {questions.length > 1 ? `${questions.length} questions` : 'The agent has a question'}
        </span>
        <button
          type="button"
          onClick={onCancel}
          className="text-muted-foreground hover:text-foreground"
          aria-label="Cancel"
          title="Stop & cancel"
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div className="space-y-4 p-3">
        {questions.map((q, qi) => {
          const options: AnyQuestion[] = q.options ?? [];
          const multiple = !!q.multiple;
          return (
            <div key={qi} className="space-y-2">
              <p className="text-sm text-foreground">{q.question ?? q.header}</p>
              <div className="space-y-1.5">
                {options.map((opt, oi) => {
                  const picked = selected[qi].includes(opt.label);
                  return (
                    <button
                      key={oi}
                      type="button"
                      disabled={sending}
                      onClick={() => (autoSingle ? submit([[opt.label]]) : pick(qi, opt.label, multiple))}
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                        picked ? 'border-brand/60 bg-brand/10' : 'border-border bg-card hover:bg-accent',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 grid size-4 shrink-0 place-items-center border',
                          multiple ? 'rounded-[4px]' : 'rounded-full',
                          picked ? 'border-brand bg-brand text-brand-foreground' : 'border-border',
                        )}
                      >
                        {picked && <span className="size-1.5 rounded-full bg-current" />}
                      </span>
                      <span className="min-w-0">
                        <span className="block text-sm text-foreground">{opt.label}</span>
                        {opt.description && (
                          <span className="block text-xs text-muted-foreground">{opt.description}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
                {q.custom && (
                  <Input
                    value={custom[qi]}
                    disabled={sending}
                    placeholder="Type your own answer…"
                    onChange={(e) =>
                      setCustom((prev) => {
                        const next = [...prev];
                        next[qi] = e.target.value;
                        return next;
                      })
                    }
                    className="text-sm"
                  />
                )}
              </div>
            </div>
          );
        })}

        {!autoSingle && (
          <Button
            size="sm"
            disabled={!allAnswered || sending}
            onClick={() => submit(questions.map((_, i) => answerFor(i)))}
            className="w-full"
          >
            {sending ? 'Sending…' : 'Submit answer'}
          </Button>
        )}
      </div>
    </div>
  );
}
