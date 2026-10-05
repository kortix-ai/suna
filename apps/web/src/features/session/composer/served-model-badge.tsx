'use client';

import Hint from '@/components/ui/hint';
import { StatusDot } from '@/components/ui/status';
import { useTranslations } from '@/i18n/use-translations';
import type { ServedModelNotice } from '../turn/served-model';

/**
 * The model that answered the newest request, when it is not the one the
 * selector beside it names. The selector shows what the next request asks for;
 * a fallback chain decides what answers. Without this mark a session reads as
 * running a model that did not run (incident 2026-10-02).
 *
 * A quiet line, not a chip: the selector stays the control, this is its note.
 * The dot carries the warning hue; the words stay ink (kortix-brand color.md).
 */
export function ServedModelBadge({ notice }: { notice: ServedModelNotice }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  return (
    <Hint
      label={tI18nComplete('servedModelHint', { requested: notice.fallbackFrom, model: notice.served })}
      className="max-w-72 text-pretty"
    >
      <span
        // A tooltip trigger must take focus, or a keyboard never reads the reason.
        tabIndex={0}
        data-testid="served-model-badge"
        className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex min-w-0 shrink items-center gap-1.5 rounded-sm px-1 text-xs outline-none focus-visible:ring-2"
      >
        <StatusDot tone="warning" className="size-1.5" />
        <span className="truncate">{tI18nComplete('servedModelBadge', { model: notice.served })}</span>
      </span>
    </Hint>
  );
}
