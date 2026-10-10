'use client';

import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useDebounce } from '@/hooks/use-debounce';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { rangeLabel, startOfDay } from './reminder-calendar-model';
import { TITLE_SETTLE_MS, useCalendarStore, useCalendarTop } from './use-calendar-scroll';
import { useRemindersUrlState, type RemindersRange } from './use-reminders-url-state';

/**
 * The calendar's toolbar cluster: Week | Month, Today and the range title.
 * There are no prev / next arrows: the grid scrolls, and the title follows
 * its first visible day (Week) or top week (Month) through the calendar
 * store, without rendering the page.
 */
export function ReminderCalendarNav({ now }: { now: number }) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  const url = useRemindersUrlState();
  const store = useCalendarStore();
  const live = useCalendarTop((top) => rangeLabel(top, url.range, locale));
  // The title waits for the grid to settle: a fling or a snap passes several
  // days, and the title stepping through each of them read as flicker.
  const { debouncedValue: label } = useDebounce(live, TITLE_SETTLE_MS);

  return (
    <>
      <Tabs
        value={url.range}
        onValueChange={(range) => {
          // The highlight marks a day opened from Month; it ends with Week.
          if (range === 'month') store.select(null);
          url.set({ range: range as RemindersRange });
        }}
      >
        <TabsList aria-label={t('calendarRangeLabel')}>
          <TabsTrigger value="week">{t('calendarWeek')}</TabsTrigger>
          <TabsTrigger value="month">{t('calendarMonth')}</TabsTrigger>
        </TabsList>
      </Tabs>
      <Button variant="outline" size="sm" onClick={() => store.jump(startOfDay(now), true)}>
        {t('calendarToday')}
      </Button>
      <h2
        className="text-foreground truncate text-lg font-medium"
        aria-live="polite"
        data-testid="reminder-range-label"
      >
        {label}
      </h2>
    </>
  );
}
