'use client';

import { useState, type ReactNode } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';
import { Steps, StepsBar, StepsTrigger } from '@/components/ui/steps';
import { cn } from '@/lib/utils';

/**
 * One transcript "step" — the shared disclosure idiom EVERY activity row in
 * the ACP transcript renders through (reasoning runs, same-tool piles,
 * single tool calls, plans, unrecognized agent events). Built on the
 * design-system's `Steps` stepper (`@/components/ui/steps`): `Steps` (a
 * Radix `Collapsible` root) + `StepsTrigger` (the icon-led trigger row) +
 * `StepsBar` (the vertical rail expanded content hangs off), so the whole
 * transcript shares ONE chain-of-thought visual language with a
 * rest-visible chevron affordance (WS5-P3-a: the chevron never hides behind
 * hover — only its rotation animates on open).
 *
 * Deliberately WITHOUT `StepsContent` (Radix's `CollapsibleContent`): that
 * piece schedules a mount-time `requestAnimationFrame` setState (its
 * exit-animation Presence guard) that overflowed the transcript's commit
 * budget in the replay perf test when this disclosure was first built
 * (WS3-era, re-proven by `acp-session-perf.test.tsx`). `Steps`'s root and
 * `StepsTrigger` are plain context/`Primitive.button` wrappers with no RAF
 * of their own — proven zero-cost. So: real stepper primitives for the
 * shell, a plain `{open ? … : null}` conditional (with `StepsBar` supplying
 * the rail) for the body — zero extra commits while the replay stream keeps
 * every step closed.
 *
 * The trigger button is a `group` carrying Radix's `data-state`, so label
 * content can react to open/closed purely in CSS — e.g. a shell command
 * span with `group-data-[state=open]:hidden` disappears from the trigger
 * the moment the body (which echoes it) expands.
 */
export function AcpTranscriptStep({
  icon,
  label,
  running = false,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode;
  /** Trigger row content — rendered inside a truncating flex row, so pass
   *  plain text or `min-w-0`-safe spans. */
  label: ReactNode;
  /** Shows the trailing in-flight spinner on the trigger row. */
  running?: boolean;
  /** Open on first render (plans, failed tool calls). */
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <Steps open={open} onOpenChange={setOpen} className="max-w-full">
      <StepsTrigger
        leftIcon={icon}
        swapIconOnHover={false}
        className="text-muted-foreground/70 hover:text-foreground w-full py-0.5 text-xs select-none"
      >
        <span className="flex w-full min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {running && (
            <Loader2 className="text-muted-foreground/40 size-3 shrink-0 animate-spin" />
          )}
          {/* Rest-visible chevron (never `opacity-0` until hover) — the only
              animated property is its rotation on open, keyed off the Radix
              trigger's own `data-state` so no extra state plumbing. */}
          <ChevronRight
            className={cn(
              'text-muted-foreground/50 size-3 shrink-0 transition-transform',
              'group-data-[state=open]:rotate-90',
            )}
          />
        </span>
      </StepsTrigger>
      {open ? (
        // `StepsContent`'s own grid layout, minus the Radix content wrapper
        // (see the module comment above): a `w-4` rail column that mirrors the
        // trigger's `size-4` icon box exactly, so the expanded body's text
        // gutter lines up pixel-for-pixel with the trigger label, and the
        // `StepsBar` rail runs down the icon's center line.
        <div className="grid grid-cols-[min-content_minmax(0,1fr)] gap-x-2 pt-1 pb-1.5">
          <div className="flex w-4 justify-center self-stretch">
            <StepsBar className="bg-border w-px" />
          </div>
          <div className="min-w-0 space-y-2">{children}</div>
        </div>
      ) : null}
    </Steps>
  );
}
