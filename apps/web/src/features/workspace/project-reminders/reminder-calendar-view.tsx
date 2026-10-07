'use client';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { ProjectReminder } from '@kortix/sdk';
import { useMemo } from 'react';
import {
  calendarModel,
  dateParam,
  isSameDay,
  parseDateParam,
  rangeDays,
  startOfDay,
} from './reminder-calendar-model';
import { CalendarMonth } from './reminder-calendar-month';
import { CalendarWeek } from './reminder-calendar-week';
import type { CalendarContext } from './reminder-fire-popover';
import { soonestFire } from './reminder-format';
import { useReminderActions, type RemindersQuery } from './reminder-list';
import { useRemindersUrlState } from './use-reminders-url-state';

/**
 * The Calendar view (`?view=calendar`): the scheduled and inferred-past fires
 * of the scoped reminders, as a Week time grid or a Month grid. The toolbar
 * cluster is `ReminderCalendarNav`; gate-off, zero reminders and the load
 * error are handled by the page shell, the same as the List.
 */
export function ReminderCalendarView({
  projectId,
  query,
  reminders,
  now,
}: {
  projectId: string;
  query: RemindersQuery;
  reminders: ProjectReminder[];
  now: number;
}) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  const url = useRemindersUrlState();
  const actions = useReminderActions(query);
  // `now` ticks every 30 s; fires only move by the minute.
  const minute = Math.floor(now / 60_000) * 60_000;
  const today = startOfDay(minute).getTime();
  const anchor = useMemo(() => parseDateParam(url.date, today), [url.date, today]);
  const days = useMemo(() => rangeDays(anchor, url.range), [anchor, url.range]);
  const model = useMemo(() => calendarModel(reminders, days, minute), [reminders, days, minute]);
  const loading = query.isLoading;
  const ctx: CalendarContext = { projectId, now, locale, actions };
  const openDay = (date: Date) => url.set({ range: 'week', date: dateParam(date) });
  // No cron parser on the client: a cron reminder shows only its next fire.
  const hasCron = reminders.some((r) => r.state === 'active' && r.cron);

  let body;
  if (!loading && model.total === 0) {
    const soonest = soonestFire(reminders);
    const showsToday = days.some((day) => isSameDay(day, new Date(now)));
    body = (
      <div className="flex min-h-0 flex-1 items-center justify-center" data-testid="reminder-calendar-empty">
        <EmptyState
          size="sm"
          title={url.range === 'week' ? t('calendarEmptyWeek') : t('calendarEmptyMonth')}
          action={
            soonest !== null ? (
              <Button variant="outline" size="sm" onClick={() => url.set({ date: dateParam(new Date(soonest)) })}>
                {t('calendarJumpToNext')}
              </Button>
            ) : !showsToday ? (
              <Button variant="outline" size="sm" onClick={() => url.set({ date: null })}>
                {t('calendarBackToToday')}
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  } else if (url.range === 'week') {
    body = <CalendarWeek model={model} ctx={ctx} loading={loading} />;
  } else {
    body = (
      <CalendarMonth model={model} month={anchor.getMonth()} ctx={ctx} loading={loading} onOpenWeek={openDay} />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" aria-busy={loading || undefined}>
      {body}
      {hasCron ? <p className="text-muted-foreground px-4 py-2 text-xs">{t('calendarCronNote')}</p> : null}
      {actions.dialog}
    </div>
  );
}
