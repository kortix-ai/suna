'use client';

/**
 * `StepRow` — one plain-language sentence in the Progress drill-in list, and
 * the escape hatch back to the truth: tapping it expands the REAL tool views
 * for that step (the same `ToolPartRenderer` the Advanced stepper uses).
 *
 * Easy mode is a lens over the truth, never a wall in front of it — nothing
 * here re-renders or summarizes a tool call differently than Advanced does.
 * Built on the repo's `Disclosure` primitive (matching `panel-card.tsx`)
 * instead of hand-rolled `AnimatePresence` — the height/opacity choreography
 * and the `prefers-reduced-motion` guard already live there.
 */

import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { TextShimmer } from '@/components/ui/text-shimmer';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import { motion, useReducedMotion } from 'motion/react';
import { ToolPartRenderer, ToolSurfaceContext } from '../../tool/tool-renderers';
import type { Step } from '../shared/group-steps';
import { formatDuration } from './progress-summary';

/** Live/done/failed, read at a glance — never text, only color + motion. */
function StatusDot({ status }: { status: Step['status'] }) {
  if (status === 'running') {
    return (
      <span className="relative flex size-2 shrink-0">
        <span className="bg-kortix-green absolute inline-flex size-2 animate-ping rounded-full opacity-60 motion-reduce:animate-none" />
        <span className="bg-kortix-green relative inline-flex size-2 rounded-full" />
      </span>
    );
  }
  return (
    <span
      className={cn(
        'size-2 shrink-0 rounded-full',
        status === 'error' ? 'bg-kortix-red' : 'bg-muted-foreground/40',
      )}
    />
  );
}

export function StepRow({
  step,
  sessionId,
  expanded,
  onToggle,
}: {
  step: Step;
  sessionId: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  const reduce = useReducedMotion();
  const transition = reduce ? { duration: 0 } : { duration: 0.2, ease: 'easeOut' as const };

  return (
    <Disclosure
      open={expanded}
      onOpenChange={onToggle}
      transition={transition}
      className="border-border/60 border-b last:border-b-0"
    >
      <DisclosureTrigger>
        <button
          type="button"
          className={cn(
            'flex min-h-11 w-full items-center gap-3 px-4 py-2.5 text-left',
            'transition-[background-color,transform] active:scale-[0.998]',
            'hover:bg-muted-foreground/[0.04] cursor-pointer',
          )}
        >
          <StatusDot status={step.status} />
          {step.status === 'running' ? (
            <TextShimmer
              as="span"
              duration={1.8}
              spread={1.25}
              className="min-w-0 flex-1 truncate text-sm"
            >
              {step.label}
            </TextShimmer>
          ) : (
            <span className="text-foreground min-w-0 flex-1 truncate text-sm">{step.label}</span>
          )}
          {typeof step.durationMs === 'number' && step.durationMs > 0 && (
            <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
              {formatDuration(step.durationMs)}
            </span>
          )}
          <motion.span
            animate={{ rotate: expanded ? 180 : 0 }}
            transition={transition}
            className="text-muted-foreground shrink-0"
          >
            <ChevronDown className="size-4" />
          </motion.span>
        </button>
      </DisclosureTrigger>
      {/* The escape hatch: the real tool views, unmodified. `overflow-x-auto`
          contains code/diff/terminal output — this column never blows out. */}
      <DisclosureContent contentClassName="bg-muted/30 min-w-0 overflow-x-auto px-2 pb-2">
        <ToolSurfaceContext.Provider value="panel">
          {step.parts.map((part) => (
            <ToolPartRenderer key={part.callID} part={part} sessionId={sessionId} defaultOpen />
          ))}
        </ToolSurfaceContext.Provider>
      </DisclosureContent>
    </Disclosure>
  );
}
