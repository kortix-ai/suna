'use client';

import { SolidCheckIcon } from '@/features/icon/icons/solid-check-icon';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { CSSProperties } from 'react';
import { clockTime } from './reminder-calendar-model';
import { reminderColors, useOpenFire } from './reminder-fire-popover';
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
 * A Week card or lane pill in the reminder's colour: a translucent tint of its
 * hue (so it sits on both themes and keeps theme text), and a solid left bar.
 * A past fire keeps its hue at lower opacity.
 */
function tintStyle(fire: ReminderFire): CSSProperties {
  const { border } = reminderColors(fire.reminder);
  return {
    background: `color-mix(in oklab, ${border} 30%, transparent)`,
    borderLeftColor: border,
  };
}

const PAST = 'opacity-60';

/** Only the real last fire earns a check, and only when it succeeded. */
const succeeded = ({ confirmed, reminder }: ReminderFire) =>
  confirmed && reminder.last_status === 'fired' && !reminder.last_error;

/**
 * A Week card at its time: title over time when `tall`, else one line
 * "Title 14:00". Hairline border in the reminder's colour.
 */
export function FireCard({
  fire,
  locale,
  tall,
  style,
}: {
  fire: ReminderFire;
  locale: string;
  tall: boolean;
  style: CSSProperties;
}) {
  const open = useOpenFire();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={(event) => open(fire, event.currentTarget)}
      data-testid="reminder-fire-chip"
      style={{ ...tintStyle(fire), ...style }}
      className={cn(
        'text-foreground absolute z-10 flex min-w-0 overflow-hidden rounded-sm border-l-4 px-1.5 text-left text-xs',
        tall ? 'flex-col justify-start py-0.5' : 'items-center gap-1.5',
        fire.past && PAST,
        FOCUS,
      )}
    >
      <span className="min-w-0 truncate font-medium">{reminderTitle(fire.reminder)}</span>
      <span className="shrink-0 tabular-nums opacity-70">{clockTime(fire.at, locale)}</span>
      <FireStatus fire={fire} />
      {succeeded(fire) && !tall ? (
        <SolidCheckIcon className="ml-auto size-3 shrink-0" aria-hidden />
      ) : null}
    </button>
  );
}

/**
 * A Month line, Notion-style: no fill, a dot in the reminder's colour, the
 * time muted, then the title. A frequent reminder's day is one line,
 * "Title · ×48". Plain rows keep a busy month readable.
 */
export function FireRow({
  fire,
  locale,
  count,
  card = false,
}: {
  fire: ReminderFire;
  locale: string;
  count: number | null;
  /** Today's events: the tinted card with a left bar, like the Week cards. */
  card?: boolean;
}) {
  const open = useOpenFire();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={(event) => open(fire, event.currentTarget)}
      data-testid="reminder-fire-chip"
      style={card ? tintStyle(fire) : undefined}
      className={cn(
        'flex w-full min-w-0 shrink-0 items-center gap-1.5 rounded-sm px-1 text-left text-xs transition-colors',
        card ? 'border-l-4 py-0.5' : 'hover:bg-muted py-px',
        fire.past && PAST,
        FOCUS,
      )}
    >
      {card ? null : (
        <span
          aria-hidden
          className="size-1.5 shrink-0 rounded-full"
          style={{ background: reminderColors(fire.reminder).border }}
        />
      )}
      {count === null ? (
        <span className="text-muted-foreground shrink-0 tabular-nums">
          {clockTime(fire.at, locale)}
        </span>
      ) : null}
      <span className="text-foreground min-w-0 truncate">{reminderTitle(fire.reminder)}</span>
      {count !== null ? (
        <span className="text-muted-foreground shrink-0 tabular-nums">×{count}</span>
      ) : null}
      <FireStatus fire={fire} />
    </button>
  );
}

/** A pill in the Week "All week" lane: a frequent reminder, "Title · every 5m". */
export function FirePill({ fire, label }: { fire: ReminderFire; label: string }) {
  const open = useOpenFire();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={(event) => open(fire, event.currentTarget)}
      data-testid="reminder-fire-chip"
      style={tintStyle(fire)}
      className={cn(
        'text-foreground max-w-full truncate rounded-sm border-l-4 px-1.5 py-0.5 text-left text-xs',
        fire.past && PAST,
        FOCUS,
      )}
    >
      {label}
      <FireStatus fire={fire} />
    </button>
  );
}
