'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { QueueRow } from '../queue-projection';

export interface QueuedPromptListProps {
  rows: readonly QueueRow[];
  heldCount: number;
  resumePending?: boolean;
  onResume?: () => void;
  onEdit?: (promptId: string) => void;
  onRemove?: (promptId: string) => void;
  onRetry?: (promptId: string) => void;
}

export function QueuedPromptList({
  rows,
  heldCount,
  resumePending = false,
  onResume,
  onEdit,
  onRemove,
  onRetry,
}: QueuedPromptListProps) {
  const t = useTranslations('threads');
  const common = useTranslations('common');
  const copy = useTranslations('hardcodedUi.i18nComplete');
  if (rows.length === 0 && heldCount === 0) return null;

  return (
    <section aria-label={t('queueList')} className="flex w-full flex-col">
      {heldCount > 0 && (
        <div
          data-queue-held
          className="text-muted-foreground flex items-center gap-2 px-3 py-1 text-xs"
        >
          <span className="min-w-0 flex-1">{copy.raw('text1eb132d9d4da')}</span>
          {onResume && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              disabled={resumePending}
              onClick={onResume}
            >
              {resumePending && <Loading className="size-3.5 shrink-0" />}
              {copy.raw('textd640c7421da0')}
            </Button>
          )}
        </div>
      )}
      {rows.length > 0 && (
        <ul className="max-h-40 overflow-y-auto">
          {rows.map((row) => {
            const failed = row.state === 'failed';
            const long = row.text.length > 240 || row.text.split('\n').length > 4;
            return (
              <li
                key={row.id}
                data-queued-prompt-id={row.id}
                data-queued-state={row.state}
                className="group/queued flex flex-wrap items-center gap-x-2 gap-y-1 px-3 py-1"
              >
                <div className="text-muted-foreground min-w-0 flex-1 text-sm break-words">
                  {long ? (
                    <details>
                      <summary className="focus-visible:outline-ring cursor-pointer truncate rounded-sm focus-visible:outline-2">
                        {row.text.split('\n').find((line) => line.trim()) || t('queued')}
                      </summary>
                      <pre className="mt-2 max-h-40 overflow-auto font-mono text-xs whitespace-pre">
                        {row.text}
                      </pre>
                    </details>
                  ) : (
                    <p className="whitespace-pre-wrap">{row.text}</p>
                  )}
                  {row.attachmentCount > 0 && (
                    <span className="text-xs">
                      {t('queuedFiles', { count: row.attachmentCount })}
                    </span>
                  )}
                  {failed && (
                    <p className="text-kortix-red text-xs" role="status" title={row.lastError}>
                      {copy.raw('textcd5f943d5863')}
                      {row.lastError ? ` — ${row.lastError}` : ''}
                    </p>
                  )}
                </div>
                <div
                  className={cn(
                    'flex shrink-0 items-center',
                    !failed &&
                      'opacity-0 group-focus-within/queued:opacity-100 group-hover/queued:opacity-100 pointer-coarse:opacity-100',
                  )}
                >
                  {row.takeBackEligible && onEdit && (
                    <Button type="button" variant="ghost" size="xs" onClick={() => onEdit(row.id)}>
                      {common('edit')}
                    </Button>
                  )}
                  {failed && onRetry && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-label={copy.raw('text942087cc2d41')}
                      onClick={() => onRetry(row.id)}
                    >
                      {copy.raw('text942087cc2d41')}
                    </Button>
                  )}
                  {row.removable && onRemove && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      aria-label={copy.raw('textc0b9d9e9ac1d')}
                      onClick={() => onRemove(row.id)}
                    >
                      {common('remove')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
