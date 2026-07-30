'use client';

/**
 * The ⋯ trigger and popover that expose a completed turn's numbers — when it
 * finished, how long it took, what it cost, how many tokens it burned.
 *
 * A Popover, not a DropdownMenu: this panel holds structured label→value
 * content, not a list of commands. A `DropdownMenu` would paint its rows with
 * `menuitem` roles and wire up arrow-key roving, both of which promise
 * assistive tech something that isn't there — there is nothing here to
 * *activate*.
 *
 * A `dl`/`dt`/`dd` inside it for the same reason in reverse: label→value
 * pairs are exactly what a description list is for, so using anything else
 * (a table, a couple of `div`s) would throw away semantics HTML already
 * gives for free.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { DotsThreeIcon } from '@phosphor-icons/react';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import type { TurnCostInfo } from '@/ui';
import { sessionTurnMetaRows } from './session-turn-meta-rows';

// Nothing ticks while the popover is closed — a relative "N ago" that nobody
// can see doesn't need to stay accurate.
const TICK_MS = 15_000;

export function SessionTurnMeta({
  endedAt,
  durationMs,
  cost,
  className,
}: {
  endedAt: number | null;
  durationMs: number | null;
  cost: TurnCostInfo | null | undefined;
  className?: string;
}): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState<number | null>(null);

  const handleOpenChange = useCallback((next: boolean) => {
    // Read the clock here, not in an effect: a passive effect lands after
    // paint, so the popover's first visible frame would carry a stale "…
    // ago" and then correct itself a beat later.
    if (next) setNow(Date.now());
    setOpen(next);
  }, []);

  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, [open]);

  // Closed, `now` is null and the relative row is never shown, but
  // `rows.length` still has to decide whether the trigger exists at all —
  // so the fallback below stands in for a clock read that hasn't happened.
  const rows = useMemo(
    () => sessionTurnMetaRows({ endedAt, now: now ?? endedAt ?? 0, durationMs, cost }),
    [endedAt, now, durationMs, cost],
  );

  // A ⋯ that opens onto an empty panel is worse than no ⋯ at all.
  if (rows.length === 0) return null;

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label="Turn details"
          data-testid="session-turn-meta-trigger"
          className={className}
        >
          <DotsThreeIcon className="size-3.5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        data-testid="session-turn-meta-panel"
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
