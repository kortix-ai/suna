'use client';

import { ArrowsSplitIcon } from '@phosphor-icons/react';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { TurnServedModel } from './served-model';

/** A settled request's recorded failure and successful fallback, not a turn-wide failure. */
export function TurnFallbackRow({
  requested,
  reason,
  served,
  className,
}: {
  requested: string;
  /** The safe gateway error code for this request. */
  reason: string;
  /** Display name of the model that served this request. */
  served: string;
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
        {tI18nComplete('servedModelTurnRow', { requested, reason, served })}
      </span>
    </div>
  );
}

export function TurnFallbackRows({ working, events }: {
  working: boolean;
  events: TurnServedModel['fallbacks'];
}) {
  if (working) return null;
  return events?.map((event, index) => (
    <TurnFallbackRow key={index} {...event} />
  ));
}
