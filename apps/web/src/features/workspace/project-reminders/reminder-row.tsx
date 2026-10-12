'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import Hint from '@/components/ui/hint';
import { InlineMeta } from '@/components/ui/inline-meta';
import Loading from '@/components/ui/loading';
import { Skeleton } from '@/components/ui/skeleton';
import { TableCell, TableRow } from '@/components/ui/table';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectReminder } from '@kortix/sdk';
import { AlarmIcon, PauseIcon, PlayIcon, TrashIcon } from '@phosphor-icons/react';
import { useRouter } from 'next/navigation';
import { memo, useState, type ReactNode } from 'react';
import { formatFireTime, reminderTitle, scheduleLabel } from './reminder-format';

/** Status tile per the tinted-icon pattern: yellow = pending, green = done, red = stopped by an error. */
export function tone(reminder: ProjectReminder) {
  if (reminder.last_error) return { tile: 'bg-kortix-red/15', icon: 'text-kortix-red' };
  if (reminder.state === 'active')
    return { tile: 'bg-kortix-yellow/15', icon: 'text-kortix-yellow' };
  if (reminder.state === 'done') return { tile: 'bg-kortix-green/15', icon: 'text-kortix-green' };
  return { tile: 'bg-muted', icon: 'text-muted-foreground' };
}

/** Which of the row's own actions is in flight, if any; `bulk` is a selection batch it is part of. */
export type RowPending = 'toggle' | 'remove' | 'bulk' | null;

/**
 * While a mutation runs, actions are locked with `aria-disabled`, not
 * `disabled`: a disabled button drops keyboard focus, and the pressed one
 * must keep it while its spinner shows.
 */
const LOCKED = 'aria-disabled:cursor-default aria-disabled:opacity-50';
const ACTIONS = 'flex items-center justify-end gap-1';

/**
 * A row's action tooltip, mounted once the pointer has entered the row. A
 * `Hint` is a Radix tooltip root; two per row across ~190 rows were ~40% of
 * the List's mount (measured: switching to List took 515–598 ms with them,
 * 281–431 ms without, dev build). The button keeps its `aria-label` either
 * way. Not armed on focus: wrapping a focused button would remount it.
 */
function RowHint({
  armed,
  label,
  children,
}: {
  armed: boolean;
  label: string;
  children: ReactNode;
}) {
  return armed ? <Hint label={label}>{children}</Hint> : children;
}

/**
 * One reminder as a table row, the Triggers table's shape: a leading status
 * tile and the title, then Schedule, Session and When cells that drop out as
 * the viewport narrows. The phone layout keeps schedule and session under the
 * title.
 *
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
  selected,
  onSelect,
  onToggle,
  onRemove,
}: {
  reminder: ProjectReminder;
  projectId: string;
  now: number;
  pending: RowPending;
  disabled: boolean;
  selected: boolean;
  /** The row's checkbox: `range` is a shift-press, selecting from the last pressed row. */
  onSelect: (reminder: ProjectReminder, range: boolean) => void;
  onToggle: (reminder: ProjectReminder) => void;
  onRemove: (reminder: ProjectReminder) => void;
}) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  const router = useRouter();
  const colors = tone(reminder);
  const schedule = scheduleLabel(reminder, t);
  const session = reminder.session_name ?? t('untitledSession');
  const href = `/projects/${projectId}/sessions/${reminder.session_id}`;
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
  const [armed, setArmed] = useState(false);

  // The row opens the reminder's session. The title is the real link, so the
  // row is reachable by keyboard; the actions stop the row's click.
  return (
    <TableRow
      data-reminder-id={reminder.id}
      data-state={selected ? 'selected' : undefined}
      aria-busy={pending ? true : undefined}
      className={cn('cursor-pointer', pending && 'opacity-60')}
      onClick={() => router.push(href)}
      onPointerEnter={armed ? undefined : () => setArmed(true)}
    >
      <TableCell className="w-0 pr-0 align-middle" onClick={(event) => event.stopPropagation()}>
        <Checkbox
          checked={selected}
          aria-label={t('selectReminder', { title: reminderTitle(reminder) })}
          onClick={(event) => onSelect(reminder, event.shiftKey)}
        />
      </TableCell>
      <TableCell className="w-full max-w-0 align-middle">
        <div className="flex min-w-0 items-center gap-3">
          <span
            className={cn(
              'flex size-8 shrink-0 items-center justify-center rounded-md',
              colors.tile,
            )}
          >
            <AlarmIcon weight="fill" className={cn('size-4', colors.icon)} />
          </span>
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <HoverPrefetchLink
              href={href}
              onClick={(e) => e.stopPropagation()}
              className="text-foreground truncate text-sm font-medium outline-none focus-visible:underline"
              title={reminder.prompt}
            >
              {reminderTitle(reminder)}
            </HoverPrefetchLink>
            <InlineMeta className="sm:hidden">
              <span className="shrink-0">{schedule}</span>
              <span className="truncate">{session}</span>
            </InlineMeta>
            {reminder.last_error ? (
              <p className="text-kortix-red line-clamp-2 text-xs" title={reminder.last_error}>
                {reminder.last_error}
              </p>
            ) : null}
          </div>
        </div>
      </TableCell>
      <TableCell className="text-muted-foreground hidden align-middle text-sm whitespace-nowrap sm:table-cell">
        {schedule}
      </TableCell>
      <TableCell className="text-muted-foreground hidden max-w-[14rem] truncate align-middle text-sm lg:table-cell">
        {session}
      </TableCell>
      <TableCell
        title={when ?? undefined}
        className={cn(
          'hidden align-middle text-sm whitespace-nowrap tabular-nums md:table-cell',
          reminder.last_error
            ? 'text-kortix-red'
            : reminder.state === 'active'
              ? 'text-kortix-yellow'
              : 'text-muted-foreground',
        )}
      >
        {when}
      </TableCell>
      <TableCell className="align-middle" onClick={(e) => e.stopPropagation()}>
        <div className={ACTIONS}>
          {reminder.state !== 'done' ? (
            <RowHint armed={armed} label={toggleLabel}>
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
            </RowHint>
          ) : null}
          <RowHint armed={armed} label={t('remove')}>
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
          </RowHint>
        </div>
      </TableCell>
    </TableRow>
  );
});

/** A loading row with the same cells as `ReminderRow`. */
export function ReminderRowSkeleton() {
  return (
    <TableRow className="hover:bg-transparent">
      <TableCell className="w-0 pr-0">
        <Skeleton className="size-4.5 rounded-sm py-0" />
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-3">
          <Skeleton className="size-8 shrink-0 py-0" />
          <Skeleton className="h-3.5 w-40 py-0" />
        </div>
      </TableCell>
      <TableCell className="hidden sm:table-cell">
        <Skeleton className="h-3 w-16 py-0" />
      </TableCell>
      <TableCell className="hidden lg:table-cell">
        <Skeleton className="h-3 w-24 py-0" />
      </TableCell>
      <TableCell className="hidden md:table-cell">
        <Skeleton className="h-3 w-20 py-0" />
      </TableCell>
      <TableCell />
    </TableRow>
  );
}
