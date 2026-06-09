'use client';

import { Icon } from '@/features/icon/icon';
import { cn } from '@/lib/utils';
import { ArrowUp, Paperclip } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState } from 'react';
import { RiMicAiFill, RiRobot3Fill } from 'react-icons/ri';
import { SCENARIOS } from './scenarios';
import { KortixLogo } from '@/components/sidebar/kortix-logo';

/** Clickable demo prompts — each maps to a scripted scenario. */
export const DEMO_PROMPTS = SCENARIOS.map((s) => s.prompt);

export const HOME_PROMPT_MESSAGES = [
  'Ask kortix to do anything across your company…',
  ...DEMO_PROMPTS,
] as const;

function DemoPromptChips({
  onPick,
  disabled,
}: {
  onPick: (prompt: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex overflow-x-auto gap-1.5">
      {SCENARIOS.slice(0, 2).map((s) => (
        <button
          key={s.id}
          type="button"
          disabled={disabled}
          onClick={() => onPick(s.prompt)}
          className="border-border/60 bg-muted/30 hover:bg-muted/50 text-muted-foreground hover:text-foreground rounded-full border px-3 py-1 text-xs transition-colors disabled:opacity-40"
        >
          {s.prompt}
        </button>
      ))}
    </div>
  );
}

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
  onPromptPick,
  disabled,
}: {
  variant: 'home' | 'reply';
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  /** Home variant — clicking a demo chip fires this with the full prompt. */
  onPromptPick?: (prompt: string) => void;
  disabled?: boolean;
}) {
  const [focused, setFocused] = useState(false);
  const showCycling = variant === 'home' && value.length === 0 && !focused;

  const submit = () => {
    if (disabled || value.trim().length === 0) return;
    onSubmit();
  };

  const showPromptChips = variant === 'home' && onPromptPick && !disabled;

  return (
    <div className="w-full space-y-2">
      {showPromptChips && <DemoPromptChips onPick={onPromptPick} disabled={disabled} />}
      <div
        className={cn(
          'border-border bg-card w-full rounded-xl border',
          variant === 'home' ? 'p-3' : 'p-2.5',
        )}
      >
        <div className={cn('relative', variant === 'home' && 'min-h-12 px-1')}>
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
            placeholder={
              variant === 'reply' ? 'Reply to kortix…' : 'Describe a task to start a session…'
            }
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
                  <KortixLogo size={12} /> kortix
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
    </div>
  );
}
