'use client';

/**
 * Renders a pending agent QUESTION and sends the answer. Without this, a session
 * that asks the user a clarifying question blocks forever (status stays busy).
 * `replyToQuestion(requestId, answers)` unblocks the run; answers is a 2D array
 * (selected option labels per question).
 */

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { replyToQuestion } from '@kortix/sdk/react';
import { MessageCircleQuestion } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';

type AnyQuestion = Record<string, any>;

export function QuestionPrompt({ request }: { request: Record<string, any> }) {
  const questions: AnyQuestion[] = request.questions ?? [];
  const [selected, setSelected] = useState<string[][]>(() => questions.map(() => []));
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  const allAnswered = questions.every((q, i) => (q.custom ? true : selected[i].length > 0));

  function pick(qi: number, label: string, multiple: boolean) {
    setSelected((prev) => {
      const next = prev.map((a) => [...a]);
      if (multiple) {
        next[qi] = next[qi].includes(label)
          ? next[qi].filter((l) => l !== label)
          : [...next[qi], label];
      } else {
        next[qi] = [label];
      }
      return next;
    });
  }

  async function submit(answers: string[][]) {
    if (sending || done) return;
    setSending(true);
    setDone(true); // hide immediately; SSE will also drop it from the store
    try {
      await replyToQuestion(request.id, answers);
    } catch {
      toast.error('Could not send your answer');
      setDone(false);
    } finally {
      setSending(false);
    }
  }

  if (done) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-brand/30 bg-brand/[0.06]">
      <div className="flex items-center gap-2 border-b border-brand/15 px-3 py-2">
        <MessageCircleQuestion className="size-4 text-brand" />
        <span className="text-xs font-medium text-foreground">
          {questions.length > 1 ? `${questions.length} questions` : 'The agent has a question'}
        </span>
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
                  const single = questions.length === 1 && !multiple;
                  return (
                    <button
                      key={oi}
                      type="button"
                      disabled={sending}
                      onClick={() =>
                        single
                          ? submit([[opt.label]])
                          : pick(qi, opt.label, multiple)
                      }
                      className={cn(
                        'flex w-full items-start gap-2.5 rounded-lg border px-3 py-2 text-left transition-colors',
                        picked
                          ? 'border-brand/60 bg-brand/10'
                          : 'border-border bg-card hover:bg-accent',
                      )}
                    >
                      <span
                        className={cn(
                          'mt-0.5 grid size-4 shrink-0 place-items-center rounded border',
                          picked ? 'border-brand bg-brand text-brand-foreground' : 'border-border',
                          multiple ? 'rounded-[4px]' : 'rounded-full',
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
              </div>
            </div>
          );
        })}

        {!(questions.length === 1 && !questions[0]?.multiple) && (
          <Button
            size="sm"
            disabled={!allAnswered || sending}
            onClick={() => submit(selected)}
            className="w-full"
          >
            {sending ? 'Sending…' : 'Submit answer'}
          </Button>
        )}
      </div>
    </div>
  );
}
