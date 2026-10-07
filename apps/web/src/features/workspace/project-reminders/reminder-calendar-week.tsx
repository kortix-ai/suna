'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { useEffect, useRef } from 'react';
import {
  clockTime,
  DAY_MINUTES,
  isSameDay,
  layoutChips,
  minutesOfDay,
  weekdayIndex,
  type CalendarModel,
} from './reminder-calendar-model';
import { reminderTitle } from './reminder-format';
import { FireChip, type CalendarContext } from './reminder-fire-popover';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
/** A chip is drawn half an hour tall; closer fires go side by side. */
const CHIP_MINUTES = 30;
const SCROLL_TO_HOUR = 8;
const GUTTER = 'w-14 shrink-0';
/** Skeleton chips while loading: [weekday, hour]. */
const SKELETON_CHIPS = [
  [0, 9],
  [1, 13],
  [2, 10],
  [3, 15],
  [4, 9],
] as const;

const pct = (minutes: number) => `${(minutes / DAY_MINUTES) * 100}%`;
const isWeekend = (date: Date) => weekdayIndex(date) >= 5;

/**
 * The Week range (W1): day header, the "All week" lane for frequent
 * reminders, then a 24-hour grid that opens scrolled to 08:00.
 */
export function CalendarWeek({
  model,
  ctx,
  loading,
}: {
  model: CalendarModel;
  ctx: CalendarContext;
  loading: boolean;
}) {
  const t = useTranslations('reminders');
  const scroller = useRef<HTMLDivElement>(null);
  const grid = useRef<HTMLDivElement>(null);
  const today = new Date(ctx.now);

  // Open on the working day; the sticky header sits above the grid, so the
  // grid's own offset is the header's height.
  useEffect(() => {
    if (scroller.current && grid.current) {
      scroller.current.scrollTop = (grid.current.offsetHeight * SCROLL_TO_HOUR) / 24;
    }
  }, []);

  return (
    <div ref={scroller} className="relative min-h-0 flex-1 overflow-y-auto" data-testid="reminder-calendar-week">
      <div className="bg-background sticky top-0 z-20 border-b">
        <div className="flex">
          <span className={GUTTER} />
          <div className="grid flex-1 grid-cols-7">
            {model.days.map(({ date }) => {
              const isToday = isSameDay(date, today);
              return (
                <div
                  key={date.getTime()}
                  className={cn(
                    'flex items-center justify-center gap-1.5 border-l py-2 text-xs',
                    isWeekend(date) ? 'bg-muted/40 text-muted-foreground' : 'text-foreground',
                  )}
                >
                  <span>{date.toLocaleDateString(ctx.locale, { weekday: 'short' })}</span>
                  <span
                    className={cn(
                      'flex size-6 items-center justify-center rounded-full tabular-nums',
                      isToday && 'bg-foreground text-background font-medium',
                    )}
                    aria-current={isToday ? 'date' : undefined}
                  >
                    {date.getDate()}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
        {model.frequent.length > 0 ? (
          <div className="flex border-t">
            <span className={cn(GUTTER, 'text-muted-foreground py-1.5 pr-2 text-right text-xs')}>
              {t('calendarAllWeek')}
            </span>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1 border-l p-1.5">
              {model.frequent.map(({ reminder, fire }) => (
                <FireChip
                  key={reminder.id}
                  fire={fire}
                  ctx={ctx}
                  className="max-w-full py-0.5"
                  label={`${reminderTitle(reminder)} · ${t('calendarEvery', { period: reminder.every ?? '' })}`}
                />
              ))}
            </div>
          </div>
        ) : null}
      </div>
      <div ref={grid} className="relative flex">
        <div className={GUTTER} aria-hidden>
          {HOURS.map((hour) => (
            <div key={hour} className="text-muted-foreground h-12 pr-2 text-right text-xs tabular-nums">
              {hour === 0 ? null : clockTime(new Date(2000, 0, 1, hour), ctx.locale)}
            </div>
          ))}
        </div>
        <div className="relative grid flex-1 grid-cols-7">
          <div className="pointer-events-none absolute inset-0" aria-hidden>
            {HOURS.map((hour) => (
              <div key={hour} className="h-12 border-b" />
            ))}
          </div>
          {model.days.map((day, index) => {
            const isToday = isSameDay(day.date, today);
            return (
              <div
                key={day.date.getTime()}
                className={cn('relative border-l', isWeekend(day.date) && 'bg-muted/40')}
              >
                {loading
                  ? SKELETON_CHIPS.filter(([weekday]) => weekday === index).map(([, hour]) => (
                      <Skeleton
                        key={hour}
                        className="absolute inset-x-1 py-0"
                        style={{ top: pct(hour * 60), height: pct(CHIP_MINUTES * 2) }}
                      />
                    ))
                  : layoutChips(day.chips, CHIP_MINUTES).map(({ fire, top, lane, lanes }) => (
                      <FireChip
                        key={`${fire.reminder.id}-${fire.at}`}
                        fire={fire}
                        ctx={ctx}
                        className="absolute z-10"
                        style={{
                          // A fire after 23:30 still fits inside the column.
                          top: pct(Math.min(top, DAY_MINUTES - CHIP_MINUTES)),
                          height: pct(CHIP_MINUTES),
                          left: `${(lane / lanes) * 100}%`,
                          width: `${100 / lanes}%`,
                        }}
                      />
                    ))}
                {isToday ? (
                  <div
                    className="bg-kortix-red pointer-events-none absolute inset-x-0 z-10 h-0.5"
                    style={{ top: pct(minutesOfDay(ctx.now)) }}
                    data-testid="reminder-now-line"
                    aria-hidden
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
