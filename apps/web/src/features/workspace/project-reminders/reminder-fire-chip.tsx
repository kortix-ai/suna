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
 * A reminder's colour: a soft tint of its hue (so it sits on both themes and
 * keeps theme text) and a 2px bar in the solid hue. A past fire recedes.
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

/** One line in a Week hour cell: the title, then the minute. Full cell width, one height. */
export function FireLine({ fire, locale }: { fire: ReminderFire; locale: string }) {
  const open = useOpenFire();
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      onClick={(event) => open(fire, event.currentTarget)}
      data-testid="reminder-fire-chip"
      style={tintStyle(fire)}
      className={cn(
        'text-foreground flex h-5 min-w-0 items-center gap-1.5 rounded-sm border-l-2 pr-1.5 pl-1 text-left text-xs transition-[filter] duration-(--duration-fast) hover:brightness-95 dark:hover:brightness-125',
        fire.past && PAST,
        FOCUS,
      )}
    >
      <span className="min-w-0 flex-1 truncate font-medium">{reminderTitle(fire.reminder)}</span>
      {succeeded(fire) ? (
        <SolidCheckIcon className="text-muted-foreground size-3 shrink-0" aria-hidden />
      ) : null}
      <span className="text-muted-foreground shrink-0 tabular-nums">
        {clockTime(fire.at, locale)}
      </span>
      <FireStatus fire={fire} />
    </button>
  );
}

/** The last line of a full cell: "+N more". */
export const MORE_LINE =
  'text-muted-foreground hover:bg-accent hover:text-foreground flex h-5 min-w-0 items-center rounded-sm px-1 text-left text-xs font-medium tabular-nums transition-colors';

/**
 * A Month line: a dot in the reminder's colour, the time muted, then the
 * title. A frequent reminder's day is one line, "Title ×48".
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
        'hover:bg-accent text-foreground flex h-5 w-full min-w-0 shrink-0 items-center gap-1.5 rounded-sm px-1 text-left text-xs transition-colors',
        fire.past && PAST,
        FOCUS,
      )}
    >
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: reminderColors(fire.reminder).border }}
      />
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
