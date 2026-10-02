'use client';

import { WarningIcon } from '@phosphor-icons/react';

import { Badge } from '@/components/ui/badge';
import Hint from '@/components/ui/hint';
import { useTranslations } from '@/i18n/use-translations';
import type { ServedModelNotice } from '../turn/served-model';

/**
 * The model that answered the newest request, when it is not the one the
 * selector beside it names. The selector shows what the next request asks for;
 * a fallback chain decides what answers. Without this mark a session reads as
 * running a model that did not run (incident 2026-10-02).
 */
export function ServedModelBadge({ notice }: { notice: ServedModelNotice }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const label = tI18nComplete('servedModelBadge', { model: notice.served });
  return (
    <Hint
      label={tI18nComplete('servedModelHint', { requested: notice.fallbackFrom, model: notice.served })}
      className="max-w-72 text-pretty"
    >
      <Badge
        variant="warning"
        size="xs"
        // A tooltip trigger must take focus, or a keyboard never reads the reason.
        tabIndex={0}
        data-testid="served-model-badge"
        className="min-w-0 shrink gap-1"
      >
        <WarningIcon weight="fill" />
        <span className="truncate">{label}</span>
      </Badge>
    </Hint>
  );
}
