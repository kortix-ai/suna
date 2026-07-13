'use client';

/**
 * `ProgressView` — the Easy-mode home's full-height drill-in for the
 * Progress card. A plain-language list of what the agent did; tapping any
 * row expands the real tool view underneath (see `StepRow`).
 *
 * Rows stagger in ~20ms apart, but ONLY on the very first paint —
 * `hasAnimatedRef` flips true right after mount and never resets, so a step
 * streamed in later (mid-run) just appears in place instead of re-triggering
 * the whole list's entrance animation, which would be nauseating.
 */

import { Button } from '@/components/ui/button';
import { ChevronLeft } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { useEffect, useRef, useState } from 'react';
import type { Step } from '../shared/group-steps';
import { StepRow } from './step-row';

export function ProgressView({
  steps,
  sessionId,
  onBack,
  focusStepId,
}: {
  steps: Step[];
  sessionId: string;
  onBack: () => void;
  /** Step to auto-expand and scroll to (set when a tool call is clicked in chat). */
  focusStepId?: string;
}) {
  const reduce = useReducedMotion();
  const [expandedId, setExpandedId] = useState<string | null>(focusStepId ?? null);
  const hasAnimatedRef = useRef(false);
  const focusRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    hasAnimatedRef.current = true;
  }, []);

  useEffect(() => {
    if (!focusStepId) return;
    setExpandedId(focusStepId);
    focusRef.current?.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
  }, [focusStepId, reduce]);

  const stagger = !reduce && !hasAnimatedRef.current;

  return (
    <div className="flex h-full min-w-0 flex-col">
      <div className="border-border flex shrink-0 items-center gap-1 border-b px-2 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          onClick={onBack}
          aria-label="Back"
          className="hit-area-2 active:scale-[0.96]"
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="text-foreground truncate text-sm font-semibold">Progress</span>
      </div>

      <div className="min-h-0 min-w-0 flex-1 overflow-auto">
        {steps.map((step, i) => (
          <motion.div
            key={step.id}
            ref={step.id === focusStepId ? focusRef : undefined}
            initial={stagger ? { opacity: 0, y: 4 } : false}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.18, ease: 'easeOut', delay: stagger ? i * 0.02 : 0 }}
          >
            <StepRow
              step={step}
              sessionId={sessionId}
              expanded={expandedId === step.id}
              onToggle={() => setExpandedId((cur) => (cur === step.id ? null : step.id))}
            />
          </motion.div>
        ))}
      </div>
    </div>
  );
}
