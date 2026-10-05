'use client';

import { ArrowsSplitIcon } from '@phosphor-icons/react';
import { useState } from 'react';

import { useTranslations } from '@/i18n/use-translations';
import { ComposerTray } from '../model-connection-gate';
import type { ServedModelNotice } from '../turn/served-model';

/**
 * A strip above the composer when a fallback model answered the newest request
 * in place of the model the selector names. The selector shows what the next
 * request asks for; the project's fallback chain decides what answers. Without
 * this strip a session reads as running a model that did not run (incident
 * 2026-10-02). It closes when the selected model answers again or the selector
 * changes (`servedModelNotice`).
 */
export function ServedModelBar({ notice }: { notice: ServedModelNotice | null }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // Keeps the last names through the exit animation, which runs after `notice` clears.
  const [shown, setShown] = useState(notice);
  if (notice && (notice.served !== shown?.served || notice.fallbackFrom !== shown?.fallbackFrom)) {
    setShown(notice);
  }

  return (
    <ComposerTray show={notice !== null} trayKey="served-model-bar" placement="top">
      <div
        data-testid="served-model-bar"
        className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs"
      >
        <ArrowsSplitIcon className="text-kortix-orange size-3.5 shrink-0" />
        <span className="truncate">
          {tI18nComplete('servedModelBadge', { model: shown?.served ?? '' })}
          <span className="hidden sm:inline">
            {' — '}
            {tI18nComplete('servedModelBarDescription', { requested: shown?.fallbackFrom ?? '' })}
          </span>
        </span>
      </div>
    </ComposerTray>
  );
}
