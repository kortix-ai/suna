'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { useDebounce } from '@/hooks/use-debounce';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { CaretDownIcon, CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { rangeLabel, startOfDay, stepDate } from './reminder-calendar-model';
import { TITLE_SETTLE_MS, useCalendarStore, useCalendarTop } from './use-calendar-scroll';
import { useRemindersUrlState, type RemindersRange } from './use-reminders-url-state';

const RANGES = ['day', 'week', 'month'] as const satisfies readonly RemindersRange[];
const RANGE_LABEL = {
  day: 'calendarDay',
  week: 'calendarWeek',
  month: 'calendarMonth',
} as const satisfies Record<RemindersRange, string>;
const STEP_LABEL = {
  day: ['calendarPreviousDay', 'calendarNextDay'],
  week: ['calendarPreviousWeek', 'calendarNextWeek'],
  month: ['calendarPreviousMonth', 'calendarNextMonth'],
} as const satisfies Record<RemindersRange, readonly [string, string]>;

/**
 * The calendar toolbar's left side: the range title. It follows the grid's
 * first visible day (Day, Week) or top week (Month) through the calendar
 * store, without rendering the page, and waits for the scroll to settle.
 */
export function ReminderCalendarTitle() {
  const locale = useLocale();
  const url = useRemindersUrlState();
  const live = useCalendarTop((top) => rangeLabel(top, url.range, locale));
  // A fling or a snap passes several days; stepping through each read as flicker.
  const { debouncedValue: label } = useDebounce(live, TITLE_SETTLE_MS);
  return (
    <h2
      className="text-foreground truncate text-base font-medium"
      aria-live="polite"
      data-testid="reminder-range-label"
    >
      {label}
    </h2>
  );
}

/**
 * The calendar toolbar's right side: the Day / Week / Month menu, Today, and
 * the previous / next arrows. The arrows step one range at once, without the
 * glide Today has: they are pressed in runs, and each press must step from
 * where the last one landed, not from a day passing mid-glide.
 */
export function ReminderCalendarControls({ now }: { now: number }) {
  const t = useTranslations('reminders');
  const url = useRemindersUrlState();
  const store = useCalendarStore();
  const [previous, next] = STEP_LABEL[url.range];
  const step = (direction: 1 | -1) => store.jump(stepDate(store.top(), url.range, direction));

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5"
            aria-label={t('calendarRangeLabel')}
            data-testid="reminder-range-menu"
          >
            {t(RANGE_LABEL[url.range])}
            <CaretDownIcon className="size-3.5 shrink-0" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-32">
          <DropdownMenuRadioGroup
            value={url.range}
            onValueChange={(range) => url.set({ range: range as RemindersRange })}
          >
            {RANGES.map((range) => (
              <DropdownMenuRadioItem key={range} value={range}>
                {t(RANGE_LABEL[range])}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" size="sm" onClick={() => store.jump(startOfDay(now), true)}>
        {t('calendarToday')}
      </Button>
      <div className="flex items-center">
        <Hint label={t(previous)} side="bottom">
          <Button variant="ghost" size="icon-sm" aria-label={t(previous)} onClick={() => step(-1)}>
            <CaretLeftIcon className="size-4 shrink-0" />
          </Button>
        </Hint>
        <Hint label={t(next)} side="bottom">
          <Button variant="ghost" size="icon-sm" aria-label={t(next)} onClick={() => step(1)}>
            <CaretRightIcon className="size-4 shrink-0" />
          </Button>
        </Hint>
      </div>
    </>
  );
}
