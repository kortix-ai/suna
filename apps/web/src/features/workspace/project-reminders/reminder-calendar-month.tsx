'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { isSameDay, weekdayIndex, type CalendarDay, type CalendarModel } from './reminder-calendar-model';
import { DayPopover } from './reminder-day-popover';
import { FireChip, type CalendarContext } from './reminder-fire-popover';

/** Chips a cell shows before "+N more". */
const VISIBLE_CHIPS = 2;
const ROWS: Record<number, string> = { 4: 'grid-rows-4', 5: 'grid-rows-5', 6: 'grid-rows-6' };

/**
 * The Month range (M1): Monday-first weeks filling the height. A cell shows
 * up to 2 chips, then "+N more", where N counts every other fire that day,
 * frequent reminders included.
 */
export function CalendarMonth({
  model,
  month,
  ctx,
  loading,
  onOpenWeek,
}: {
  model: CalendarModel;
  /** The month on screen (0-11): days outside it are muted. */
  month: number;
  ctx: CalendarContext;
  loading: boolean;
  onOpenWeek: (day: Date) => void;
}) {
  const today = new Date(ctx.now);
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="reminder-calendar-month">
      <div className="grid shrink-0 grid-cols-7 border-b" aria-hidden>
        {model.days.slice(0, 7).map(({ date }) => (
          <span
            key={date.getTime()}
            className={cn(
              'border-l px-2 py-2 text-xs',
              weekdayIndex(date) >= 5 ? 'text-muted-foreground' : 'text-foreground',
            )}
          >
            {date.toLocaleDateString(ctx.locale, { weekday: 'short' })}
          </span>
        ))}
      </div>
      <div className={cn('grid min-h-0 flex-1 grid-cols-7', ROWS[model.days.length / 7])}>
        {model.days.map((day, index) => (
          <MonthCell
            key={day.date.getTime()}
            day={day}
            ctx={ctx}
            outside={day.date.getMonth() !== month}
            isToday={isSameDay(day.date, today)}
            loading={loading && index % 3 === 0}
            onOpenWeek={() => onOpenWeek(day.date)}
          />
        ))}
      </div>
    </div>
  );
}

function MonthCell({
  day,
  ctx,
  outside,
  isToday,
  loading,
  onOpenWeek,
}: {
  day: CalendarDay;
  ctx: CalendarContext;
  outside: boolean;
  isToday: boolean;
  loading: boolean;
  onOpenWeek: () => void;
}) {
  const shown = day.chips.slice(0, VISIBLE_CHIPS);
  const hidden = day.total - shown.length;
  return (
    <div
      className={cn(
        'flex min-h-0 min-w-0 flex-col gap-0.5 overflow-hidden border-b border-l p-1',
        weekdayIndex(day.date) >= 5 && 'bg-muted/40',
      )}
    >
      <span
        className={cn(
          'flex size-6 shrink-0 items-center justify-center rounded-full text-xs tabular-nums',
          outside ? 'text-muted-foreground' : 'text-foreground',
          isToday && 'ring-foreground font-medium ring-1',
        )}
        aria-current={isToday ? 'date' : undefined}
      >
        {day.date.getDate()}
      </span>
      {loading ? <Skeleton className="h-5 w-full py-0" /> : null}
      {shown.map((fire) => (
        <FireChip key={`${fire.reminder.id}-${fire.at}`} fire={fire} ctx={ctx} className="h-5 shrink-0" />
      ))}
      {hidden > 0 ? (
        <DayPopover day={day} hidden={hidden} locale={ctx.locale} onOpenWeek={onOpenWeek} />
      ) : null}
    </div>
  );
}
