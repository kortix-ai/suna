'use client';

import { useState } from 'react';

import type { CostModelRow } from '@kortix/sdk';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { IconChevronDown } from '@/components/ui/kortix-icons';
import { cn } from '@/lib/utils';

import { formatSessionCostUsd } from '../session-cost-format';

const VISIBLE_COUNT = 5;

/**
 * The toggle's label, named for what the click does rather than for what the
 * list holds.
 *
 * It used to read `Show all (12)` under five visible rows, where the number is
 * ambiguous: 12 could be the total or the remainder, and the two readings
 * differ by exactly the five rows already on screen. `Show 7 more` states the
 * outcome of the click, which is the only figure the reader needs.
 */
export function modelListToggleLabel(hiddenCount: number, expanded: boolean): string {
  return expanded ? 'Show less' : `Show ${hiddenCount} more`;
}

export interface CostModelListProps {
  models: CostModelRow[];
}

export function CostModelList({ models }: CostModelListProps) {
  const [showAll, setShowAll] = useState(false);

  // Nothing to answer "which model is consuming the budget" with.
  if (models.length === 0) return null;

  const maxCost = models.reduce((max, row) => Math.max(max, row.cost), 0);
  const visible = models.slice(0, VISIBLE_COUNT);
  const rest = models.slice(VISIBLE_COUNT);

  return (
    <div className="bg-popover divide-border divide-y overflow-hidden rounded-md border">
      {visible.map((row) => (
        <ModelRow key={`${row.provider}/${row.model}`} row={row} maxCost={maxCost} />
      ))}
      {rest.length > 0 ? (
        <Disclosure open={showAll} onOpenChange={setShowAll}>
          <DisclosureTrigger>
            {/* A control, not a sixth data row. As a transparent ghost button
                with `rounded-none` inside a `divide-y` card it was visually
                indistinguishable from the model rows above it — same width,
                same seam, same surface. The tinted surface separates it from
                the data without introducing a second card. Kept full-width so
                the whole footer of the card is the hit area. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="bg-popover-foreground/5 hover:bg-popover-foreground/10 text-muted-foreground hover:text-foreground w-full justify-center gap-1.5 rounded-none text-xs font-medium"
            >
              {modelListToggleLabel(rest.length, showAll)}
              {/* Direction. Nothing in the old label said which way the click
                  went, so "Show less" was the only clue that the list was
                  already expanded. `transition-transform`, never
                  `transition-all` — the button also changes background and
                  text colour on hover, and animating those through the same
                  declaration would tie an unrelated 200ms to the hover. */}
              <IconChevronDown
                aria-hidden="true"
                className={cn(
                  'size-3 shrink-0 transition-transform duration-200 ease-out',
                  showAll && 'rotate-180',
                )}
              />
            </Button>
          </DisclosureTrigger>
          <DisclosureContent contentClassName="divide-border divide-y">
            {rest.map((row) => (
              <ModelRow key={`${row.provider}/${row.model}`} row={row} maxCost={maxCost} />
            ))}
          </DisclosureContent>
        </Disclosure>
      ) : null}
    </div>
  );
}

function ModelRow({ row, maxCost }: { row: CostModelRow; maxCost: number }) {
  const pct = maxCost > 0 ? Math.max(0, Math.min(100, (row.cost / maxCost) * 100)) : 0;

  return (
    <div className="relative">
      <div
        className="bg-primary/[0.06] absolute inset-y-0 left-0"
        style={{ width: `${pct}%` }}
        aria-hidden="true"
      />
      <div className="relative flex items-center justify-between gap-3 px-4 py-2.5">
        <div className="min-w-0">
          <p className="truncate text-sm">{row.model}</p>
          <p className="text-muted-foreground truncate text-xs">{row.provider}</p>
        </div>
        <div className="shrink-0 text-right">
          <p className="font-mono text-sm font-medium tabular-nums">
            {formatSessionCostUsd(row.cost)}
          </p>
          <p className="text-muted-foreground text-xs tabular-nums">
            {row.request_count.toLocaleString('en-US')} reqs
          </p>
        </div>
      </div>
    </div>
  );
}
