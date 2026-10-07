'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectReminder } from '@kortix/sdk';
import { useMemo } from 'react';
import { heatLevel, RAIL_DAYS, RAIL_WEEKS, railModel } from './reminder-list-model';

/** Purple steps over the muted cell. Opacity, because a status tint is /15 only. */
const LEVEL = ['', 'opacity-25', 'opacity-50', 'opacity-75', 'opacity-100'];
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const RAIL =
  'hidden min-h-0 min-w-64 flex-3 flex-col gap-5 overflow-y-auto border-l bg-muted/40 p-5 lg:flex';

/** A swatch for the legend: the same tint steps as a day cell. */
function Swatch({ level }: { level: number }) {
  return (
    <span className="bg-muted relative size-3 shrink-0 overflow-hidden rounded-xs">
      {level > 0 ? (
        <span className={cn('bg-kortix-purple absolute inset-0', LEVEL[level])} />
      ) : null}
    </span>
  );
}

/**
 * The right rail: the SCHEDULED fires of the next 6 weeks as a month-shaped
 * grid, one row per week and one column per weekday, so it reads like the
 * calendar it summarises. Upcoming only: there is no fire-history API, so days
 * before today stay empty. What fires next is the list beside it.
 */
export function ScheduleRail({ reminders, now }: { reminders: ProjectReminder[]; now: number }) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  // `now` ticks every 30 s; the grid only moves by the minute.
  const minute = Math.floor(now / 60_000) * 60_000;
  const model = useMemo(() => railModel(reminders, minute), [reminders, minute]);
  const days = useMemo(() => {
    const start = new Date(model.start);
    const max = Math.max(0, ...model.counts);
    return model.counts.map((count, index) => {
      const date = new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
      return {
        index,
        count,
        level: heatLevel(count, max),
        day: date.getDate(),
        label: t('dayFires', {
          date: date.toLocaleDateString(locale, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
          }),
          count,
        }),
      };
    });
  }, [model, locale, t]);
  const range = new Intl.DateTimeFormat(locale, { month: 'short' }).formatRange(
    new Date(model.start),
    new Date(model.start + (RAIL_DAYS - 1) * 86_400_000),
  );

  return (
    <aside className={RAIL} aria-label={t('railTitle')}>
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-foreground text-sm font-medium">{t('railTitle')}</h2>
        <span className="text-muted-foreground text-xs">{range}</span>
      </div>
      {model.total === 0 ? (
        <div className="flex flex-col gap-1 rounded-md border border-dashed px-4 py-6 text-center">
          <p className="text-foreground text-sm font-medium">{t('railEmptyTitle')}</p>
          <p className="text-muted-foreground text-xs">{t('railEmptyDescription')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="text-muted-foreground flex gap-1 text-center text-xs" aria-hidden>
            {WEEKDAYS.map((offset) => (
              <span key={offset} className="flex-1">
                {new Date(model.start + offset * 86_400_000).toLocaleDateString(locale, {
                  weekday: 'narrow',
                })}
              </span>
            ))}
          </div>
          {Array.from({ length: RAIL_WEEKS }, (_, week) => (
            <div key={week} className="flex gap-1">
              {days.slice(week * 7, week * 7 + 7).map((day) => (
                <span
                  key={day.index}
                  role="img"
                  aria-label={day.label}
                  title={day.label}
                  className={cn(
                    'bg-muted relative h-10 flex-1 overflow-hidden rounded-md',
                    day.index === model.today && 'ring-foreground ring-1 ring-inset',
                  )}
                >
                  {day.level > 0 ? (
                    <span className={cn('bg-kortix-purple absolute inset-0', LEVEL[day.level])} />
                  ) : null}
                  <span
                    className={cn(
                      'relative block p-1.5 text-xs tabular-nums',
                      day.index < model.today ? 'text-muted-foreground' : 'text-foreground',
                      day.index === model.today && 'font-medium',
                    )}
                  >
                    {day.day}
                  </span>
                </span>
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="text-muted-foreground flex items-center justify-between gap-2 text-xs">
        <span className="tabular-nums">{t('railSubtitle', { count: model.total })}</span>
        <span className="flex items-center gap-1" aria-hidden>
          {t('legendLess')}
          {[0, 1, 2, 3, 4].map((level) => (
            <Swatch key={level} level={level} />
          ))}
          {t('legendMore')}
        </span>
      </div>
      {model.hasCron ? <p className="text-muted-foreground text-xs">{t('railCronNote')}</p> : null}
    </aside>
  );
}

export function ScheduleRailSkeleton() {
  return (
    <aside className={RAIL} aria-hidden>
      <div className="flex flex-col gap-1.5">
        <Skeleton className="h-3.5 w-28 py-0" />
        <Skeleton className="h-3 w-36 py-0" />
      </div>
      <Skeleton className="h-64 w-full py-0" />
      <Skeleton className="h-3 w-32 py-0" />
    </aside>
  );
}
