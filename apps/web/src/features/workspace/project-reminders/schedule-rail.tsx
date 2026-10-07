'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectReminder } from '@kortix/sdk';
import { useMemo } from 'react';
import { reminderTitle } from './reminder-format';
import { heatLevel, RAIL_WEEKS, railModel } from './reminder-list-model';

/** Purple steps over the muted cell. Opacity, because a status tint is /15 only. */
const LEVEL = ['', 'opacity-25', 'opacity-50', 'opacity-75', 'opacity-100'];
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6];
const RAIL = 'hidden min-h-0 min-w-64 flex-3 flex-col gap-5 overflow-y-auto border-l bg-muted/40 p-5 lg:flex';

function HeatCell({ level, today, dim, title }: { level: number; today?: boolean; dim?: boolean; title?: string }) {
  return (
    <span
      title={title}
      className={cn(
        'bg-muted relative size-5 shrink-0 overflow-hidden rounded-sm',
        today && 'ring-foreground ring-1',
        dim && 'opacity-40',
      )}
    >
      {level > 0 ? <span className={cn('bg-kortix-purple absolute inset-0', LEVEL[level])} /> : null}
    </span>
  );
}

/**
 * The right rail: the SCHEDULED fires of the next 6 weeks, one cell per day,
 * then the reminders that will fire most in the next 14 days. Upcoming only:
 * there is no fire-history API, so nothing past is drawn.
 */
export function ScheduleRail({ reminders, now }: { reminders: ProjectReminder[]; now: number }) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  // `now` ticks every 30 s; the grid only moves by the minute.
  const minute = Math.floor(now / 60_000) * 60_000;
  const model = useMemo(() => railModel(reminders, minute), [reminders, minute]);
  const max = Math.max(0, ...model.counts);
  const dayOf = (index: number) => {
    const start = new Date(model.start);
    return new Date(start.getFullYear(), start.getMonth(), start.getDate() + index);
  };

  return (
    <aside className={RAIL} aria-label={t('railTitle')}>
      <div className="flex flex-col gap-1">
        <h2 className="text-foreground text-sm font-medium">{t('railTitle')}</h2>
        <p className="text-muted-foreground text-xs">{t('railSubtitle', { count: model.total })}</p>
      </div>
      {model.total === 0 ? (
        <div className="flex flex-col gap-1 rounded-md border border-dashed px-4 py-6 text-center">
          <p className="text-foreground text-sm font-medium">{t('railEmptyTitle')}</p>
          <p className="text-muted-foreground text-xs">{t('railEmptyDescription')}</p>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            {WEEKDAYS.map((row) => (
              <div key={row} className="flex items-center gap-1">
                <span className="text-muted-foreground w-5 shrink-0 text-xs" aria-hidden>
                  {dayOf(row).toLocaleDateString(locale, { weekday: 'narrow' })}
                </span>
                {Array.from({ length: RAIL_WEEKS }, (_, week) => {
                  const index = week * 7 + row;
                  const count = model.counts[index] ?? 0;
                  const date = dayOf(index).toLocaleDateString(locale, { month: 'short', day: 'numeric' });
                  return (
                    <HeatCell
                      key={week}
                      level={heatLevel(count, max)}
                      today={index === model.today}
                      dim={index < model.today}
                      title={t('dayFires', { date, count })}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <div className="text-muted-foreground flex items-center gap-1 text-xs" aria-hidden>
            <span className="mr-1">{t('legendLess')}</span>
            {[0, 1, 2, 3, 4].map((level) => (
              <HeatCell key={level} level={level} />
            ))}
            <span className="ml-1">{t('legendMore')}</span>
          </div>
          {model.frequent.length > 0 ? (
            <div className="flex flex-col gap-2">
              <h3 className="text-muted-foreground text-xs">{t('mostFrequent')}</h3>
              <ul className="flex flex-col gap-1.5">
                {model.frequent.map(({ reminder, count }) => (
                  <li key={reminder.id} className="flex items-center gap-2 text-sm">
                    <span className="text-foreground min-w-0 flex-1 truncate" title={reminder.prompt}>
                      {reminderTitle(reminder)}
                    </span>
                    <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                      {t('turnCount', { count })}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      )}
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
      <Skeleton className="h-44 w-40 py-0" />
      <Skeleton className="h-3 w-32 py-0" />
    </aside>
  );
}
