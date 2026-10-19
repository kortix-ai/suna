'use client';

import { ArrowsSplitIcon } from '@phosphor-icons/react';

import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import type { TurnServedModel } from './served-model';

type FallbackEvent = NonNullable<TurnServedModel['fallbacks']>[number];

/** One run of identical switches: the failure and the fallback that answered, and how many requests it covers. */
function TurnFallbackRow({
  requested,
  reason,
  served,
  count,
  className,
}: FallbackEvent & {
  /** Consecutive requests that failed and switched the same way. */
  count: number;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div
      role="note"
      data-testid="turn-fallback-row"
      className={cn('flex w-full items-center gap-3 text-left text-sm', className)}
    >
      <ArrowsSplitIcon className="text-muted-foreground size-4 flex-none" aria-hidden="true" />
      <span className="text-muted-foreground min-w-0 wrap-anywhere">
        {count > 1
          ? tI18nComplete('servedModelTurnRowRepeated', { requested, reason, served, count })
          : tI18nComplete('servedModelTurnRow', { requested, reason, served })}
      </span>
    </div>
  );
}

/**
 * A settled turn's model switches, in order. A busy model fails every request
 * the same way, so consecutive identical switches are one row with a count:
 * a 3-hour turn made 1,219 requests on one fallback.
 */
export function TurnFallbackRows({ working, events }: {
  working: boolean;
  events: TurnServedModel['fallbacks'];
}) {
  if (working) return null;
  const runs: (FallbackEvent & { count: number })[] = [];
  for (const event of events ?? []) {
    const last = runs.at(-1);
    if (last && last.requested === event.requested && last.served === event.served && last.reason === event.reason) last.count++;
    else runs.push({ ...event, count: 1 });
  }
  return runs.map((run, index) => <TurnFallbackRow key={index} {...run} />);
}
