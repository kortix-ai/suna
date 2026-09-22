'use client';

/**
 * Re-read the open file in place.
 *
 * An agent often rewrites a file while it is open in a viewer. Without this
 * the only way to see the new version was to close the viewer and open it
 * again. The button calls the viewer's own content refetch, so the viewer
 * stays open and only its content updates.
 *
 * It sits beside `ViewerDownloadButton`, never in a menu. It is `ghost`, one
 * step quieter than Download: Download is the primary action, Refresh is a
 * utility.
 *
 * The in-flight state is the `Loading` spinner in place of the glyph, and the
 * button is disabled until the refetch settles. The icon itself never spins.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { ArrowClockwiseIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useRef, useState } from 'react';

export function ViewerRefreshButton({
  onRefresh,
  disabled = false,
  className,
}: {
  /** Resolves when the new content has arrived. A rejection counts as done:
   *  the viewer shows its own error state, the button only has to recover. */
  onRefresh: () => Promise<unknown>;
  disabled?: boolean;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const label = tI18nComplete.raw('text0e9161011702');
  const [pending, setPending] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (pending) return;
    setPending(true);
    try {
      await onRefresh();
    } catch {
      // The viewer renders the failure; the button only has to recover.
    } finally {
      if (alive.current) setPending(false);
    }
  }, [onRefresh, pending]);

  return (
    <Hint label={label} side="bottom">
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onClick={() => void run()}
        disabled={disabled || pending}
        aria-label={label}
        aria-busy={pending}
        data-viewer-refresh=""
        className={cn(
          'shrink-0 active:scale-[0.96]',
          // A spinning button is busy, not unavailable — keep it at full ink.
          pending && 'disabled:opacity-100',
          className,
        )}
      >
        {pending ? (
          <Loading className="text-muted-foreground size-3.5 shrink-0 motion-reduce:animate-none" />
        ) : (
          <ArrowClockwiseIcon className="size-3.5" />
        )}
      </Button>
    </Hint>
  );
}
