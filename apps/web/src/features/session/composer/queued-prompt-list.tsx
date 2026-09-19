'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { CaretUpIcon, PencilSimpleIcon, TrashIcon } from '@phosphor-icons/react';
import { useEffect, useId, useRef, useState } from 'react';
import { queueFailureLine } from '../queue-failure-copy';
import type { QueueRow } from '../queue-projection';

/**
 * How long a POINTER activation is ignored after the list shifts.
 *
 * A Remove takes its row off the list at once, and the next row slides up under
 * the pointer with its own Remove button in the same place. Without this, the
 * second click of a double-click activates that row and removes a prompt the
 * user never chose. 400 ms covers the platform double-click interval; a
 * deliberate second removal costs one extra beat.
 */
export const QUEUE_ROW_ACTION_COOLDOWN_MS = 400;

/** What a row's buttons do. Remove and Send now take the row off the list. */
export type QueueRowAction = 'remove' | 'edit' | 'retry' | 'sendNow';

/**
 * Does this action take its row off the list, and so shift every row below it?
 *
 * Remove, and Send now, which moves the row into the Quick Queue. Edit keeps
 * the row where it is while the composer holds its words, and Retry re-queues
 * it in place.
 */
function shiftsTheList(action: QueueRowAction): boolean {
  return action === 'remove' || action === 'sendNow';
}

/**
 * Does this activation act on the row the user meant?
 *
 * Keyboard activations (`MouseEvent.detail === 0` for Space and Enter on a
 * focused button) are never blocked: focus moves deliberately, and blocking
 * them would strand a keyboard user for 400 ms after every removal.
 */
export function acceptRowAction(input: {
  /** `MouseEvent.detail`. 0 means the keyboard raised the click. */
  detail: number;
  nowMs: number;
  /** When this list last shifted under the pointer, or `null` for never. */
  lastShiftAtMs: number | null;
  pendingAction?: QueueRow['pendingAction'];
}): boolean {
  if (input.pendingAction) return false;
  if (input.detail === 0) return true;
  if (input.lastShiftAtMs === null) return true;
  return input.nowMs - input.lastShiftAtMs >= QUEUE_ROW_ACTION_COOLDOWN_MS;
}

/**
 * The whole gate: whether to run this activation, and when the list next
 * shifted. A refused activation never re-arms the cooldown — otherwise a
 * held-down double-click would extend the block indefinitely.
 */
export function nextRowActionState(input: {
  action: QueueRowAction;
  /** `MouseEvent.detail`. 0 means the keyboard raised the click. */
  detail: number;
  nowMs: number;
  lastShiftAtMs: number | null;
  pendingAction?: QueueRow['pendingAction'];
}): { accepted: boolean; lastShiftAtMs: number | null } {
  if (!acceptRowAction(input)) return { accepted: false, lastShiftAtMs: input.lastShiftAtMs };
  return {
    accepted: true,
    lastShiftAtMs: shiftsTheList(input.action) ? input.nowMs : input.lastShiftAtMs,
  };
}

/**
 * Has the row that held focus lost the button focus was on?
 *
 * Retry and Remove both take their own row out of `failed` — Retry re-queues
 * it, Remove deletes it — so the focused button unmounts under the user. Focus
 * then falls to `<body>` and the next keystroke goes nowhere. It is only taken
 * when it was actually dropped: focus the user moved somewhere else is left
 * alone.
 */
export function focusMovesToComposer(input: {
  focusedRowId: string | null;
  rows: readonly QueueRow[];
  activeElementIsBody: boolean;
}): boolean {
  if (!input.focusedRowId || !input.activeElementIsBody) return false;
  return !input.rows.some((row) => row.id === input.focusedRowId && row.state === 'failed');
}

/**
 * Which row's actions hold focus, after one focus or blur.
 *
 * The latch may only survive a focus loss caused by the row's OWN unmount:
 * React's delegated listener never sees the focusout of a node it has already
 * detached, so a blur that DOES arrive is the user moving away. Keeping the
 * latch past that leaves it stale, and then any later `rows` change while focus
 * happens to sit on `<body>` yanks the caret into the composer unasked.
 *
 * Moving between two buttons of one row is a no-op overall: focusout bubbles
 * from the old button before focusin bubbles from the new one.
 */
export function focusedRowAfter(
  current: string | null,
  event: { type: 'focus' | 'blur'; rowId: string },
): string | null {
  if (event.type === 'focus') return event.rowId;
  return current === event.rowId ? null : current;
}

/** The composer's own focus request — see `useComposerFocus`. */
function focusComposer(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new CustomEvent('focus-session-textarea'));
}

export interface QueuedPromptListProps {
  rows: readonly QueueRow[];
  heldCount: number;
  resumePending?: boolean;
  /** The row this composer is editing. It reads Editing and offers nothing. */
  editingId?: string | null;
  /** Start with the rows hidden behind the header. */
  defaultCollapsed?: boolean;
  onResume?: () => void;
  onSendNow?: (promptId: string) => void;
  onEdit?: (promptId: string) => void;
  onRemove?: (promptId: string) => void;
  onRetry?: (promptId: string) => void;
}

export function QueuedPromptList({
  rows,
  heldCount,
  resumePending = false,
  editingId = null,
  defaultCollapsed = false,
  onResume,
  onSendNow,
  onEdit,
  onRemove,
  onRetry,
}: QueuedPromptListProps) {
  const t = useTranslations('threads');
  const common = useTranslations('common');
  const copy = useTranslations('hardcodedUi');
  const listId = useId();
  // Collapse only hides the rows. Nothing is removed, and the count stays.
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  // Read and written in event handlers only, never during render. `nowMs` comes
  // from the handler for the same reason: the clock is not read while rendering.
  const lastShiftAtRef = useRef<number | null>(null);
  const act = (
    event: { detail: number },
    row: QueueRow,
    action: QueueRowAction,
    nowMs: number,
    run: () => void,
  ) => {
    const next = nextRowActionState({
      action,
      detail: event.detail,
      nowMs,
      lastShiftAtMs: lastShiftAtRef.current,
      pendingAction: row.pendingAction,
    });
    lastShiftAtRef.current = next.lastShiftAtMs;
    if (next.accepted) run();
  };
  // Which row's actions hold focus, stamped by the button's own focus event.
  const focusedRowRef = useRef<string | null>(null);
  useEffect(() => {
    if (
      !focusMovesToComposer({
        focusedRowId: focusedRowRef.current,
        rows,
        activeElementIsBody: document.activeElement === document.body,
      })
    )
      return;
    focusedRowRef.current = null;
    focusComposer();
  }, [rows]);
  if (rows.length === 0 && heldCount === 0) return null;

  const resumeButton = onResume && (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      className="h-6 gap-1 px-2 text-xs"
      disabled={resumePending}
      onClick={onResume}
    >
      {resumePending && <Loading className="size-3.5 shrink-0" />}
      {copy.raw('i18nComplete.textd640c7421da0')}
    </Button>
  );

  return (
    <section
      aria-label={t('queueList')}
      className="bg-background border-border flex w-full flex-col rounded-lg border p-1"
    >
      {/* Paused with nothing listed: the pause is the whole card. With rows,
          the header below carries it instead. */}
      {heldCount > 0 && rows.length === 0 && (
        <div
          data-queue-held
          className="text-muted-foreground flex items-center gap-2 px-3 py-1 text-xs"
        >
          <span className="min-w-0 flex-1">{copy.raw('i18nComplete.text1eb132d9d4da')}</span>
          {resumeButton}
        </div>
      )}
      {rows.length > 0 && (
        <div
          {...(heldCount > 0 ? { 'data-queue-held': true } : {})}
          className="flex items-center gap-2 py-0.5 pr-1 pl-2"
        >
          <span className="text-muted-foreground flex min-w-0 flex-1 items-center self-stretch text-xs leading-none">
            {heldCount > 0
              ? copy.raw('i18nComplete.text1eb132d9d4da')
              : t('queuedCount', { count: rows.length })}
          </span>

          <div className="flex items-center gap-0">
            {heldCount > 0 && resumeButton}
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
      {rows.length > 0 && !collapsed && (
        <ul id={listId} className="max-h-40 overflow-y-auto">
          {rows.map((row) => {
            const failed = row.state === 'failed';
            const editing = row.id === editingId;
            const long = row.text.length > 240 || row.text.split('\n').length > 4;
            const failureId = `queued-failure-${row.id}`;
            const failure = failed
              ? queueFailureLine({
                  failureCode: row.failureCode,
                  lastError: row.lastError,
                  copy: (key) => copy.raw(key),
                })
              : null;
            // Every button is `aria-disabled`, never `disabled`: disabling the
            // button the user just pressed drops focus to <body>.
            const pending = Boolean(row.pendingAction);
            const actionProps = failed
              ? { 'aria-disabled': pending, 'aria-describedby': failureId }
              : { 'aria-disabled': pending };
            const removeButton = row.removable && onRemove && (
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={copy.raw('i18nComplete.textc0b9d9e9ac1d')}
                {...actionProps}
                onClick={(event) => act(event, row, 'remove', Date.now(), () => onRemove(row.id))}
              >
                {row.pendingAction === 'remove' ? (
                  <Loading className="size-3.5 shrink-0" />
                ) : (
                  <TrashIcon className="size-3.5" />
                )}
              </Button>
            );
            return (
              <li
                key={row.id}
                data-queued-prompt-id={row.id}
                data-queued-state={row.state}
                {...(editing ? { 'data-queued-editing': 'true' } : {})}
                aria-busy={pending || undefined}
                onFocus={() => {
                  focusedRowRef.current = focusedRowAfter(focusedRowRef.current, {
                    type: 'focus',
                    rowId: row.id,
                  });
                }}
                onBlur={() => {
                  focusedRowRef.current = focusedRowAfter(focusedRowRef.current, {
                    type: 'blur',
                    rowId: row.id,
                  });
                }}
                {...(row.pendingAction ? { 'data-queued-pending': row.pendingAction } : {})}
                className={cn(
                  'group/queued flex min-h-8 flex-wrap items-center gap-x-2 gap-y-1 rounded-md border px-2 py-0.5',
                  editing ? 'border-border' : 'hover:bg-hover border-transparent',
                )}
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
                  {failure && (
                    <p
                      id={failureId}
                      className="text-kortix-red text-xs"
                      role="status"
                      title={failure.title}
                    >
                      {failure.text}
                    </p>
                  )}
                </div>
                {editing ? (
                  <div className="text-muted-foreground flex shrink-0 items-center gap-0.5">
                    <span className="px-2 text-sm">{t('editingQueued')}</span>
                  </div>
                ) : (
                  <div
                    className={cn(
                      'text-muted-foreground flex shrink-0 items-center gap-0.5',
                      !failed &&
                        'opacity-0 group-focus-within/queued:opacity-100 group-hover/queued:opacity-100 pointer-coarse:opacity-100',
                    )}
                  >
                    {row.canSendNow && onSendNow && (
                      <Hint side="top" label={t('sendNowHint')}>
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="h-6 gap-1 px-2 text-xs"
                          {...actionProps}
                          onClick={(event) =>
                            act(event, row, 'sendNow', Date.now(), () => onSendNow(row.id))
                          }
                        >
                          {t('sendNow')}
                        </Button>
                      </Hint>
                    )}
                    {row.takeBackEligible && onEdit && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={common('edit')}
                        {...actionProps}
                        onClick={(event) =>
                          act(event, row, 'edit', Date.now(), () => onEdit(row.id))
                        }
                      >
                        <PencilSimpleIcon className="size-3.5" />
                      </Button>
                    )}
                    {/* A session that no longer exists refuses every retry, so
                        the row offers only Remove. */}
                    {failed && row.retryable && onRetry && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="xs"
                        aria-label={copy.raw('i18nComplete.text942087cc2d41')}
                        {...actionProps}
                        onClick={(event) =>
                          act(event, row, 'retry', Date.now(), () => onRetry(row.id))
                        }
                      >
                        {row.pendingAction === 'retry' && <Loading className="size-3.5 shrink-0" />}
                        {copy.raw('i18nComplete.text942087cc2d41')}
                      </Button>
                    )}
                    {removeButton}
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
