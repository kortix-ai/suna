'use client';

import { ArrowsSplitIcon } from '@phosphor-icons/react';

import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ServedModelNotice } from '../turn/served-model';

/**
 * A strip above the composer card when a fallback model answered the newest
 * request in place of the model the selector names. The selector shows what
 * the next request asks for; the project's fallback chain decides what
 * answers. Without this strip a session reads as running a model that did not
 * run (incident 2026-10-02). It closes when the selected model answers again
 * or the selector changes (`servedModelNotice`).
 *
 * The same chrome as the "still waking" notice in `ComposerAboveCard`. Under
 * that notice it stays square and its top border is the divider.
 */
export function ServedModelBar({
  notice,
  underNotice = false,
}: {
  notice: ServedModelNotice;
  underNotice?: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="served-model-bar"
      className={cn(
        'bg-sidebar border-border flex w-full items-center gap-2 border border-b-0 px-3 py-1.5',
        !underNotice && 'rounded-t-xl',
      )}
    >
      <ArrowsSplitIcon className="text-kortix-orange size-3.5 shrink-0" aria-hidden="true" />
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        {tI18nComplete('servedModelBadge', { model: notice.served })}
        <span className="hidden sm:inline">
          {' — '}
          {tI18nComplete('servedModelBarDescription', { requested: notice.fallbackFrom })}
        </span>
      </span>
    </div>
  );
}
