'use client';

import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useTranslations } from '@/i18n/use-translations';
import { clockTime, type CalendarDay } from './reminder-calendar-model';
import { reminderTitle } from './reminder-format';

/**
 * "+N more" in a month cell: the day's fires grouped by reminder
 * ("09:00 Title ×288"), and a jump to that day in the Week view.
 */
export function DayPopover({
  day,
  hidden,
  locale,
  onOpenWeek,
}: {
  day: CalendarDay;
  /** The N in "+N more". */
  hidden: number;
  locale: string;
  onOpenWeek: () => void;
}) {
  const t = useTranslations('reminders');
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="link"
          size="sm"
          className="text-muted-foreground h-auto justify-start px-1 py-0 text-xs"
          data-testid="reminder-day-more"
        >
          {t('calendarMore', { count: hidden })}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="flex flex-col gap-3" data-testid="reminder-day-popover">
        <p className="text-foreground text-sm font-medium">
          {day.date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' })}
        </p>
        <ul className="flex max-h-64 flex-col gap-1.5 overflow-y-auto">
          {day.groups.map(({ reminder, first, count }) => (
            <li key={reminder.id} className="flex items-center gap-2 text-xs">
              <span className="text-muted-foreground shrink-0 tabular-nums">{clockTime(first, locale)}</span>
              <span className="text-foreground min-w-0 flex-1 truncate" title={reminder.prompt}>
                {reminderTitle(reminder)}
              </span>
              {count > 1 ? (
                <span className="text-muted-foreground shrink-0 tabular-nums">×{count}</span>
              ) : null}
            </li>
          ))}
        </ul>
        <Button variant="link" size="sm" className="h-auto justify-start p-0 text-xs" onClick={onOpenWeek}>
          {t('calendarOpenWeek')}
        </Button>
      </PopoverContent>
    </Popover>
  );
}
