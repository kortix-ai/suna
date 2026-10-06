'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { CaretUpIcon, PencilSimpleIcon, TrashIcon, XIcon } from '@phosphor-icons/react';
import { Fragment, useId, useState } from 'react';
import type { QueueRow } from '../queue-projection';

const STEER_FALLBACK_KEY = {
  unsupported: 'steerFallbackUnsupported',
  not_prompter: 'steerFallbackNotPrompter',
  turn_ended: 'steerFallbackTurnEnded',
} as const;

export interface QueuedPromptListProps {
  rows: readonly QueueRow[];
  heldCount: number;
  resumePending?: boolean;
  onResume?: () => void;
  onEdit?: (promptId: string) => void;
  onRemove?: (promptId: string) => void;
  onRetry?: (promptId: string) => void;
  /** "Stop and send": the turn ends after its running tool, then this row
   *  runs. Pass it only while a turn runs. */
  onStopAndSend?: (promptId: string) => void;
  /** The row the composer is editing. It stays in its slot, drawn as the
   *  editing row, until Submit saves the new text or Cancel drops the edit. */
  editing?: { promptId: string } | null;
  onCancelEdit?: () => void;
}

export function QueuedPromptList({
  rows,
  heldCount,
  resumePending = false,
  onResume,
  onEdit,
  onRemove,
  onRetry,
  onStopAndSend,
  editing = null,
  onCancelEdit,
}: QueuedPromptListProps) {
  const t = useTranslations('threads');
  const common = useTranslations('common');
  const copy = useTranslations('hardcodedUi.i18nComplete');
  const listId = useId();
  // Collapse only hides the rows. Nothing is removed, and the count stays.
  const [collapsed, setCollapsed] = useState(false);
  const listed = rows.length;
  if (listed === 0 && heldCount === 0) return null;
  // One edit at a time: the composer holds a single draft.
  const editRow = editing ? undefined : onEdit;

  const editingRow = (text: string) => (
    <li
      data-queued-editing
      className="flex min-h-8 items-center gap-2 rounded-md border border-dashed px-2 py-0.5"
    >
      <PencilSimpleIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
      <p className="text-muted-foreground min-w-0 flex-1 truncate text-sm">{text}</p>
      <span className="text-muted-foreground shrink-0 text-xs">{t('editingQueued')}</span>
      {onCancelEdit && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="text-muted-foreground shrink-0"
          aria-label={common('cancel')}
          onClick={onCancelEdit}
        >
          <XIcon className="size-3.5" />
        </Button>
      )}
    </li>
  );

  const heldActions = onResume && (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="h-6 gap-1 px-2 text-xs"
      disabled={resumePending}
      onClick={onResume}
    >
      {resumePending && <Loading className="size-3.5 shrink-0" />}
      {copy.raw('textd640c7421da0')}
    </Button>
  );

  return (
    <section
      aria-label={t('queueList')}
      className="bg-background border-border flex w-full flex-col rounded-lg border p-1"
    >
      {/* Paused with nothing listed: the pause is the whole card. With rows,
          the header below carries it instead. */}
      {heldCount > 0 && listed === 0 && (
        <div
          data-queue-held
          className="text-muted-foreground flex items-center gap-2 px-3 py-1 text-xs"
        >
          <span className="min-w-0 flex-1">{copy.raw('text1eb132d9d4da')}</span>
          {heldActions}
        </div>
      )}
      {listed > 0 && (
        <div
          {...(heldCount > 0 ? { 'data-queue-held': true } : {})}
          className="flex items-center gap-2 py-0.5 pr-1 pl-2"
        >
          <span className="text-muted-foreground flex min-w-0 flex-1 items-center self-stretch text-xs leading-none">
            {heldCount > 0 ? copy.raw('text1eb132d9d4da') : t('queuedCount', { count: listed })}
          </span>
          <div className="flex items-center gap-0">
            {heldCount > 0 && heldActions}
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className={cn(!collapsed ? 'rotate-180' : 'rotate-0')}
              aria-label={collapsed ? t('expandQueue') : t('collapseQueue')}
              aria-expanded={!collapsed}
              aria-controls={listId}
              onClick={() => setCollapsed((value) => !value)}
            >
              <CaretUpIcon className="size-3.5" />
            </Button>
          </div>
        </div>
      )}
      {listed > 0 && !collapsed && (
        <ul id={listId} className="max-h-40 overflow-y-auto">
          {rows.map((row, index) => {
            const failed = row.state === 'failed';
            const long = row.text.length > 240 || row.text.split('\n').length > 4;
            return (
              <Fragment key={row.id}>
                {row.id === editing?.promptId ? (
                  editingRow(row.text)
                ) : (
                  <li
                    data-queued-prompt-id={row.id}
                    data-queued-state={row.state}
                    className="group/queued hover:bg-hover flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-transparent px-2 py-0.5"
                  >
                    <div className="text-foreground min-w-0 flex-1 text-sm break-words">
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
                        <span className="text-muted-foreground text-xs">
                          {t('queuedFiles', { count: row.attachmentCount })}
                        </span>
                      )}
                      {!failed && (row.steer || row.steerFallback) && (
                        <p className="text-muted-foreground text-xs" data-queued-delivery>
                          {row.steerFallback
                            ? t(STEER_FALLBACK_KEY[row.steerFallback])
                            : t('steerNextStep')}
                        </p>
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
                        'text-muted-foreground flex shrink-0 items-center gap-0.5',
                        !failed &&
                          'opacity-0 group-focus-within/queued:opacity-100 group-hover/queued:opacity-100 pointer-coarse:opacity-100',
                      )}
                    >
                      {row.takeBackEligible && editRow && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          aria-label={common('edit')}
                          onClick={() => editRow(row.id)}
                        >
                          <PencilSimpleIcon className="size-3.5" />
                        </Button>
                      )}
                      {row.interruptible && onStopAndSend && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          onClick={() => onStopAndSend(row.id)}
                        >
                          {t('stopAndSend')}
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
                          size="icon-xs"
                          aria-label={copy.raw('textc0b9d9e9ac1d')}
                          onClick={() => onRemove(row.id)}
                        >
                          <TrashIcon className="size-3.5" />
                        </Button>
                      )}
                    </div>
                  </li>
                )}
              </Fragment>
            );
          })}
        </ul>
      )}
    </section>
  );
}
