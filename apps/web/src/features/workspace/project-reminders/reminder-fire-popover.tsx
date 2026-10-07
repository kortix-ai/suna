'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import { AlarmIcon, PauseIcon, PlayIcon, TrashIcon } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';
import { clockTime, relativeFire } from './reminder-calendar-model';
import { reminderTitle, scheduleLabel } from './reminder-format';
import type { useReminderActions } from './reminder-list';
import { tone } from './reminder-row';
import type { ReminderFire } from './reminder-schedule';

/** What every calendar popover needs from the page. */
export type CalendarContext = {
  projectId: string;
  now: number;
  locale: string;
  actions: ReturnType<typeof useReminderActions>;
};

/**
 * A fire's chip tone. Purple = a scheduled recurring fire, amber = a one-shot
 * (next fire), grey = past (confirmed or estimated from the schedule).
 */
export function chipTone(fire: ReminderFire) {
  if (fire.past) return 'bg-muted text-muted-foreground border-transparent';
  return fire.reminder.every_seconds || fire.reminder.cron
    ? 'bg-kortix-purple/15 border-kortix-purple text-foreground'
    : 'bg-kortix-yellow/15 border-kortix-yellow text-foreground';
}

/** "HH:mm Title" chip, the trigger of its fire's popover. */
export function FireChip({
  fire,
  ctx,
  className,
  style,
  label,
}: {
  fire: ReminderFire;
  ctx: CalendarContext;
  className?: string;
  style?: React.CSSProperties;
  /** Replaces "HH:mm Title" (the "All week" lane). */
  label?: string;
}) {
  const t = useTranslations('reminders');
  const title = reminderTitle(fire.reminder);
  const { reminder } = fire;
  // Only the real last fire earns a check, and only when it succeeded.
  const succeeded = fire.confirmed && reminder.last_status === 'fired' && !reminder.last_error;
  const status = fire.past
    ? fire.confirmed
      ? t('calendarFiredSr')
      : t('calendarEstimatedSr')
    : t('calendarUpcomingSr');
  return (
    <FirePopover fire={fire} ctx={ctx}>
      <button
        type="button"
        data-testid="reminder-fire-chip"
        style={style}
        className={cn(
          'focus-visible:ring-ring/50 flex min-w-0 items-center gap-1 overflow-hidden rounded-sm border-l-2 px-1 text-left text-xs outline-none focus-visible:ring-2',
          chipTone(fire),
          className,
        )}
      >
        {label ? (
          <span className="truncate">{label}</span>
        ) : (
          <>
            <span className="shrink-0 tabular-nums">{clockTime(fire.at, ctx.locale)}</span>
            <span className="min-w-0 truncate">{title}</span>
          </>
        )}
        <span className="sr-only">{status}</span>
        {succeeded ? <SolidCheckIcon className="ml-auto size-3 shrink-0" aria-hidden /> : null}
      </button>
    </FirePopover>
  );
}

function FirePopover({ fire, ctx, children }: { fire: ReminderFire; ctx: CalendarContext; children: ReactNode }) {
  const t = useTranslations('reminders');
  const [open, setOpen] = useState(false);
  const { reminder } = fire;
  const { actions, locale } = ctx;
  const pending = actions.pendingAction(reminder);
  const active = reminder.state === 'active';
  const toggleLabel = active ? t('pause') : t('resume');
  const sessionHref = `/projects/${ctx.projectId}/sessions/${reminder.session_id}`;
  const when = [
    new Date(fire.at).toLocaleDateString(locale, { weekday: 'short', day: 'numeric', month: 'short' }),
    clockTime(fire.at, locale),
    relativeFire(fire.at, ctx.now, locale),
  ].join(' · ');
  const schedule = scheduleLabel(reminder, t);
  const colors = tone(reminder);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent align="start" className="flex w-80 flex-col gap-4" data-testid="reminder-fire-popover">
        <div className="flex items-start gap-3">
          <span className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', colors.tile)}>
            <AlarmIcon weight="fill" className={cn('size-5', colors.icon)} />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-foreground line-clamp-2 text-sm font-medium" title={reminder.prompt}>
              {reminderTitle(reminder)}
            </p>
            <p className="text-muted-foreground text-xs tabular-nums">{when}</p>
            {fire.past && !fire.confirmed ? (
              <p className="text-muted-foreground text-xs">{t('calendarEstimated')}</p>
            ) : null}
          </div>
        </div>
        <dl className="grid grid-cols-3 gap-x-3 gap-y-2 text-xs">
          <dt className="text-muted-foreground">{t('calendarSchedule')}</dt>
          <dd className="text-foreground col-span-2 truncate">{schedule}</dd>
          <dt className="text-muted-foreground">{t('calendarSession')}</dt>
          <dd className="col-span-2 min-w-0 truncate">
            <HoverPrefetchLink href={sessionHref} className="text-foreground underline-offset-4 hover:underline">
              {reminder.session_name ?? t('untitledSession')}
            </HoverPrefetchLink>
          </dd>
        </dl>
        <div className="flex flex-wrap items-center gap-2">
          {reminder.state !== 'done' ? (
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              aria-disabled={actions.busy || undefined}
              // Paused reminders leave the calendar (no upcoming fires), so pausing
              // unmounts this chip and its popover; the toast confirms it.
              onClick={actions.busy ? undefined : () => actions.setEnabled(reminder, !active)}
            >
              {pending === 'toggle' ? (
                <Loading className="size-4 shrink-0" />
              ) : active ? (
                <PauseIcon className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <PlayIcon className="size-3.5 shrink-0" aria-hidden />
              )}
              {toggleLabel}
            </Button>
          ) : null}
          <Button asChild variant="outline" size="sm">
            <HoverPrefetchLink href={sessionHref}>{t('calendarOpenSession')}</HoverPrefetchLink>
          </Button>
          <Button
            variant="destructive"
            size="sm"
            className="ml-auto gap-1.5"
            aria-disabled={actions.busy || undefined}
            onClick={
              actions.busy
                ? undefined
                : () => {
                    setOpen(false);
                    actions.setRemoving(reminder);
                  }
            }
          >
            <TrashIcon className="size-3.5 shrink-0" aria-hidden />
            {t('remove')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
