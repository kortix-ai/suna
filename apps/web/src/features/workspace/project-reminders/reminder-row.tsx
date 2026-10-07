'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/button';
import Hint from '@/components/ui/hint';
import { InlineMeta } from '@/components/ui/inline-meta';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectReminder } from '@kortix/sdk';
import { AlarmIcon, PauseIcon, PlayIcon, TrashIcon } from '@phosphor-icons/react';
import { memo } from 'react';
import { formatFireTime, reminderTitle, scheduleLabel } from './reminder-format';

/** Status tile per the tinted-icon pattern: yellow = pending, green = done, red = stopped by an error. */
export function tone(reminder: ProjectReminder) {
  if (reminder.last_error) return { tile: 'bg-kortix-red/15', icon: 'text-kortix-red' };
  if (reminder.state === 'active')
    return { tile: 'bg-kortix-yellow/15', icon: 'text-kortix-yellow' };
  if (reminder.state === 'done') return { tile: 'bg-kortix-green/15', icon: 'text-kortix-green' };
  return { tile: 'bg-muted', icon: 'text-muted-foreground' };
}

/** Which of the row's own actions is in flight, if any. */
export type RowPending = 'toggle' | 'remove' | null;

/**
 * While a mutation runs, actions are locked with `aria-disabled`, not
 * `disabled`: a disabled button drops keyboard focus, and the pressed one
 * must keep it while its spinner shows.
 */
const LOCKED = 'aria-disabled:cursor-default aria-disabled:opacity-50';
const ROW = 'relative flex items-center gap-3 px-4 py-2.5';
const TIME_COLUMN = 'w-44 shrink-0 truncate whitespace-nowrap text-right text-xs tabular-nums';
const ACTIONS_COLUMN = 'relative z-10 flex w-16 shrink-0 items-center justify-end gap-1';

/**
 * Memoized: a long list re-renders only the rows whose reminder, pending
 * state or clock reading changed. The handlers take the reminder, so the list
 * passes the same two callbacks to every row.
 */
export const ReminderRow = memo(function ReminderRow({
  reminder,
  projectId,
  now,
  pending,
  disabled,
  onToggle,
  onRemove,
}: {
  reminder: ProjectReminder;
  projectId: string;
  now: number;
  pending: RowPending;
  disabled: boolean;
  onToggle: (reminder: ProjectReminder) => void;
  onRemove: (reminder: ProjectReminder) => void;
}) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  const colors = tone(reminder);
  const schedule = scheduleLabel(reminder, t);
  const when =
    reminder.state === 'active'
      ? reminder.next_fire_at
        ? formatFireTime(reminder.next_fire_at, locale, now)
        : null
      : reminder.state === 'paused'
        ? t('pausedLabel')
        : reminder.last_fired_at
          ? t('firedAt', { time: formatFireTime(reminder.last_fired_at, locale, now) })
          : null;
  const toggleLabel = reminder.state === 'active' ? t('pause') : t('resume');

  // The whole row opens the reminder's session: the title link stretches over
  // the row (`after:inset-0`), and the actions sit above it (`relative z-10`)
  // so they keep their own click.
  return (
    <li
      data-reminder-id={reminder.id}
      aria-busy={pending ? true : undefined}
      className={cn(
        ROW,
        'hover:bg-muted/50 has-[a:focus-visible]:ring-ring/50 transition-colors has-[a:focus-visible]:ring-2',
        pending && 'opacity-60',
      )}
    >
      <span
        className={cn('flex size-9 shrink-0 items-center justify-center rounded-md', colors.tile)}
      >
        <AlarmIcon weight="fill" className={cn('size-5', colors.icon)} />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <HoverPrefetchLink
          href={`/projects/${projectId}/sessions/${reminder.session_id}`}
          className="text-foreground truncate text-sm font-medium outline-none after:absolute after:inset-0"
          title={reminder.prompt}
        >
          {reminderTitle(reminder)}
        </HoverPrefetchLink>
        <InlineMeta>
          <span className="shrink-0">{schedule}</span>
          <span className="truncate">{reminder.session_name ?? t('untitledSession')}</span>
        </InlineMeta>
        {reminder.last_error ? (
          <p className="text-kortix-red line-clamp-2 text-xs" title={reminder.last_error}>
            {reminder.last_error}
          </p>
        ) : null}
      </div>
      <span
        title={when ?? undefined}
        className={cn(
          TIME_COLUMN,
          reminder.last_error
            ? 'text-kortix-red'
            : reminder.state === 'active'
              ? 'text-kortix-yellow'
              : 'text-muted-foreground',
        )}
      >
        {when}
      </span>
      <div className={ACTIONS_COLUMN}>
        {reminder.state !== 'done' ? (
          <Hint label={toggleLabel}>
            <Button
              variant="ghost"
              size="icon"
              aria-label={toggleLabel}
              aria-disabled={disabled || undefined}
              className={pending ? undefined : LOCKED}
              onClick={disabled ? undefined : () => onToggle(reminder)}
            >
              {pending === 'toggle' ? (
                <Loading className="size-4" />
              ) : reminder.state === 'active' ? (
                <PauseIcon className="size-4 shrink-0" />
              ) : (
                <PlayIcon className="size-4 shrink-0" />
              )}
            </Button>
          </Hint>
        ) : null}
        <Hint label={t('remove')}>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('remove')}
            aria-disabled={disabled || undefined}
            className={pending ? undefined : LOCKED}
            onClick={disabled ? undefined : () => onRemove(reminder)}
          >
            {pending === 'remove' ? (
              <Loading className="size-4" />
            ) : (
              <TrashIcon className="size-4 shrink-0" />
            )}
          </Button>
        </Hint>
      </div>
    </li>
  );
});

/** A loading row with the same geometry as `ReminderRow`. */
export function ReminderRowSkeleton() {
  return (
    <li className={ROW}>
      <Skeleton className="size-9 shrink-0 py-0" />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <Skeleton className="h-3.5 w-1/2 py-0" />
        <Skeleton className="h-3 w-1/3 py-0" />
      </div>
      <span className={TIME_COLUMN}>
        <Skeleton className="ml-auto h-3 w-16 py-0" />
      </span>
      <span className={ACTIONS_COLUMN} />
    </li>
  );
}
