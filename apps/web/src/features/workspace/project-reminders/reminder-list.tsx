'use client';

import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { errorToast, successToast } from '@/components/ui/toast';
import { useTranslations } from '@/i18n/use-translations';
import type { ProjectReminder, SessionReminderState } from '@kortix/sdk';
import type { useProjectReminders } from '@kortix/sdk/react';
import { useCallback, useRef, useState, type ReactNode } from 'react';
import { reminderTitle } from './reminder-format';
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

/** The List view: one tab's reminders as a table in a centred column, with its loading and empty states and the filter footer. */
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

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-3 px-4 py-6">
        {!query.isLoading && rows.length === 0 ? (
          <p className="text-muted-foreground px-4 py-10 text-center text-sm">
            {t(EMPTY_TAB[tab])}
          </p>
        ) : (
          <Table data-testid="reminder-list">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>{t('columnReminder')}</TableHead>
                <TableHead className="hidden sm:table-cell">{t('columnSchedule')}</TableHead>
                <TableHead className="hidden lg:table-cell">{t('columnSession')}</TableHead>
                <TableHead className="hidden md:table-cell">{t('columnWhen')}</TableHead>
                <TableHead className="w-20">
                  <span className="sr-only">{t('columnActions')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody aria-busy={query.isLoading || undefined}>
              {query.isLoading
                ? [0, 1, 2, 3].map((key) => <ReminderRowSkeleton key={key} />)
                : rows.map((reminder) => (
                    <ReminderRow
                      key={reminder.id}
                      reminder={reminder}
                      projectId={projectId}
                      now={now}
                      pending={actions.pendingAction(reminder)}
                      disabled={actions.busy}
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
    </div>
  );
}
