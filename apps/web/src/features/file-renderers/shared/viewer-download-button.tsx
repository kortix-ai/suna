'use client';

/**
 * The one Download control every file viewer shows.
 *
 * Download is the action people open a file viewer for most often after
 * reading it. It used to sit behind a `⋯` menu (or a split-button caret), and
 * on some viewers in both places at once. It is now a visible icon button,
 * never a menu item: one click, no hunting, and exactly one per viewer.
 *
 * `outline` rather than `ghost` so it carries the same weight as the other
 * primary action in a toolbar (`Copy`/`Copy link`), instead of reading as one
 * more muted tool beside zoom and search.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { DownloadSimpleIcon } from '@phosphor-icons/react';

export function ViewerDownloadButton({
  onDownload,
  pending = false,
  disabled = false,
  className,
}: {
  onDownload: () => void;
  /** The bytes are still being fetched — the button spins and ignores clicks,
   *  so a slow download is not started twice. */
  pending?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const label = tI18nComplete.raw('textd6eafe823591');

  return (
    <Hint label={label} side="bottom">
      <Button
        type="button"
        variant="outline"
        size="icon"
        onClick={onDownload}
        disabled={disabled || pending}
        aria-label={label}
        aria-busy={pending}
        data-viewer-download=""
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
          <DownloadSimpleIcon className="size-3.5" />
        )}
      </Button>
    </Hint>
  );
}
