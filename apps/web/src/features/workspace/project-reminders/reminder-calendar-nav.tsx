'use client';

import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { CaretLeftIcon, CaretRightIcon } from '@phosphor-icons/react';
import { dateParam, parseDateParam, rangeLabel, shiftAnchor } from './reminder-calendar-model';
import { useRemindersUrlState, type RemindersRange } from './use-reminders-url-state';

/**
 * The calendar's toolbar cluster: Week | Month, Today, prev / next and the
 * range label. Range and anchor live in the URL (`?range=`, `?date=`).
 */
export function ReminderCalendarNav({ now }: { now: number }) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  const url = useRemindersUrlState();
  const anchor = parseDateParam(url.date, now);
  const step = (direction: 1 | -1) => url.set({ date: dateParam(shiftAnchor(anchor, url.range, direction)) });
  const previous = url.range === 'week' ? t('calendarPreviousWeek') : t('calendarPreviousMonth');
  const next = url.range === 'week' ? t('calendarNextWeek') : t('calendarNextMonth');

  return (
    <>
      <Tabs value={url.range} onValueChange={(range) => url.set({ range: range as RemindersRange })}>
        <TabsList aria-label={t('calendarRangeLabel')}>
          <TabsTrigger value="week">{t('calendarWeek')}</TabsTrigger>
          <TabsTrigger value="month">{t('calendarMonth')}</TabsTrigger>
        </TabsList>
      </Tabs>
      <Button variant="outline" size="sm" onClick={() => url.set({ date: null })}>
        {t('calendarToday')}
      </Button>
      <div className="flex items-center">
        <Hint label={previous}>
          <Button variant="ghost" size="icon-sm" aria-label={previous} onClick={() => step(-1)}>
            <CaretLeftIcon className="size-3.5 shrink-0" />
          </Button>
        </Hint>
        <Hint label={next}>
          <Button variant="ghost" size="icon-sm" aria-label={next} onClick={() => step(1)}>
            <CaretRightIcon className="size-3.5 shrink-0" />
          </Button>
        </Hint>
      </div>
      <h2 className="text-foreground truncate text-sm font-medium" aria-live="polite" data-testid="reminder-range-label">
        {rangeLabel(anchor, url.range, locale)}
      </h2>
    </>
  );
}
