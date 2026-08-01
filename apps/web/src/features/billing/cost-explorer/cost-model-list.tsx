'use client';

import { useState } from 'react';

import type { CostModelRow } from '@kortix/sdk';

import { Button } from '@/components/ui/button';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';

import { formatSessionCostUsd } from '../session-cost-format';

const VISIBLE_COUNT = 5;

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
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="text-muted-foreground hover:text-foreground w-full justify-center rounded-none text-xs font-medium"
            >
              {showAll ? 'Show less' : `Show all (${models.length})`}
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
