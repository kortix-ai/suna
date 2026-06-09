'use client';

import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { ArrowUp, Paperclip } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { RiMicAiFill, RiRobot3Fill } from 'react-icons/ri';

export const HOME_PROMPT_MESSAGES = [
  'Ask kortix to do anything across your company…',
  "Summarize this week's pipeline updates…",
  'Draft a reply to the Slack thread in #sales…',
  'What changed in our repos since Monday?',
  'Run the weekly finance report and email the team…',
] as const;

const HOME_PROMPT_CYCLE_MS = 4000;

export function CyclingPromptText({ className }: { className?: string }) {
  const reduce = useReducedMotion();
  const [index, setIndex] = useState(0);

  useEffect(() => {
    if (reduce) return;
    const interval = window.setInterval(
      () => setIndex((i) => (i + 1) % HOME_PROMPT_MESSAGES.length),
      HOME_PROMPT_CYCLE_MS,
    );
    return () => window.clearInterval(interval);
  }, [reduce]);

  if (reduce) return <span className={className}>{HOME_PROMPT_MESSAGES[0]}</span>;

  return (
    <div aria-hidden className={cn('relative overflow-hidden', className)}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span
          key={index}
          className="absolute inset-x-0 top-0 block"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0, transition: { duration: 0.42, ease: [0.22, 1, 0.36, 1] } }}
          exit={{ opacity: 0, y: -8, transition: { duration: 0.48, ease: [0.2, 0, 0.1, 1] } }}
        >
          {HOME_PROMPT_MESSAGES[index]}
        </motion.span>
      </AnimatePresence>
    </div>
  );
}

export function Composer({
  variant,
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  variant: 'home' | 'reply';
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const showCycling = variant === 'home' && value.length === 0 && !focused;

  const submit = () => {
    if (disabled || value.trim().length === 0) return;
    onSubmit();
  };

  return (
    <div
      className={cn(
        'border-border bg-card rounded-[24px] border',
        variant === 'home' ? 'p-3' : 'p-2.5',
      )}
    >
      <div className={cn('relative', variant === 'home' && 'min-h-20 px-1')}>
        {showCycling && (
          <CyclingPromptText className="text-muted-foreground pointer-events-none absolute inset-x-1 top-0 text-sm" />
        )}
        <textarea
          rows={variant === 'home' ? 3 : 1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={variant === 'reply' ? 'Reply to kortix…' : ''}
          className="text-foreground placeholder:text-muted-foreground relative w-full resize-none bg-transparent text-sm outline-none"
        />
      </div>
      <div className="mt-1 flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground inline-flex size-7 items-center justify-center rounded-sm">
            <Paperclip className="size-3.5" />
          </span>
          {variant === 'home' && (
            <>
              <span className="text-foreground inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs">
                <RiRobot3Fill className="size-3.5" /> kortix
              </span>
              <span className="text-muted-foreground hidden h-7 items-center gap-1.5 rounded-full px-2.5 text-xs sm:inline-flex">
                <Icon.Claude className="size-3.5" />
                Claude Opus 4.8
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground inline-flex size-7 items-center justify-center">
            <RiMicAiFill className="size-3.5" />
          </span>
          <button
            type="button"
            aria-label="Send"
            onClick={submit}
            disabled={disabled || value.trim().length === 0}
            className="bg-foreground text-background inline-flex size-7 items-center justify-center rounded-full transition-opacity disabled:opacity-40"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
