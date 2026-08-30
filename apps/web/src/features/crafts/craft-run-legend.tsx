'use client';

import type { CraftRunStatus } from '@kortix/sdk';

import { SessionStatusDot } from '@/components/projects/session-status-dot';
import { cn } from '@/lib/utils';

/**
 * Which states the legend names, in the order a reader cares about: the ones
 * that need attention, then the verdict, then the ones that do not.
 *
 * `starting` is left out on purpose — it is a spinner, it is self-evident, and
 * it is gone within seconds. `needs-you` and `legacy` are session states a
 * craft run cannot have and are not listed.
 *
 * `retrying` and `skipped` ARE listed, and they are the reason this legend
 * exists at all: the first says the last attempt failed, the second says the
 * fire was declined and nothing is wrong. A reader who mistakes either for a
 * failure reads the whole page wrong.
 */
const LEGEND_STATUSES: readonly { status: CraftRunStatus; label: string }[] = [
  { status: 'running', label: 'Running' },
  { status: 'retrying', label: 'Retrying' },
  { status: 'done', label: 'Done' },
  { status: 'failed', label: 'Failed' },
  { status: 'stopped', label: 'Stopped' },
  { status: 'skipped', label: 'Skipped' },
];

/**
 * Names the status circles once per page. The strip is dense and unlabeled by
 * design; without this the only way to learn the vocabulary is to hover every
 * circle. Deliberately quiet — `text-xs`, muted, no panel — so it reads as a
 * key and not as content.
 */
export function CraftRunLegend({ className }: { className?: string }) {
  return (
    <ul className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', className)}>
      {LEGEND_STATUSES.map(({ status, label }) => (
        <li key={status} className="flex items-center gap-1.5">
          {/* No tooltip: the label is already right there, so a hover
              repeating it is noise and makes a key look clickable. */}
          <SessionStatusDot status={status} hint={false} />
          <span className="text-muted-foreground text-xs">{label}</span>
        </li>
      ))}
    </ul>
  );
}
