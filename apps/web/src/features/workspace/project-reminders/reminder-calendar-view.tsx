'use client';

import { Button } from '@/components/ui/button';
import { FLOATING_PANEL_SURFACE } from '@/components/ui/menu-recipe';
import { EmptyState } from '@/features/layout/section/empty-state';
import { useDebounce } from '@/hooks/use-debounce';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectReminder } from '@kortix/sdk';
import { memo, useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react';
import {
  calendarModel,
  dateFormat,
  dateParam,
  firstFireAt,
  isSameDay,
  nearEdge,
  nearestFireDay,
  parseDateParam,
  startOfDay,
  startOfWeek,
  visibleSpan,
  windowDays,
  type CalendarModel,
} from './reminder-calendar-model';
import { CalendarMonth } from './reminder-calendar-month';
import { CalendarWeek } from './reminder-calendar-week';
import { CalendarActions, FirePopoverHost, type CalendarContext } from './reminder-fire-popover';
import { nearestFire } from './reminder-format';
import { useReminderActions, type RemindersQuery } from './reminder-list';
import {
  TITLE_SETTLE_MS,
  useCalendarStore,
  useCalendarTop,
  type GridTop,
  type ScrollRequest,
} from './use-calendar-scroll';
import { useRemindersUrlState, type RemindersRange } from './use-reminders-url-state';

/**
 * The last model built for a reminders list, so a clock tick reuses every
 * day it cannot have changed. Keyed by the list: new data starts fresh.
 */
const lastModel = new WeakMap<readonly ProjectReminder[], CalendarModel>();

/**
 * The Calendar view (`?view=calendar`): the scheduled and inferred-past fires
 * of the scoped reminders, as a sideways-scrolling Day or Week time grid or
 * a vertically scrolling Month of week rows. The toolbar cluster is
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
  // Month's day number: that day in the Day range.
  const openDay = useCallback(
    (date: Date) => {
      store.setTop(startOfDay(date));
      set({ range: 'day' });
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
          {/* Keyed: each range keeps its own window. */}
          <CalendarRange
            key={range}
            range={range}
            locale={locale}
            reminders={reminders}
            minute={minute}
            loading={query.isLoading}
            onOpenDay={openDay}
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
  onOpenDay,
}: {
  range: RemindersRange;
  locale: string;
  reminders: ProjectReminder[];
  minute: number;
  loading: boolean;
  onOpenDay: (date: Date) => void;
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
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {range === 'month' ? (
        <CalendarMonth {...grid} onOpenDay={onOpenDay} />
      ) : (
        <CalendarWeek {...grid} now={minute} daysInView={range === 'day' ? 1 : 7} />
      )}
      {loading ? null : (
        <RangeHint range={range} model={model} reminders={reminders} today={today} />
      )}
    </div>
  );
});

const EMPTY_TITLE = {
  day: 'calendarEmptyDay',
  week: 'calendarEmptyWeek',
  month: 'calendarEmptyMonth',
} as const;

/**
 * The button to a fire outside the range on screen, in this range's unit:
 * the day, its Monday-first week, or its month. The day lands ringed so the
 * eye finds it.
 */
function GoToFire({ range, at }: { range: RemindersRange; at: number }) {
  const target = startOfDay(at);
  const t = useTranslations('reminders');
  const locale = useLocale();
  const store = useCalendarStore();
  const label =
    range === 'day'
      ? t('calendarGoToDay', {
          date: dateFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(
            target,
          ),
        })
      : range === 'week'
        ? t('calendarGoToWeek', {
            date: dateFormat(locale, { day: 'numeric', month: 'long' }).format(startOfWeek(target)),
          })
        : t('calendarGoToMonth', {
            month: dateFormat(locale, { month: 'long', year: 'numeric' }).format(target),
          });
  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="reminder-calendar-go-to"
      onClick={() =>
        store.jump(range === 'week' ? startOfWeek(target) : target, false, new Date(at))
      }
    >
      {label}
    </Button>
  );
}

/**
 * Over the grid, when the day, week or month on screen has no fire but the
 * reminders fire some other time: says so, with the button to the nearest
 * day that has one. It follows the settled scroll, so flicking through empty
 * weeks does not flash it.
 */
function RangeHint({
  range,
  model,
  reminders,
  today,
}: {
  range: RemindersRange;
  model: CalendarModel;
  reminders: ProjectReminder[];
  today: number;
}) {
  const t = useTranslations('reminders');
  const live = useCalendarTop((top) => dateParam(top));
  const { debouncedValue: settled } = useDebounce(live, TITLE_SETTLE_MS);
  const target = useMemo(() => {
    const span = visibleSpan(parseDateParam(settled, today), range);
    const inView = model.days.some(
      (day) => day.total > 0 && day.date >= span.from && day.date < span.to,
    );
    if (inView) return null;
    const near = nearestFireDay(model.days, span);
    const day = near && model.days.find((each) => each.date.getTime() === near.getTime());
    return day ? firstFireAt(day) : nearestFire(reminders);
  }, [settled, today, range, model.days, reminders]);
  if (target === null) return null;
  return (
    <div
      className={cn(
        FLOATING_PANEL_SURFACE,
        'absolute top-1/2 left-1/2 z-30 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-3 px-5 py-4',
      )}
      data-testid="reminder-range-hint"
    >
      <p className="text-foreground text-sm font-medium">{t(EMPTY_TITLE[range])}</p>
      <GoToFire range={range} at={target} />
    </div>
  );
}

/**
 * Nothing fires anywhere in the window. When the scoped reminders fire some
 * other time (a filtered session, a past one-off), one button goes there.
 * With no time at all, it offers today.
 */
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
  const nearest = nearestFire(reminders);
  const showsToday = days.some((day) => isSameDay(day, new Date(today)));
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center"
      data-testid="reminder-calendar-empty"
    >
      <EmptyState
        size="sm"
        title={t(EMPTY_TITLE[range])}
        action={
          nearest !== null ? (
            <GoToFire range={range} at={nearest} />
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
