'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import Loading from '@/components/ui/loading';
import { errorToast } from '@/components/ui/toast';
import { cn } from '@/lib/utils';
import { coerceElicitationAnswers, type AcpPendingQuestion } from '@kortix/sdk';
import { Check, MessageCircleQuestion, X } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useState } from 'react';

/** Derives card swap animation variants based on motion preferences.
 *  When motion is reduced, uses opacity-only cross-fade. Otherwise, uses
 *  the full blur/scale/opacity spring treatment. `bounce: 0` keeps it calm. */
export function cardSwapVariants(reduced: boolean) {
  if (reduced) {
    return {
      initial: { opacity: 0 },
      animate: { opacity: 1 },
      exit: { opacity: 0 },
      transition: { type: 'spring', duration: 0.3, bounce: 0 },
    } as const;
  }
  return {
    initial: { opacity: 0, scale: 0.98, filter: 'blur(4px)' },
    animate: { opacity: 1, scale: 1, filter: 'blur(0px)' },
    exit: { opacity: 0, scale: 0.98, filter: 'blur(4px)' },
    transition: { type: 'spring', duration: 0.3, bounce: 0 },
  } as const;
}

/** Hook to get the appropriate card swap motion props based on prefers-reduced-motion. */
function useCardSwapMotion() {
  const reduceMotion = useReducedMotion() ?? false;
  return cardSwapVariants(reduceMotion);
}

/** Compact record row a card settles into once answered — shared shell for
 *  both permission and question cards. `tone === 'negative'` (rejected /
 *  dismissed) tints the tile `kortix-red`; anything else (including the
 *  unattributable "resolved elsewhere" reading) reads as `kortix-green`. */
function AnsweredRow({ tone, label, testId }: { tone: 'positive' | 'negative'; label: string; testId?: string }) {
  const motionProps = useCardSwapMotion();
  return (
    <motion.div key="answered" {...motionProps} data-testid={testId} className="bg-popover flex items-center gap-3 rounded-md border px-4 py-2">
      <span className={cn('flex size-9 items-center justify-center rounded-sm', tone === 'negative' ? 'bg-kortix-red/15' : 'bg-kortix-green/15')}>
        {tone === 'negative' ? <X className="size-5 text-kortix-red" /> : <Check className="size-5 text-kortix-green" />}
      </span>
      <span className="text-muted-foreground min-w-0 truncate text-xs">{label}</span>
    </motion.div>
  );
}

export function AcpQuestionCard({
  request,
  pending,
  onSubmit,
  onReject,
}: {
  request: AcpPendingQuestion;
  pending: boolean;
  onSubmit: (answers: Record<string, unknown>) => Promise<void>;
  onReject: () => Promise<void>;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [inFlight, setInFlight] = useState<'submit' | 'reject' | null>(null);
  const [outcome, setOutcome] = useState<'answered' | 'dismissed' | null>(null);
  const motionProps = useCardSwapMotion();

  const keys = request.questions.map((question, index) => question.key ?? `answer_${index + 1}`);
  const complete = keys.every((key) => Boolean(answers[key]?.trim()));

  const submit = async () => {
    if (!complete || inFlight !== null) return;
    setInFlight('submit');
    try {
      const rawAnswers = Object.fromEntries(keys.map((key) => [key, answers[key]!.trim()]));
      await onSubmit(coerceElicitationAnswers(rawAnswers, request.params));
      setOutcome('answered');
    } catch {
      errorToast('The response didn\'t reach the agent. Try again.');
    } finally {
      setInFlight(null);
    }
  };

  const reject = async () => {
    if (inFlight !== null) return;
    setInFlight('reject');
    try {
      await onReject();
      setOutcome('dismissed');
    } catch {
      errorToast('The response didn\'t reach the agent. Try again.');
    } finally {
      setInFlight(null);
    }
  };

  // Same answered-inference rule as `AcpPermissionCard`: `pending===false`
  // with no local `outcome` means this card never observed which way it
  // resolved (another tab / a reload) — "Answered" is already a neutral
  // reading, so no extra "resolved" wording is needed here.
  const answered = !pending || outcome !== null;

  return (
    <AnimatePresence initial={false} mode="popLayout">
      {answered ? (
        <AnsweredRow tone={outcome === 'dismissed' ? 'negative' : 'positive'} label={outcome === 'dismissed' ? 'Dismissed' : 'Answered'} />
      ) : (
        <motion.form
          key="pending"
          {...motionProps}
          className="bg-popover space-y-3 rounded-md border px-4 py-3"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <div className="mb-1 flex items-center gap-3">
            <span className="bg-kortix-yellow/15 flex size-9 items-center justify-center rounded-sm">
              <MessageCircleQuestion className="text-kortix-yellow size-5" />
            </span>
            <div className="min-w-0">
              <div className="text-sm font-medium">Input requested</div>
            </div>
          </div>
          {request.questions.map((question, index) => {
            const key = keys[index]!;
            return (
              <div key={key} className="space-y-2">
                <div className="text-sm">{question.question}</div>
                {question.options.length ? (
                  <div className="flex flex-wrap gap-2">
                    {question.options.map((option) => {
                      const value = String(option.value ?? option.optionId ?? option.id ?? option.label);
                      return (
                        <Button
                          key={value}
                          type="button"
                          size="sm"
                          variant={answers[key] === value ? 'secondary' : 'outline'}
                          disabled={inFlight !== null}
                          className="active:scale-[0.97]"
                          onClick={() => setAnswers((current) => ({ ...current, [key]: value }))}
                        >
                          {option.label}
                        </Button>
                      );
                    })}
                  </div>
                ) : (
                  <Input
                    value={answers[key] ?? ''}
                    disabled={inFlight !== null}
                    onChange={(event) => setAnswers((current) => ({ ...current, [key]: event.target.value }))}
                    placeholder="Type your answer"
                  />
                )}
              </div>
            );
          })}
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={!complete || inFlight !== null} className="active:scale-[0.97]">
              {inFlight === 'submit' ? <Loading className="size-3.5 shrink-0" /> : null}
              Submit
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={inFlight !== null} className="active:scale-[0.97]" onClick={() => void reject()}>
              {inFlight === 'reject' ? <Loading className="size-3.5 shrink-0" /> : null}
              Dismiss
            </Button>
          </div>
        </motion.form>
      )}
    </AnimatePresence>
  );
}
