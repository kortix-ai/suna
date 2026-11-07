'use client';

import { Button } from '../../primitives/button';
import Loading from '../../primitives/loading';
import { CountBadge } from '../../primitives/count-badge';
import { parseNoticeBatch } from '../turn/subagent-notice';
import { useTranslations } from '../../i18n';
import { cn } from '../../lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../primitives/dropdown-menu';
import {
  ArrowClockwiseIcon,
  ArrowUpIcon,
  CaretUpIcon,
  CaretRightIcon,
  DotsThreeIcon,
  PencilSimpleIcon,
  StopIcon,
  TrashIcon,
  XIcon,
} from '@phosphor-icons/react';
import { Fragment, useId, useState, type ReactNode } from 'react';
import type { QueueRow } from './queue-projection';

const STEER_FALLBACK_KEY = {
  unsupported: 'steerFallbackUnsupported',
  not_prompter: 'steerFallbackNotPrompter',
  turn_ended: 'steerFallbackTurnEnded',
} as const;

export type QueuedRowActionKey = 'edit' | 'retry' | 'sendNow' | 'stopAndSend' | 'remove';

const ACTION_ICON: Record<QueuedRowActionKey, ReactNode> = {
  edit: <PencilSimpleIcon className="size-4" />,
  retry: <ArrowClockwiseIcon className="size-4" />,
  sendNow: <ArrowUpIcon className="size-4" />,
  stopAndSend: <StopIcon className="size-4" />,
  remove: <TrashIcon className="size-4" />,
};

/** The actions a row's menu offers, in menu order, each bound to the row. */
export function queuedRowActions(
  row: QueueRow,
  handlers: {
    onEdit?: (promptId: string) => void;
    onRetry?: (promptId: string) => void;
    onStopAndSend?: (promptId: string) => void;
    onRemove?: (promptId: string) => void;
  },
): { key: QueuedRowActionKey; run: () => void }[] {
  const { onEdit, onRetry, onStopAndSend, onRemove } = handlers;
  const actions: { key: QueuedRowActionKey; run: () => void }[] = [];
  if (row.takeBackEligible && onEdit) actions.push({ key: 'edit', run: () => onEdit(row.id) });
  // Send now / Retry: one primitive, two labels. The inbox's one retry
  // primitive answers a failed row's "Retry" and a queued row's "Send now" —
  // and the queued call doubles as the gentler twin of "Stop and send": the
  // live turn keeps running, and this row is answered first at the next
  // drain. Another member's row runs as them, so only they may hurry it (the
  // projection already scopes `retryable` to the viewer's own row). A row
  // already handed to the running turn (`steer` with no fallback) has nothing
  // to hurry — the turn reads it at its next step — so it keeps only Remove.
  if (
    onRetry &&
    !row.command &&
    !row.fromAnotherMember &&
    (row.retryable || (row.state === 'queued' && !(row.steer && !row.steerFallback)))
  ) {
    actions.push({ key: row.state === 'failed' ? 'retry' : 'sendNow', run: () => onRetry(row.id) });
  }
  if (row.interruptible && onStopAndSend) {
    actions.push({ key: 'stopAndSend', run: () => onStopAndSend(row.id) });
  }
  if (row.removable && onRemove) actions.push({ key: 'remove', run: () => onRemove(row.id) });
  return actions;
}

/** The SDK owns parsing; this disclosure shows only the report's readable content. */
function QueuedMessageText({ row }: { row: QueueRow }) {
  const copy = useTranslations('multiAgent.notice');
  const t = useTranslations('threads');
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const notices = row.synthetic ? parseNoticeBatch(row.rawText) : null;
  const reports = notices?.flatMap((item) => (item.kind === 'peer_idle' ? [] : [item.notice]));
  const parsed = reports?.length && reports.length === notices?.length ? reports : null;
  const reportTitle = (notice: NonNullable<typeof parsed>[number]) =>
    notice.title || notice.handle || notice.agent || notice.excerpt || copy('source');
  const title = parsed
    ? parsed.length > 1
      ? copy('updateCount', { count: parsed.length })
      : reportTitle(parsed[0]!)
    : row.synthetic
      ? copy('source')
      : row.text.split('\n').find((line) => line.trim()) || t('queued');
  const expandable = Boolean(
    parsed || (!row.synthetic && (row.text.includes('\n') || row.text.length > 100)),
  );
  const secondary =
    parsed &&
    (parsed.length > 1
      ? parsed.map(reportTitle).join(', ')
      : [
          copy('source'),
          parsed[0]!.status === 'failed'
            ? copy('statusFailedShort')
            : parsed[0]!.status === 'stopped'
              ? copy('statusStoppedShort')
              : null,
          !open && parsed[0]!.excerpt !== title && parsed[0]!.excerpt,
        ]
          .filter(Boolean)
          .join(' · '));
  const heading = (
    <span className="min-w-0 flex-1">
      <span
        id={!parsed ? contentId : undefined}
        className={cn(
          'block',
          parsed
            ? 'truncate'
            : open
              ? 'break-words whitespace-pre-wrap'
              : 'line-clamp-2 break-words',
        )}
      >
        {open && !parsed ? row.text : title}
      </span>
      {secondary && (
        <span className="text-muted-foreground block truncate text-xs">{secondary}</span>
      )}
    </span>
  );
  return (
    <div className="min-w-0">
      {expandable ? (
        <button
          type="button"
          className="focus-visible:outline-ring flex w-full min-w-0 items-start gap-2 rounded-sm text-left focus-visible:outline-2"
          aria-expanded={open}
          aria-controls={contentId}
          onClick={() => setOpen((value) => !value)}
        >
          {heading}
          <CaretRightIcon
            aria-hidden="true"
            className={cn('text-muted-foreground mt-0.5 size-3.5 shrink-0', open && 'rotate-90')}
          />
        </button>
      ) : (
        <p className="break-words whitespace-pre-wrap">{title}</p>
      )}
      {open && parsed && (
        <div
          id={contentId}
          className="text-muted-foreground mt-2 space-y-3 text-sm leading-relaxed break-words whitespace-pre-wrap"
        >
          {parsed
            ? parsed.map((notice) => (
                <div key={notice.sessionId}>
                  {parsed.length > 1 && (
                    <p className="text-foreground font-medium">{reportTitle(notice)}</p>
                  )}
                  {parsed.length > 1 && (
                    <p className="text-xs">
                      {copy('source')}
                      {notice.status !== 'completed' &&
                        ` · ${copy(notice.status === 'failed' ? 'statusFailedShort' : 'statusStoppedShort')}`}
                    </p>
                  )}
                  {notice.result}
                  {notice.ownedTasks && (
                    <p className="mt-2 text-xs">
                      {copy('ownsTasks', { tasks: notice.ownedTasks })}
                    </p>
                  )}
                </div>
              ))
            : row.text}
        </div>
      )}
    </div>
  );
}

export interface QueuedPromptListProps {
  rows: readonly QueueRow[];
  heldCount: number;
  resumePending?: boolean;
  onResume?: () => void;
  onEdit?: (promptId: string) => void;
  onRemove?: (promptId: string) => void;
  /** Run THIS prompt through the inbox's one retry primitive: a failed row's
   *  "Retry", a queued row's "Send now" — the row is promoted past the
   *  ordering gate and answered first, without touching the live turn. When
   *  a Stop hold keeps other rows back, the same call is the hold's release:
   *  the batch drains in queue order in one turn (KRTX-683). */
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
  const sharedSteer =
    heldCount === 0 &&
    listed > 0 &&
    rows.every((row) => row.state !== 'failed' && row.steer && !row.steerFallback);
  if (listed === 0 && heldCount === 0) return null;
  // One edit at a time: the composer holds a single draft.
  const editRow = editing ? undefined : onEdit;
  const actionLabel: Record<QueuedRowActionKey, string> = {
    edit: common('edit'),
    retry: copy.raw('text942087cc2d41'),
    sendNow: copy.raw('text588032878324'),
    stopAndSend: t('stopAndSend'),
    remove: copy.raw('textc0b9d9e9ac1d'),
  };

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
          <span className="text-muted-foreground flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <span className="text-foreground font-medium">
              {heldCount > 0 ? copy.raw('text1eb132d9d4da') : t('queued')}
            </span>
            <CountBadge count={listed} />
            {sharedSteer && <span data-queued-delivery>{t('steerNextStep')}</span>}
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
        <ul id={listId} className="max-h-40 overflow-y-auto overscroll-contain">
          {rows.map((row) => {
            const failed = row.state === 'failed';
            const actions = queuedRowActions(row, {
              onEdit: editRow,
              onRetry,
              onStopAndSend,
              onRemove,
            });
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
                      <QueuedMessageText row={row} />
                      {row.attachmentCount > 0 && (
                        <span className="text-muted-foreground text-xs">
                          {t('queuedFiles', { count: row.attachmentCount })}
                        </span>
                      )}
                      {row.fromAnotherMember && (
                        <p className="text-muted-foreground text-xs" data-queued-author="other">
                          {t('queuedByAnotherMember')}
                        </p>
                      )}
                      {row.command && (
                        <p className="text-muted-foreground text-xs" data-queued-command>
                          {t('commandRunsWhenDone')}
                        </p>
                      )}
                      {heldCount === 0 &&
                        !sharedSteer &&
                        !failed &&
                        (row.steer || row.steerFallback) && (
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
                    {actions.length > 0 && (
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon-xs"
                            data-queued-actions
                            aria-label={t('queuedActions')}
                            className={cn(
                              'text-muted-foreground hover:text-foreground shrink-0',
                              !failed &&
                                'opacity-0 group-focus-within/queued:opacity-100 group-hover/queued:opacity-100 data-[state=open]:opacity-100 pointer-coarse:opacity-100',
                            )}
                          >
                            <DotsThreeIcon className="size-3.5" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          {actions.map((action) => (
                            <Fragment key={action.key}>
                              {action.key === 'remove' && actions.length > 1 && (
                                <DropdownMenuSeparator />
                              )}
                              <DropdownMenuItem
                                variant={action.key === 'remove' ? 'destructive' : 'default'}
                                onSelect={action.run}
                                className="gap-2"
                              >
                                {ACTION_ICON[action.key]}
                                {actionLabel[action.key]}
                              </DropdownMenuItem>
                            </Fragment>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
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
