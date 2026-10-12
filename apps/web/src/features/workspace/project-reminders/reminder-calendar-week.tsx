'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { memo, useEffect, useLayoutEffect, useRef, type CSSProperties } from 'react';
import {
  clockTime,
  dateFormat,
  DAY_MINUTES,
  daysBetween,
  isSameDay,
  layoutChips,
  minutesOfDay,
  startOfDay,
  weekdayIndex,
  type CalendarDay,
  type CalendarModel,
} from './reminder-calendar-model';
import { FireCard, FirePill } from './reminder-fire-chip';
import { reminderTitle } from './reminder-format';
import {
  useCalendarHighlight,
  useGridScroll,
  type GridTop,
  type ScrollRequest,
} from './use-calendar-scroll';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** A chip covers half an hour; a lone one with an hour free below is drawn an hour tall, on two lines. */
const CHIP_MINUTES = 30;
const TALL_MINUTES = 60;
const SCROLL_TO_HOUR = 8;
/** The gutter is `w-14`; columns split the rest of the scroller's width by 7. */
const GUTTER = 'calc(var(--spacing) * 14)';
/**
 * A day column splits the scroller's width, less the gutter, by the days in
 * view: 7 (Week) or 1 (Day). The count is a variable on the scroller, so this
 * style stays one constant and the memoized columns never re-render for it.
 */
const COLUMN: CSSProperties = { width: `calc((100cqw - ${GUTTER}) / var(--days-in-view))` };
/** Skeleton chips while loading: [weekday, hour]. */
const SKELETON_CHIPS = [
  [0, 9],
  [1, 13],
  [2, 10],
  [3, 15],
  [4, 9],
] as const;

/** The ring on a day a jump landed on: the focus ring's colour, inset so it never clips. */
export const LANDED_RING =
  'ring-ring/60 pointer-events-none absolute inset-0 z-20 ring-2 ring-inset transition-opacity duration-(--duration-slow)';

const pct = (minutes: number) => `${(minutes / DAY_MINUTES) * 100}%`;
const isWeekend = (date: Date) => weekdayIndex(date) >= 5;

/**
 * The Week and Day ranges: day columns that scroll sideways one day per snap
 * (7 or 1 in view), a sticky time gutter, the "All week" lane for frequent reminders,
 * and a 24-hour grid that opens scrolled to 08:00. The first visible day
 * is reported through `onTop`.
 */
export const CalendarWeek = memo(function CalendarWeek({
  daysInView,
  model,
  locale,
  today,
  now,
  loading,
  request,
  onTop,
  onSettle,
}: {
  /** 7 (Week) or 1 (Day). */
  daysInView: 7 | 1;
  model: CalendarModel;
  locale: string;
  /** Local midnight of today. */
  today: number;
  /** The clock, for the now line and its gutter label. */
  now: number;
  loading: boolean;
  request: ScrollRequest;
  onTop: (day: Date) => void;
  onSettle: (top: GridTop) => void;
}) {
  const t = useTranslations('reminders');
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const todayDate = new Date(today);
  // The fire a jump landed on: its day's column rings briefly, and the grid
  // scrolls its hour into view, a third of the way down.
  const highlight = useCalendarHighlight();
  const highlightDay = highlight === null ? null : startOfDay(highlight).getTime();
  useEffect(() => {
    const element = scroller.current;
    if (highlight === null || !element || !grid.current) return;
    const y = (grid.current.offsetHeight * minutesOfDay(highlight)) / DAY_MINUTES;
    element.scrollTo({ top: Math.max(0, y - element.clientHeight / 3) });
  }, [highlight]);
  // Open on the working day; the sticky header sits above the grid.
  useLayoutEffect(() => {
    if (scroller.current && grid.current) {
      scroller.current.scrollTop = (grid.current.offsetHeight * SCROLL_TO_HOUR) / 24;
    }
  }, []);

  // Day i's column is first in view at its distance from day 0's column:
  // `scroll-padding-left` keeps it clear of the gutter. Measured, not
  // `i * width`: each column is a fractional width the layout rounds, and a
  // computed offset a fraction off its snap point re-snapped as a jitter.
  const column = (index: number) =>
    grid.current?.querySelector<HTMLElement>(`[data-day="${index}"]`) ?? null;
  const columnOffset = (index: number) => {
    const first = column(0);
    const target = column(index);
    if (!first || !target) return null;
    return target.getBoundingClientRect().left - first.getBoundingClientRect().left;
  };

  const { onScroll, onPointerDown } = useGridScroll({
    scroller,
    axis: 'x',
    request,
    onTop,
    onSettle,
    measure: {
      offsetOf: (date) => {
        const index = daysBetween(model.days[0]!.date, date);
        return index >= 0 && index < model.days.length ? columnOffset(index) : null;
      },
      top: () => {
        const width = column(0)?.getBoundingClientRect().width ?? 0;
        const left = scroller.current?.scrollLeft ?? 0;
        if (!width) return null;
        const index = Math.min(Math.max(Math.round(left / width), 0), model.days.length - 1);
        const offset = columnOffset(index);
        return offset === null ? null : { date: model.days[index]!.date, delta: left - offset };
      },
    },
  });

  // Axis lock for a mostly vertical trackpad scroll. The two-finger gesture
  // carries a few pixels of sideways motion; on a day-snapping grid each
  // one nudged the columns and snapped them back, a sideways wobble while
  // scrolling the hours. Such a gesture scrolls the hours only. A mouse wheel
  // (no sideways delta) and a sideways or diagonal gesture stay native.
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      const { deltaX, deltaY, deltaMode } = event;
      if (deltaMode !== WheelEvent.DOM_DELTA_PIXEL || deltaX === 0) return;
      if (Math.abs(deltaY) < 2 * Math.abs(deltaX) || event.ctrlKey) return;
      event.preventDefault();
      element.scrollTop += deltaY;
    };
    element.addEventListener('wheel', onWheel, { passive: false });
    return () => element.removeEventListener('wheel', onWheel);
  }, []);

  return (
    <div
      ref={scroller}
      role="region"
      aria-label={daysInView === 1 ? t('calendarDay') : t('calendarWeek')}
      tabIndex={0}
      onScroll={onScroll}
      onPointerDown={onPointerDown}
      // `overflow-anchor: none`: the window re-centres with its own exact
      // offset; the browser's scroll anchoring would add a second shift.
      style={
        {
          containerType: 'inline-size',
          scrollPaddingLeft: GUTTER,
          overflowAnchor: 'none',
          '--days-in-view': daysInView,
        } as CSSProperties
      }
      className="focus-visible:ring-ring/50 relative min-h-0 flex-1 snap-x snap-mandatory overflow-auto overscroll-none outline-none focus-visible:ring-2"
      data-testid="reminder-calendar-week"
    >
      <div className="flex w-max flex-col">
        <div className="bg-background sticky top-0 z-30 border-b">
          <div className="flex">
            <span className="bg-background sticky left-0 z-10 w-14 shrink-0" />
            {model.days.map(({ date }) => (
              <DayHeader
                key={date.getTime()}
                date={date}
                locale={locale}
                isToday={isSameDay(date, todayDate)}
              />
            ))}
          </div>
          {model.frequent.length > 0 ? (
            <div className="flex border-t">
              <span className="bg-background text-muted-foreground sticky left-0 z-10 w-14 shrink-0 py-1.5 pr-2 text-right text-xs">
                {daysInView === 1 ? t('calendarAllDay') : t('calendarAllWeek')}
              </span>
              <div
                className="sticky left-14 flex min-w-0 flex-wrap gap-1 border-l p-1.5"
                style={{ width: `calc(100cqw - ${GUTTER})` }}
              >
                {model.frequent.map(({ reminder, fire }) => (
                  <FirePill
                    key={reminder.id}
                    fire={fire}
                    label={`${reminderTitle(reminder)} · ${t('calendarEvery', { period: reminder.every ?? '' })}`}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <div ref={grid} className="relative flex">
          <TimeGutter locale={locale} now={now} />
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            {HOURS.map((hour) => (
              <div key={hour} className="h-12 border-b" />
            ))}
          </div>
          {model.days.map((day, index) => (
            <DayColumn
              key={day.date.getTime()}
              index={index}
              day={day}
              locale={locale}
              loading={loading}
              now={isSameDay(day.date, todayDate) ? now : null}
              highlighted={highlightDay === day.date.getTime()}
            />
          ))}
        </div>
      </div>
    </div>
  );
});

const DayHeader = memo(function DayHeader({
  date,
  locale,
  isToday,
}: {
  date: Date;
  locale: string;
  isToday: boolean;
}) {
  return (
    <div
      style={COLUMN}
      className={cn(
        'flex shrink-0 items-center justify-center gap-1.5 border-l py-2 text-xs',
        isWeekend(date) ? 'bg-muted/40 text-muted-foreground' : 'text-foreground',
      )}
    >
      <span>{dateFormat(locale, { weekday: 'short' }).format(date)}</span>
      <span
        className={cn(
          'flex size-6 items-center justify-center rounded-sm tabular-nums',
          isToday && 'bg-foreground text-background font-medium',
        )}
        aria-current={isToday ? 'date' : undefined}
      >
        {date.getDate()}
      </span>
    </div>
  );
});

/** Hour labels, and the current time in red on today's row. Sticky on the left. */
function TimeGutter({ locale, now }: { locale: string; now: number }) {
  return (
    <div className="bg-background sticky left-0 z-20 w-14 shrink-0" aria-hidden>
      {HOURS.map((hour) => (
        <div key={hour} className="text-muted-foreground h-12 pr-2 text-right text-xs tabular-nums">
          {hour === 0 ? null : clockTime(new Date(2000, 0, 1, hour), locale)}
        </div>
      ))}
      <span
        className="bg-kortix-red text-background absolute right-1 -translate-y-1/2 rounded-sm px-1 text-xs tabular-nums"
        style={{ top: pct(minutesOfDay(now)) }}
        data-testid="reminder-now-label"
      >
        {clockTime(now, locale)}
      </span>
    </div>
  );
}

/** One day column. Memoized: a scroll or a clock tick re-renders no column but today's. */
const DayColumn = memo(function DayColumn({
  index,
  day,
  locale,
  loading,
  now,
  highlighted,
}: {
  index: number;
  day: CalendarDay;
  locale: string;
  loading: boolean;
  /** The clock, on today's column only: it draws the now line. */
  now: number | null;
  /** A jump landed on this day: a focus ring, held briefly, then faded. */
  highlighted: boolean;
}) {
  const weekday = weekdayIndex(day.date);
  return (
    <div
      data-day={index}
      style={COLUMN}
      className={cn(
        'relative shrink-0 snap-start snap-normal border-l',
        isWeekend(day.date) && 'bg-muted/40',
      )}
    >
      {/* Always mounted, so the ring fades out instead of vanishing. */}
      <span aria-hidden className={cn(LANDED_RING, highlighted ? 'opacity-100' : 'opacity-0')} />
      {loading
        ? SKELETON_CHIPS.filter(([skeletonDay]) => skeletonDay === weekday).map(([, hour]) => (
            <Skeleton
              key={hour}
              className="absolute inset-x-1 py-0"
              style={{ top: pct(hour * 60), height: pct(CHIP_MINUTES * 2) }}
            />
          ))
        : layoutChips(day.chips, CHIP_MINUTES, TALL_MINUTES).map(
            ({ fire, top, lane, lanes, span }) => (
              <FireCard
                key={`${fire.reminder.id}-${fire.at}`}
                fire={fire}
                locale={locale}
                tall={span > CHIP_MINUTES}
                style={{
                  // A fire after 23:30 still fits inside the column.
                  top: pct(Math.min(top, DAY_MINUTES - span)),
                  height: pct(span),
                  left: `${(lane / lanes) * 100}%`,
                  width: `calc(${100 / lanes}% - 2px)`,
                }}
              />
            ),
          )}
      {now !== null ? (
        <div
          className="bg-kortix-red pointer-events-none absolute inset-x-0 z-10 h-0.5"
          style={{ top: pct(minutesOfDay(now)) }}
          data-testid="reminder-now-line"
          aria-hidden
        />
      ) : null}
    </div>
  );
});
