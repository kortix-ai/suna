'use client';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import Hint from '@/components/ui/hint';
import Loading from '@/components/ui/loading';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import { hasOpenFloatingLayer } from '@/lib/z-stack';
import type {
  ProjectReminder,
  SessionReminderBatchResult,
  SessionReminderState,
} from '@kortix/sdk';
import type { useProjectReminders } from '@kortix/sdk/react';
import { PauseIcon, PlayIcon, TrashIcon, XIcon } from '@phosphor-icons/react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { reminderTitle } from './reminder-format';
import { selectionState, toggleSelection } from './reminder-list-model';
import { ReminderRow, ReminderRowSkeleton, type RowPending } from './reminder-row';

export type RemindersQuery = ReturnType<typeof useProjectReminders>;

const EMPTY_TAB = { active: 'emptyActive', paused: 'emptyPaused', done: 'emptyDone' } as const;

/**
 * Pause, resume and remove with their toasts. A reminder is pending while its
 * own mutation runs; the SDK refetches the list before the mutation settles.
 */
export function useReminderActions(query: RemindersQuery) {
  const t = useTranslations('reminders');
  const [removing, setRemoving] = useState<ProjectReminder | null>(null);
  const failed = (error: unknown) =>
    errorToast(error instanceof Error ? error.message : t('updateFailed'));

  const setEnabled = (reminder: ProjectReminder, enabled: boolean) => {
    if (query.update.isPending || query.remove.isPending) return;
    query.update.mutate(
      { sessionId: reminder.session_id as string, reminderId: reminder.id, enabled },
      { onSuccess: () => successToast(enabled ? t('resumed') : t('paused')), onError: failed },
    );
  };

  // Stable identities for the memoized rows: the handlers read the latest
  // render through a ref, so a clock tick or a mutation state change does not
  // hand every row a new callback and re-render the whole list.
  const latest = useRef(setEnabled);
  latest.current = setEnabled;
  const toggle = useCallback(
    (reminder: ProjectReminder) => latest.current(reminder, reminder.state !== 'active'),
    [],
  );

  const confirmRemove = () => {
    if (!removing || query.update.isPending || query.remove.isPending) return;
    query.remove.mutate(
      { sessionId: removing.session_id as string, reminderId: removing.id },
      {
        onSuccess: () => {
          successToast(t('removed'));
          setRemoving(null);
        },
        onError: failed,
      },
    );
  };

  /**
   * `update` and `remove` are one mutation each: a second call would replace
   * the first's variables and drop its toast. So every row's actions are
   * disabled while either runs, and the row that owns the request shows it.
   */
  const busy = query.update.isPending || query.remove.isPending;
  const pendingAction = (reminder: ProjectReminder): RowPending =>
    query.update.isPending && query.update.variables?.reminderId === reminder.id
      ? 'toggle'
      : query.remove.isPending && query.remove.variables?.reminderId === reminder.id
        ? 'remove'
        : null;

  const dialog = (
    <ConfirmDialog
      open={!!removing}
      onOpenChange={(open) => !open && setRemoving(null)}
      title={t('removeTitle')}
      description={
        removing
          ? t('removeDescriptionNamed', {
              title: reminderTitle(removing),
              session: removing.session_name ?? t('untitledSession'),
            })
          : ''
      }
      confirmLabel={t('remove')}
      confirmVariant="destructive"
      isPending={query.remove.isPending}
      onConfirm={confirmRemove}
    />
  );

  return { setEnabled, toggle, setRemoving, busy, pendingAction, dialog };
}

type BulkKind = 'pause' | 'resume' | 'remove';

const BULK_DONE = { pause: 'bulkPaused', resume: 'bulkResumed', remove: 'bulkRemoved' } as const;

/**
 * The List's selection and what it can do: pause, resume or remove every
 * selected reminder in one batch (`updateMany` / `removeMany`: a few requests
 * at a time, one list refresh at the end). Reminders that fail stay selected
 * so the batch can be retried; the rest leave the selection.
 */
function useSelection(query: RemindersQuery, rows: ProjectReminder[]) {
  const t = useTranslations('reminders');
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmRemove, setConfirmRemove] = useState(false);
  const anchor = useRef<string | null>(null);
  const ids = useMemo(() => rows.map((reminder) => reminder.id), [rows]);
  // Read by `onSelect`, which stays one function so the memoized rows keep it.
  const latestIds = useRef(ids);
  useEffect(() => {
    latestIds.current = ids;
  }, [ids]);

  const chosen = useMemo(
    () => rows.filter((reminder) => selected.has(reminder.id)),
    [rows, selected],
  );
  const state = selectionState(selected, ids);
  const pending = query.updateMany.isPending || query.removeMany.isPending;
  // The reminders in the batch that is running: they show as pending.
  const inFlight = useMemo(() => {
    const batch = query.updateMany.isPending
      ? query.updateMany.variables?.reminders
      : query.removeMany.isPending
        ? query.removeMany.variables?.reminders
        : undefined;
    return new Set(batch?.map((reminder) => reminder.reminderId));
  }, [
    query.updateMany.isPending,
    query.updateMany.variables,
    query.removeMany.isPending,
    query.removeMany.variables,
  ]);

  const onSelect = useCallback((reminder: ProjectReminder, range: boolean) => {
    // Read now: the updater runs later, after the anchor below has moved.
    const from = range ? anchor.current : null;
    setSelected((current) => toggleSelection(current, latestIds.current, reminder.id, from));
    anchor.current = reminder.id;
  }, []);
  const selectAll = () => setSelected(state === 'all' ? new Set() : new Set(ids));
  const clear = () => setSelected(new Set());

  // Escape clears a selection from anywhere on the page, unless a dialog or
  // menu is open: that Escape is theirs.
  const hasSelection = chosen.length > 0;
  useEffect(() => {
    if (!hasSelection) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented || hasOpenFloatingLayer()) return;
      setSelected(new Set());
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [hasSelection]);

  const report = (kind: BulkKind, result: SessionReminderBatchResult) => {
    if (result.done.length > 0) successToast(t(BULK_DONE[kind], { count: result.done.length }));
    if (result.failed.length > 0) errorToast(t('bulkFailed', { count: result.failed.length }));
    setSelected(new Set(result.failed.map((failure) => failure.reminder.reminderId)));
  };

  const run = (kind: BulkKind) => {
    if (pending || chosen.length === 0) return;
    const reminders = chosen.map((reminder) => ({
      sessionId: reminder.session_id as string,
      reminderId: reminder.id,
    }));
    const done = { onSuccess: (result: SessionReminderBatchResult) => report(kind, result) };
    const failed = { onError: () => errorToast(t('updateFailed')) };
    if (kind === 'remove') {
      query.removeMany.mutate(
        { reminders },
        { ...done, ...failed, onSettled: () => setConfirmRemove(false) },
      );
    } else {
      query.updateMany.mutate({ reminders, enabled: kind === 'resume' }, { ...done, ...failed });
    }
  };

  return {
    selected,
    chosen,
    state,
    pending,
    /** A pause or resume batch is running (Remove shows its progress in the dialog). */
    updating: query.updateMany.isPending,
    inFlight,
    onSelect,
    selectAll,
    clear,
    run,
    confirmRemove,
    setConfirmRemove,
  };
}

/**
 * The table header. With nothing selected it names the columns. With a
 * selection, the Reminder column reads "3 selected" with a clear button, and
 * the empty actions column holds the batch actions for this tab: Pause on
 * Active, Resume on Paused, Remove everywhere.
 */
function ReminderListHeader({
  tab,
  selection,
}: {
  tab: SessionReminderState;
  selection: ReturnType<typeof useSelection>;
}) {
  const t = useTranslations('reminders');
  const count = selection.chosen.length;
  const toggleKind: BulkKind | null =
    tab === 'active' ? 'pause' : tab === 'paused' ? 'resume' : null;
  const busy = selection.pending;
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead className="w-0 pr-0">
          <Checkbox
            checked={
              selection.state === 'all'
                ? true
                : selection.state === 'some'
                  ? 'indeterminate'
                  : false
            }
            aria-label={t('selectAll')}
            onClick={selection.selectAll}
          />
        </TableHead>
        <TableHead aria-live="polite">
          {count > 0 ? (
            <span className="text-foreground flex items-center gap-1 font-medium">
              {t('selectedCount', { count })}
              <Hint label={t('clearSelection')} side="top">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('clearSelection')}
                  onClick={selection.clear}
                >
                  <XIcon className="size-3.5 shrink-0" />
                </Button>
              </Hint>
            </span>
          ) : (
            t('columnReminder')
          )}
        </TableHead>
        <TableHead className="hidden sm:table-cell">{t('columnSchedule')}</TableHead>
        <TableHead className="hidden lg:table-cell">{t('columnSession')}</TableHead>
        <TableHead className="hidden md:table-cell">{t('columnWhen')}</TableHead>
        <TableHead className="w-20">
          {count > 0 ? (
            <div className="flex items-center justify-end gap-1">
              {toggleKind ? (
                <Hint label={t(toggleKind === 'pause' ? 'bulkPause' : 'bulkResume')} side="top">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t(toggleKind === 'pause' ? 'bulkPause' : 'bulkResume')}
                    aria-disabled={busy || undefined}
                    onClick={busy ? undefined : () => selection.run(toggleKind)}
                  >
                    {selection.updating ? (
                      <Loading className="size-4" />
                    ) : toggleKind === 'pause' ? (
                      <PauseIcon className="size-4 shrink-0" />
                    ) : (
                      <PlayIcon className="size-4 shrink-0" />
                    )}
                  </Button>
                </Hint>
              ) : null}
              <Hint label={t('bulkRemove')} side="top">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t('bulkRemove')}
                  aria-disabled={busy || undefined}
                  onClick={busy ? undefined : () => selection.setConfirmRemove(true)}
                >
                  <TrashIcon className="size-4 shrink-0" />
                </Button>
              </Hint>
            </div>
          ) : (
            <span className="sr-only">{t('columnActions')}</span>
          )}
        </TableHead>
      </TableRow>
    </TableHeader>
  );
}

/**
 * The List view: one tab's reminders as a table in a centred column, with its
 * loading and empty states and the filter footer. Rows can be selected for a
 * batch pause, resume or remove; Escape clears the selection. The page keys
 * this by tab and filter, so a new tab starts with nothing selected.
 */
export function ReminderList({
  projectId,
  query,
  rows,
  tab,
  now,
  footer,
}: {
  projectId: string;
  query: RemindersQuery;
  rows: ProjectReminder[];
  tab: SessionReminderState;
  now: number;
  footer?: ReactNode;
}) {
  const t = useTranslations('reminders');
  const actions = useReminderActions(query);
  const selection = useSelection(query, rows);
  const count = selection.chosen.length;
  const locked = actions.busy || selection.pending;

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-6">
        {!query.isLoading && rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">
            {t(EMPTY_TAB[tab])}
          </p>
        ) : (
          <Table data-testid="reminder-list">
            <ReminderListHeader tab={tab} selection={selection} />
            <TableBody aria-busy={query.isLoading || selection.pending || undefined}>
              {query.isLoading
                ? [0, 1, 2, 3].map((key) => <ReminderRowSkeleton key={key} />)
                : rows.map((reminder) => (
                    <ReminderRow
                      key={reminder.id}
                      reminder={reminder}
                      projectId={projectId}
                      now={now}
                      pending={
                        selection.inFlight.has(reminder.id)
                          ? 'bulk'
                          : actions.pendingAction(reminder)
                      }
                      disabled={locked}
                      selected={selection.selected.has(reminder.id)}
                      onSelect={selection.onSelect}
                      onToggle={actions.toggle}
                      onRemove={actions.setRemoving}
                    />
                  ))}
            </TableBody>
          </Table>
        )}
        {footer}
      </div>
      {actions.dialog}
      <ConfirmDialog
        open={selection.confirmRemove}
        onOpenChange={(open) => !open && !selection.pending && selection.setConfirmRemove(false)}
        title={t('bulkRemoveTitle', { count })}
        description={t('bulkRemoveDescription')}
        confirmLabel={t('remove')}
        confirmVariant="destructive"
        isPending={query.removeMany.isPending}
        onConfirm={() => selection.run('remove')}
      />
    </div>
  );
}
