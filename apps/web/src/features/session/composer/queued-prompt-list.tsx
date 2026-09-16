'use client';

/**
 * The queued messages, listed directly above the composer.
 *
 * One muted row per entry, in delivery order, full text. No header, no count,
 * no empty state: with nothing queued and nothing held this renders nothing, so
 * the composer's inset strip (`empty:hidden`) collapses. A queued entry is not
 * in the transcript; it moves there when the agent reaches it.
 *
 * Nothing in a row is editable in place. Up takes entries back into the
 * composer (`handleTakeBackQueue`); ✕ removes one entry; a failed row offers
 * Retry. While a Stop holds the queue, one line says so and offers Resume.
 */

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import {
  ArrowClockwiseIcon,
  CaretRightIcon,
  PaperclipIcon,
  PauseIcon,
  WarningIcon,
  XIcon,
} from '@phosphor-icons/react';
import type { QueueRow } from '../queue-projection';

export interface QueuedPromptListProps {
  rows: readonly QueueRow[];
  heldCount: number;
  resumePending?: boolean;
  /** Omitted by a read-only host (the boot shell): no Resume button. */
  onResume?: () => void;
  onRemove?: (promptId: string) => void;
  onRetry?: (promptId: string) => void;
}

function RowAction({
  label,
  onClick,
  revealOnHover,
  children,
}: {
  label: string;
  onClick: () => void;
  revealOnHover: boolean;
  children: React.ReactNode;
}) {
  return (
    <Hint label={label} side="top" align="center">
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={label}
        onClick={onClick}
        className={cn(
          'hit-area-2 text-muted-foreground hover:text-foreground',
          // Hover-revealed where hover exists; always visible on touch, where
          // it does not.
          revealOnHover &&
            'transition-opacity duration-(--duration-fast) pointer-coarse:opacity-100 group-hover/queued:opacity-100 focus-visible:opacity-100 opacity-0',
        )}
      >
        {children}
      </Button>
    </Hint>
  );
}

export function QueuedPromptList({
  rows,
  heldCount,
  resumePending = false,
  onResume,
  onRemove,
  onRetry,
}: QueuedPromptListProps) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (rows.length === 0 && heldCount === 0) return null;

  return (
    <section aria-label={tI18nComplete.raw('textf8e64a37950a')} className="flex w-full flex-col">
      {heldCount > 0 && (
        <div
          data-queue-held
          className="text-muted-foreground flex items-center gap-2 py-0.5 pr-0.5 pl-3 text-xs"
        >
          <PauseIcon aria-hidden weight="fill" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{tI18nComplete.raw('text1eb132d9d4da')}</span>
          {onResume && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={resumePending}
              onClick={onResume}
            >
              {resumePending ? <Loading className="size-3.5 shrink-0" /> : null}
              {tI18nComplete.raw('textd640c7421da0')}
            </Button>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <ul className="max-h-40 overflow-y-auto">
          {rows.map((row) => {
            const failed = row.state === 'failed';
            return (
              <li
                key={row.id}
                data-queued-prompt-id={row.id}
                data-queued-state={row.state}
                className="group/queued flex items-start gap-2 pr-0.5 pl-3"
              >
                <CaretRightIcon
                  aria-hidden
                  className="text-muted-foreground mt-1.5 size-3.5 shrink-0"
                />
                <p className="text-muted-foreground min-w-0 flex-1 py-0.5 text-sm break-words whitespace-pre-wrap">
                  {row.text}
                </p>
                {row.attachmentCount > 0 && (
                  <span className="text-muted-foreground mt-1 flex shrink-0 items-center gap-1 text-xs tabular-nums">
                    <PaperclipIcon aria-hidden className="size-3.5" />
                    {row.attachmentCount}
                  </span>
                )}
                {failed && (
                  <span
                    title={row.lastError}
                    className="text-kortix-red mt-1 flex shrink-0 items-center gap-1 text-xs"
                  >
                    <WarningIcon aria-hidden weight="fill" className="size-3.5" />
                    {tI18nComplete.raw('textcd5f943d5863')}
                  </span>
                )}
                {((failed && onRetry) || (row.removable && onRemove)) && (
                  <div className="flex shrink-0 items-center">
                    {failed && onRetry && (
                      <RowAction
                        label={tI18nComplete.raw('text942087cc2d41')}
                        onClick={() => onRetry(row.id)}
                        revealOnHover={false}
                      >
                        <ArrowClockwiseIcon className="size-3.5" />
                      </RowAction>
                    )}
                    {row.removable && onRemove && (
                      <RowAction
                        label={tI18nComplete.raw('textc0b9d9e9ac1d')}
                        onClick={() => onRemove(row.id)}
                        revealOnHover={!failed}
                      >
                        <XIcon className="size-3.5" />
                      </RowAction>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
