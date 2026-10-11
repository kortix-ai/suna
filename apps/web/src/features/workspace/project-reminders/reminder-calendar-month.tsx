'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useDebounce } from '@/hooks/use-debounce';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { memo, useMemo, useRef } from 'react';
import {
  dateFormat,
  daysBetween,
  focusMonth,
  isSameDay,
  monthEntries,
  startOfDay,
  startOfWeek,
  weekdayIndex,
  type CalendarDay,
  type CalendarModel,
} from './reminder-calendar-model';
import { LANDED_RING } from './reminder-calendar-week';
import { FireRow } from './reminder-fire-chip';
import {
  TITLE_SETTLE_MS,
  useCalendarHighlight,
  useCalendarTop,
  useGridScroll,
  type GridTop,
  type ScrollRequest,
} from './use-calendar-scroll';

const isWeekend = (date: Date) => weekdayIndex(date) >= 5;
/** A month as one number, year * 12 + month. */
const monthKey = (date: Date) => date.getFullYear() * 12 + date.getMonth();

/**
 * The Month range: a vertical list of Monday-first week rows. A row is as
 * tall as its fullest day; every fire is listed. The toolbar title follows
 * the week at the top through `onTop`.
 *
 * It snaps to each week's start. A week taller than the view scrolls freely
 * inside itself before the next snap; the window only moves once the scroll
 * has settled (see `useGridScroll`), so a snap never fights a moving grid.
 */
export const CalendarMonth = memo(function CalendarMonth({
  model,
  locale,
  today,
  loading,
  request,
  onTop,
  onSettle,
  onOpenDay,
}: {
  model: CalendarModel;
  locale: string;
  /** Local midnight of today. */
  today: number;
  loading: boolean;
  request: ScrollRequest;
  onTop: (monday: Date) => void;
  onSettle: (top: GridTop) => void;
  /** A day number was pressed: show that day in the Day range. */
  onOpenDay: (date: Date) => void;
}) {
  const t = useTranslations('reminders');
  const scroller = useRef<HTMLDivElement>(null);
  // The month on screen: days outside it are muted. Debounced with the
  // title, so both change together once the scroll settles.
  const { debouncedValue: focus } = useDebounce(
    useCalendarTop((top) => monthKey(focusMonth(top))),
    TITLE_SETTLE_MS,
  );
  const weeks = useMemo(
    () =>
      Array.from({ length: model.days.length / 7 }, (_, i) => model.days.slice(i * 7, i * 7 + 7)),
    [model.days],
  );
  const todayDate = new Date(today);
  // The fire a jump landed on: its day's cell rings briefly.
  const landed = useCalendarHighlight();
  const highlight = landed === null ? null : startOfDay(landed).getTime();

  const { onScroll, onPointerDown } = useGridScroll({
    scroller,
    axis: 'y',
    request,
    onTop,
    onSettle,
    measure: {
      offsetOf: (date) => {
        const row =
          scroller.current?.children[daysBetween(model.days[0]!.date, startOfWeek(date)) / 7];
        return row instanceof HTMLElement ? row.offsetTop : null;
      },
      top: () => {
        const element = scroller.current;
        if (!element) return null;
        const rows = element.children;
        for (let i = 0; i < rows.length; i++) {
          const row = rows[i] as HTMLElement;
          if (row.offsetTop + row.offsetHeight > element.scrollTop + 1) {
            return { date: weeks[i]![0]!.date, delta: element.scrollTop - row.offsetTop };
          }
        }
        return null;
      },
    },
  });

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="reminder-calendar-month">
      <div className="grid shrink-0 grid-cols-7 border-b" aria-hidden>
        {model.days.slice(0, 7).map(({ date }) => (
          <span
            key={date.getTime()}
            className={cn(
              // Dividers between columns only: the page edge is the first one's left.
              'text-muted-foreground border-l px-2 py-1.5 text-right text-xs first:border-l-0',
              isWeekend(date) && 'bg-muted/40',
            )}
          >
            {dateFormat(locale, { weekday: 'short' }).format(date)}
          </span>
        ))}
      </div>
      <div
        ref={scroller}
        role="region"
        aria-label={t('calendarMonth')}
        tabIndex={0}
        onScroll={onScroll}
        onPointerDown={onPointerDown}
        // `overflow-anchor: none`: the window re-centres with its own exact
        // offset; the browser's scroll anchoring would add a second shift.
        style={{ overflowAnchor: 'none' }}
        className="focus-visible:ring-ring/50 relative min-h-0 flex-1 snap-y snap-mandatory overflow-y-auto overscroll-none outline-none focus-visible:ring-2"
      >
        {weeks.map((days, index) => (
          <WeekRow
            key={days[0]!.date.getTime()}
            days={days}
            locale={locale}
            focus={days.some((day) => monthKey(day.date) === focus) ? focus : null}
            today={days.some((day) => isSameDay(day.date, todayDate)) ? today : null}
            highlight={days.some((day) => day.date.getTime() === highlight) ? highlight : null}
            loading={loading && index % 2 === 0}
            onOpenDay={onOpenDay}
          />
        ))}
      </div>
    </div>
  );
});

type WeekRowProps = {
  days: CalendarDay[];
  locale: string;
  /** The month on screen, when one of this week's days is in it: the rest are muted. */
  focus: number | null;
  /** Today's midnight, when today is in this week. */
  today: number | null;
  /** The day a jump landed on, when it is in this week. */
  highlight: number | null;
  loading: boolean;
  onOpenDay: (date: Date) => void;
};

/**
 * One week row. Memoized on its seven day objects, which the model reuses
 * across clock ticks: a scroll re-renders no row, a new month re-renders
 * the rows that hold the old or new month, and a clock tick only today's.
 */
const WeekRow = memo(
  function WeekRow({ days, locale, focus, today, highlight, loading, onOpenDay }: WeekRowProps) {
    return (
      <div className="grid min-h-24 snap-start grid-cols-7 border-b">
        {days.map((day) => (
          <DayCell
            key={day.date.getTime()}
            day={day}
            locale={locale}
            outside={focus === null || monthKey(day.date) !== focus}
            isToday={today === day.date.getTime()}
            highlighted={highlight === day.date.getTime()}
            loading={loading && day.date.getDay() === 3}
            onOpenDay={onOpenDay}
          />
        ))}
      </div>
    );
  },
  (a: WeekRowProps, b: WeekRowProps) =>
    a.locale === b.locale &&
    a.focus === b.focus &&
    a.today === b.today &&
    a.highlight === b.highlight &&
    a.loading === b.loading &&
    a.onOpenDay === b.onOpenDay &&
    a.days.every((day, i) => day === b.days[i]),
);

function DayCell({
  day,
  locale,
  outside,
  isToday,
  highlighted,
  loading,
  onOpenDay,
}: {
  day: CalendarDay;
  locale: string;
  outside: boolean;
  isToday: boolean;
  highlighted: boolean;
  loading: boolean;
  onOpenDay: (date: Date) => void;
}) {
  const t = useTranslations('reminders');
  const { date } = day;
  const name = dateFormat(locale, { weekday: 'long', day: 'numeric', month: 'long' }).format(date);
  return (
    <div
      className={cn(
        // Dividers between days only: Monday sits on the page edge, which has its own line.
        'relative min-w-0 border-l first:border-l-0',
        isWeekend(date) && 'bg-muted/40',
      )}
    >
      <span aria-hidden className={cn(LANDED_RING, highlighted ? 'opacity-100' : 'opacity-0')} />
      {/* Days outside the month on screen recede as a whole: number and fires. */}
      <div
        className={cn(
          'flex min-w-0 flex-col gap-px px-1 pt-1 pb-2 transition-opacity duration-(--duration-moderate)',
          outside && 'opacity-40',
        )}
      >
        <button
          type="button"
          onClick={() => onOpenDay(date)}
          aria-label={t('calendarShowDay', { date: name })}
          aria-current={isToday ? 'date' : undefined}
          className={cn(
            'group/date focus-visible:ring-ring/50 relative flex h-6 min-w-6 shrink-0 items-center justify-center self-end rounded-sm px-1.5 text-xs tabular-nums outline-none focus-visible:ring-2',
            'transition-[background-color,color,scale] duration-(--duration-fast) active:scale-96',
            isToday
              ? 'bg-foreground text-background hover:bg-foreground/85 font-medium'
              : 'text-foreground hover:bg-secondary',
          )}
        >
          {date.getDate()}
          {/* The full date, styled as `Hint`. CSS, not a Radix tooltip: a
              Month window has ~175 dates, and a tooltip root on each one
              is what the shared fire card replaced. Shows after the same
              300 ms hover, at once on keyboard focus, and hides within 100 ms. */}
          <span
            aria-hidden
            className={cn(
              'bg-foreground text-background ring-foreground/5 pointer-events-none absolute top-full right-0 z-30 mt-1 rounded-sm px-2 py-1 text-xs font-normal whitespace-nowrap ring-1',
              'invisible transition-[visibility] duration-(--duration-fast) group-hover/date:visible group-hover/date:delay-300 group-focus-visible/date:visible group-focus-visible/date:delay-0',
            )}
          >
            {name}
          </span>
        </button>
        {loading ? <Skeleton className="h-4 w-full py-0" /> : null}
        {monthEntries(day).map(({ fire, count }) => (
          <FireRow
            key={`${fire.reminder.id}-${fire.at}`}
            fire={fire}
            locale={locale}
            count={count}
            card={isToday}
          />
        ))}
      </div>
    </div>
  );
}
