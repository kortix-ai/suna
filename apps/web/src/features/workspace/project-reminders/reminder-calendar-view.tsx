'use client';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import type { ProjectReminder } from '@kortix/sdk';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  calendarModel,
  isSameDay,
  nearEdge,
  startOfDay,
  startOfWeek,
  windowDays,
  type CalendarModel,
} from './reminder-calendar-model';
import { CalendarMonth } from './reminder-calendar-month';
import { CalendarWeek } from './reminder-calendar-week';
import { CalendarActions, FirePopoverHost, type CalendarContext } from './reminder-fire-popover';
import { soonestFire } from './reminder-format';
import { useReminderActions, type RemindersQuery } from './reminder-list';
import { useCalendarStore, type GridTop, type ScrollRequest } from './use-calendar-scroll';
import { useRemindersUrlState, type RemindersRange } from './use-reminders-url-state';

/**
 * The last model built for a reminders list, so a clock tick reuses every
 * day it cannot have changed. Keyed by the list: new data starts fresh.
 */
const lastModel = new WeakMap<readonly ProjectReminder[], CalendarModel>();

/**
 * The Calendar view (`?view=calendar`): the scheduled and inferred-past fires
 * of the scoped reminders, as a sideways-scrolling Week time grid or a
 * vertically scrolling Month of week rows. The toolbar cluster is
 * `ReminderCalendarNav`; gate-off, zero reminders and the load error are
 * handled by the page shell, the same as the List.
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
  // The tabs switch at once; the other range mounts as a background render,
  // so a slow mount never holds the click.
  const range = useDeferredValue(url.range);
  const actions = useReminderActions(query);
  const store = useCalendarStore();
  const { set } = url;
  // Month's day number: that day's week, Monday first, in the Week range.
  const openWeek = useCallback(
    (date: Date) => {
      store.select(startOfDay(date));
      store.setTop(startOfWeek(date));
      set({ range: 'week' });
    },
    [store, set],
  );
  // `now` ticks every 30 s; fires only move by the minute.
  const minute = Math.floor(now / 60_000) * 60_000;
  const card = useMemo<CalendarContext>(
    () => ({ projectId, now: minute, locale }),
    [projectId, minute, locale],
  );
  // No cron parser on the client: a cron reminder shows only its next fire.
  const hasCron = reminders.some((r) => r.state === 'active' && r.cron);

  return (
    <CalendarActions.Provider value={actions}>
      <FirePopoverHost ctx={card} reminders={reminders}>
        <div className="flex min-h-0 flex-1 flex-col" aria-busy={query.isLoading || undefined}>
          {/* Keyed: Week and Month each keep their own window. */}
          <CalendarRange
            key={range}
            range={range}
            locale={locale}
            reminders={reminders}
            minute={minute}
            loading={query.isLoading}
            onOpenWeek={openWeek}
          />
          {hasCron ? (
            <p className="text-muted-foreground px-4 py-2 text-xs">{t('calendarCronNote')}</p>
          ) : null}
        </div>
      </FirePopoverHost>
      {actions.dialog}
    </CalendarActions.Provider>
  );
}

/**
 * One range's window of days and where its grid scrolls.
 *
 * The window is `windowDays(origin)`. It moves only when the scroll settles
 * near its edge, or on a jump to a day outside it, and every move comes with
 * a scroll request for the day at the top and the pixels into it, so what is
 * on screen stays put.
 */
const CalendarRange = memo(function CalendarRange({
  range,
  locale,
  reminders,
  minute,
  loading,
  onOpenWeek,
}: {
  range: RemindersRange;
  locale: string;
  reminders: ProjectReminder[];
  minute: number;
  loading: boolean;
  onOpenWeek: (date: Date) => void;
}) {
  const store = useCalendarStore();
  const today = startOfDay(minute).getTime();
  const [origin, setOrigin] = useState(() => store.top());
  const [request, setRequest] = useState<ScrollRequest>(() => ({
    date: store.top(),
    delta: 0,
    smooth: false,
  }));
  const days = useMemo(() => windowDays(origin, range), [origin, range]);
  const model = useMemo(() => {
    const next = calendarModel(reminders, days, minute, lastModel.get(reminders));
    lastModel.set(reminders, next);
    return next;
  }, [reminders, days, minute]);

  // Today and "Jump to next fire". A day outside the window moves the window
  // first, and that jump is instant: the grid under it is new.
  useEffect(
    () =>
      store.onJump(({ date, smooth }) => {
        const far = nearEdge(date, origin, range);
        if (far) setOrigin(date);
        setRequest({ date, delta: 0, smooth: smooth && !far });
      }),
    [store, origin, range],
  );

  const onSettle = useCallback(
    (top: GridTop) => {
      if (!nearEdge(top.date, origin, range)) return;
      setOrigin(top.date);
      setRequest({ ...top, smooth: false });
    },
    [origin, range],
  );

  if (!loading && model.total === 0) {
    return <CalendarEmpty range={range} reminders={reminders} days={days} today={today} />;
  }
  const grid = { model, locale, today, loading, request, onTop: store.setTop, onSettle };
  return range === 'week' ? (
    <CalendarWeek {...grid} now={minute} />
  ) : (
    <CalendarMonth {...grid} onOpenWeek={onOpenWeek} />
  );
});

function CalendarEmpty({
  range,
  reminders,
  days,
  today,
}: {
  range: RemindersRange;
  reminders: ProjectReminder[];
  days: Date[];
  today: number;
}) {
  const t = useTranslations('reminders');
  const store = useCalendarStore();
  const soonest = soonestFire(reminders);
  const showsToday = days.some((day) => isSameDay(day, new Date(today)));
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center"
      data-testid="reminder-calendar-empty"
    >
      <EmptyState
        size="sm"
        title={range === 'week' ? t('calendarEmptyWeek') : t('calendarEmptyMonth')}
        action={
          soonest !== null ? (
            <Button variant="outline" size="sm" onClick={() => store.jump(startOfDay(soonest))}>
              {t('calendarJumpToNext')}
            </Button>
          ) : !showsToday ? (
            <Button variant="outline" size="sm" onClick={() => store.jump(new Date(today))}>
              {t('calendarBackToToday')}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}
