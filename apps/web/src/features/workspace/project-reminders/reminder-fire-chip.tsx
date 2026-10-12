'use client';

import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { CSSProperties } from 'react';
import { clockTime } from './reminder-calendar-model';
import { useOpenFire } from './reminder-fire-popover';
import { reminderTitle } from './reminder-format';
import type { ReminderFire } from './reminder-schedule';

const FOCUS = 'focus-visible:ring-ring/50 outline-none focus-visible:ring-2';

/** "Fired" / "Past fire, estimated" / "Upcoming", for screen readers. */
function FireStatus({ fire }: { fire: ReminderFire }) {
  const t = useTranslations('reminders');
  const status = fire.past
    ? fire.confirmed
      ? t('calendarFiredSr')
      : t('calendarEstimatedSr')
    : t('calendarUpcomingSr');
  return <span className="sr-only">{status}</span>;
}

/**
 * Chips carry no hue: the brand keeps colour for state, and a hue per
 * reminder turned a busy week into confetti. An upcoming fire is a muted
 * surface in ink; a past one recedes to a fainter surface and muted text.
 */
const SURFACE = (fire: ReminderFire) =>
  fire.past
    ? 'bg-muted/50 text-muted-foreground hover:bg-muted'
    : 'bg-muted text-foreground hover:bg-accent';

/** Only the real last fire earns a check, and only when it succeeded. */
const succeeded = ({ confirmed, reminder }: ReminderFire) =>
  confirmed && reminder.last_status === 'fired' && !reminder.last_error;

/**
 * A Week card at its time: title over time when `tall`, the title alone when
 * it shares its hour with other lanes (the grid already says when), else one
 * line "Title 14:00". A background ring keeps side-by-side cards apart.
 */
export function FireCard({
  fire,
  locale,
  tall,
  narrow,
  style,
}: {
  fire: ReminderFire;
  locale: string;
  tall: boolean;
  /** One of several lanes: no room for the time. */
  narrow: boolean;
  style: CSSProperties;
}) {
  const open = useOpenFire();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={(event) => open(fire, event.currentTarget)}
      data-testid="reminder-fire-chip"
      style={style}
      className={cn(
        'ring-background absolute z-10 flex min-w-0 overflow-hidden rounded-sm px-1.5 text-left text-xs ring-1 transition-colors',
        tall ? 'flex-col justify-start py-0.5' : 'items-center gap-1.5',
        SURFACE(fire),
        FOCUS,
      )}
    >
      <span className="min-w-0 truncate font-medium">{reminderTitle(fire.reminder)}</span>
      {narrow && !tall ? null : (
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {clockTime(fire.at, locale)}
        </span>
      )}
      <FireStatus fire={fire} />
      {succeeded(fire) && !tall && !narrow ? (
        <SolidCheckIcon className="text-muted-foreground ml-auto size-3 shrink-0" aria-hidden />
      ) : null}
    </button>
  );
}

/**
 * The fires a crowded hour could not fit, as one "+N" in the last lane.
 * It opens the day, where every lane has room.
 */
export function MoreCard({
  count,
  label,
  style,
  onOpen,
}: {
  count: number;
  label: string;
  style: CSSProperties;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={label}
      data-testid="reminder-fire-more"
      style={style}
      className={cn(
        'ring-background text-muted-foreground hover:bg-accent hover:text-foreground absolute z-10 flex items-center justify-center rounded-sm bg-transparent px-1 text-xs font-medium tabular-nums ring-1 transition-colors',
        FOCUS,
      )}
    >
      +{count}
    </button>
  );
}

/**
 * A Month line: the time muted, then the title. A frequent reminder's day is
 * one line, "Title ×48". Plain rows keep a busy month readable.
 */
export function FireRow({
  fire,
  locale,
  count,
}: {
  fire: ReminderFire;
  locale: string;
  count: number | null;
}) {
  const open = useOpenFire();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={(event) => open(fire, event.currentTarget)}
      data-testid="reminder-fire-chip"
      className={cn(
        'hover:bg-accent flex w-full min-w-0 shrink-0 items-center gap-1.5 rounded-sm px-1 py-px text-left text-xs transition-colors',
        fire.past ? 'text-muted-foreground' : 'text-foreground',
        FOCUS,
      )}
    >
      {count === null ? (
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {clockTime(fire.at, locale)}
        </span>
      ) : null}
      <span className="min-w-0 truncate">{reminderTitle(fire.reminder)}</span>
      {count !== null ? (
        <span className="text-muted-foreground shrink-0 tabular-nums">×{count}</span>
      ) : null}
      <FireStatus fire={fire} />
    </button>
  );
}

/** A pill in the Week "All week" lane: a frequent reminder, "Title  every 5m". */
export function FirePill({
  fire,
  title,
  period,
}: {
  fire: ReminderFire;
  title: string;
  period: string;
}) {
  const open = useOpenFire();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={(event) => open(fire, event.currentTarget)}
      data-testid="reminder-fire-chip"
      className={cn(
        'flex h-6 max-w-64 min-w-0 shrink-0 items-center gap-1.5 rounded-sm px-1.5 text-left text-xs transition-colors',
        SURFACE(fire),
        FOCUS,
      )}
    >
      <span className="min-w-0 truncate">{title}</span>
      <span className="text-muted-foreground shrink-0 tabular-nums">{period}</span>
      <FireStatus fire={fire} />
    </button>
  );
}
