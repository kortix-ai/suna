'use client';

import {
  SESSION_DISPLAY_STATUS_LABELS,
  type SessionDisplayStatus,
} from '@/components/projects/session-label';
import { SessionStatusDot } from '@/components/projects/session-status-dot';
import { cn } from '@/lib/utils';

/**
 * Which states the legend names, in the order a reader cares about: the two
 * that need attention, then the verdict, then the two that do not.
 *
 * `starting` is left out on purpose — it is a spinner, it is self-evident, and
 * it is gone within seconds. `legacy` is a migration artifact and cannot
 * describe a craft run at all.
 */
const LEGEND_STATUSES: SessionDisplayStatus[] = [
  'running',
  'needs-you',
  'done',
  'failed',
  'stopped',
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
      {LEGEND_STATUSES.map((status) => (
        <li key={status} className="flex items-center gap-1.5">
          {/* No tooltip: the label is already right there, so a hover
              repeating it is noise and makes a key look clickable. */}
          <SessionStatusDot status={status} hint={false} />
          <span className="text-muted-foreground text-xs">
            {SESSION_DISPLAY_STATUS_LABELS[status]}
          </span>
        </li>
      ))}
    </ul>
  );
}
