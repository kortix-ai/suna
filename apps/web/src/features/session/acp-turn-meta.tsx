'use client';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { AcpUsageCost, AcpUsageProjection } from '@kortix/sdk';
import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { acpTurnMetaRows } from './acp-turn-grouping';

/** How often the "… ago" line refreshes WHILE the popover is open. Closed,
 *  nothing ticks — the clock is only read on open. */
const TICK_MS = 15_000;

/**
 * A turn's meta, behind a ⋯ overflow trigger.
 *
 * This replaces the dot-separated line that used to run along the bottom of
 * every completed turn — `2m 15s · $0.45 this session · 46k ctx`. Three
 * unlabelled values of three different kinds (a per-turn duration, a
 * session-cumulative cost, a session-current context size) sharing one
 * separator read as one list of comparable things, which they are not; and
 * "ctx" is jargon for a number most people never need. Everything a reader
 * has to decode is the opposite of calm.
 *
 * So the transcript's resting state is two icon buttons — copy, and details —
 * and the numbers live one click away as a *labelled* list, where the label
 * does the explaining ("Context", not "ctx") and each value can be read on
 * its own terms.
 *
 * Deliberately a **popover**, not a dropdown menu: it holds structured
 * content rather than commands, so menu semantics (`menuitem` roles, typeahead,
 * arrow-key roving) would be a lie told to assistive tech. The ⋯ trigger is
 * the conventional overflow affordance either way. Content is a description
 * list (`dl`/`dt`/`dd`) because that is precisely what label→value pairs are.
 */
export function AcpTurnMeta({
  endedAt,
  durationMs,
  cost,
  usage,
  className,
}: {
  /** When the turn last produced a message — `acpTurnEndedAt`. */
  endedAt: number | null;
  /** This turn's wall-clock span — `acpTurnDurationMs`. */
  durationMs: number | null;
  /** Session-cumulative cost. Passed for the last turn only; the session
   *  totals belong to the transcript's most recent footer, not to every one. */
  cost: AcpUsageCost | null | undefined;
  /** Session-current context usage. Same last-turn-only contract as `cost`. */
  usage: Pick<AcpUsageProjection, 'used' | 'tokens'> | null | undefined;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState<number | null>(null);

  // The clock is read in the open handler rather than an effect: a passive
  // effect lands AFTER paint, so the first visible frame of the popover would
  // carry a stale "… ago" and then correct itself.
  const handleOpenChange = useCallback((next: boolean) => {
    if (next) setNow(Date.now());
    setOpen(next);
  }, []);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [open]);

  const rows = useMemo(
    // `now ?? endedAt` covers the closed state, where the relative row is
    // never rendered but `rows.length` still decides whether the trigger
    // exists at all.
    () => acpTurnMetaRows({ endedAt, now: now ?? endedAt ?? 0, durationMs, cost, usage }),
    [endedAt, now, durationMs, cost, usage],
  );

  // Nothing the harness reported anything about — no trigger. A ⋯ that opens
  // an empty panel is worse than no ⋯.
  if (rows.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Turn details"
          data-testid="acp-turn-meta-trigger"
          className={cn(
            // Matched pair with `CopyButton` beside it — same 28px box, same
            // 14px icon, same press feedback — so the footer reads as one
            // control cluster instead of two unrelated buttons.
            'inline-flex size-7 items-center justify-center rounded-md',
            'text-foreground hover:bg-muted-foreground/10',
            'cursor-pointer transition-colors active:scale-[0.97]',
            'outline-none focus-visible:outline-none',
            className,
          )}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        data-testid="acp-turn-meta-panel"
        className="w-auto min-w-52 p-3"
      >
        <dl className="space-y-2 text-xs">
          {rows.map((row) => (
            <div key={row.label} className="flex items-baseline justify-between gap-6">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="text-foreground tabular-nums">{row.value}</dd>
            </div>
          ))}
        </dl>
      </PopoverContent>
    </Popover>
  );
}
