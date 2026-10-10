'use client';

import { HoverPrefetchLink } from '@/components/common/hover-prefetch-link';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover';
import { STATUS_BG, STATUS_DOT, type StatusTone } from '@/components/ui/status';
import { useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectReminder } from '@kortix/sdk';
import { chalkColors } from '@kortix/shared';
import { ChatCircleIcon, ClockIcon, XIcon } from '@phosphor-icons/react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { clockTime, dateFormat, relativeFire } from './reminder-calendar-model';
import { reminderTitle } from './reminder-format';
import type { useReminderActions } from './reminder-list';
import type { ReminderFire } from './reminder-schedule';

/** What the fire card needs from the page: the project, the clock, the locale. */
export type CalendarContext = { projectId: string; now: number; locale: string };

type ReminderActions = ReturnType<typeof useReminderActions>;

/**
 * The page's reminder actions. A context, not a prop: only the open card
 * reads it, so a pending mutation re-renders that card and not the grid.
 */
export const CalendarActions = createContext<ReminderActions | null>(null);

/**
 * A reminder's colour, the same in every view: Month line, Week card, the
 * card's tile. Seeded by id, so a rename keeps it. Inline style values.
 */
export const reminderColors = (reminder: { id: string }) => chalkColors(reminder.id);

type OpenFire = (fire: ReminderFire, chip: HTMLElement) => void;

const OpenFireContext = createContext<OpenFire>(() => {});

/** What a chip calls on click: opens its fire's card, or closes it when already open. */
export const useOpenFire = () => useContext(OpenFireContext);

/**
 * The one fire card of a calendar, anchored to the chip that opened it.
 *
 * One popover for the grid, not one per chip: a Month window holds thousands
 * of lines, and a Radix popover root on each made the range switch and every
 * window move mount thousands of them. Chips are plain buttons that call
 * `useOpenFire`.
 *
 * `reminders` is the list the grid renders. When it changes, the card takes
 * the fresh reminder, and closes once its chip has left the grid (a paused
 * reminder has no upcoming fires).
 */
export function FirePopoverHost({
  ctx,
  reminders,
  children,
}: {
  ctx: CalendarContext;
  reminders: readonly ProjectReminder[];
  children: ReactNode;
}) {
  const [shown, setShown] = useState<{ fire: ReminderFire; chip: HTMLElement } | null>(null);
  const open = useCallback<OpenFire>(
    (fire, chip) => setShown((current) => (current?.chip === chip ? null : { fire, chip })),
    [],
  );
  const close = useCallback(() => setShown(null), []);
  const anchor = useMemo(() => ({ current: shown?.chip ?? null }), [shown]);

  // Runs after the grid has committed the same `reminders`, so the chip is
  // already gone when its reminder left the grid.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShown((current) => {
      if (!current || !current.chip.isConnected) return null;
      const fresh = reminders.find((r) => r.id === current.fire.reminder.id);
      if (!fresh) return null;
      return fresh === current.fire.reminder
        ? current
        : { ...current, fire: { ...current.fire, reminder: fresh } };
    });
  }, [reminders]);

  return (
    <OpenFireContext.Provider value={open}>
      {children}
      <Popover open={!!shown} onOpenChange={(next) => (next ? undefined : close())}>
        <PopoverAnchor virtualRef={anchor} />
        {shown ? (
          <PopoverContent
            align="start"
            hideWhenDetached
            className="flex w-80 flex-col p-0"
            data-testid="reminder-fire-popover"
            // A press on the open card's own chip is its toggle, not an outside click.
            onInteractOutside={(event) => {
              if (event.target instanceof Node && shown.chip.contains(event.target)) {
                event.preventDefault();
              }
            }}
            // Back to the chip, without scrolling the grid to it.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              shown.chip.focus({ preventScroll: true });
            }}
          >
            <FireCard fire={shown.fire} ctx={ctx} onClose={close} />
          </PopoverContent>
        ) : null}
      </Popover>
    </OpenFireContext.Provider>
  );
}

/** Every row: a fixed icon column at the card's left edge, text centred against it. */
const ROW = 'flex items-center gap-2.5 text-xs';
const ICON_COLUMN = 'flex w-4 shrink-0 justify-center';
const ICON = 'text-muted-foreground size-3.5';

function InfoRow({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label?: string;
  children: ReactNode;
}) {
  return (
    <div className={cn(ROW, 'min-h-6')}>
      <span className={ICON_COLUMN} aria-hidden>
        {icon}
      </span>
      {label ? <span className="sr-only">{label}</span> : null}
      <div className="text-foreground flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
    </div>
  );
}

/** What this fire is now: Paused, Failed, Fired, or Upcoming. */
function fireStatus(fire: ReminderFire): { tone: StatusTone; key: StatusKey } {
  const { reminder } = fire;
  if (reminder.state === 'paused') return { tone: 'neutral', key: 'pausedLabel' };
  if (fire.past) {
    const failed = fire.confirmed && (reminder.last_status === 'failed' || !!reminder.last_error);
    return failed
      ? { tone: 'destructive', key: 'calendarFailed' }
      : { tone: 'neutral', key: 'calendarFiredSr' };
  }
  return { tone: 'success', key: 'calendarUpcomingSr' };
}

type StatusKey = 'pausedLabel' | 'calendarFailed' | 'calendarFiredSr' | 'calendarUpcomingSr';

/** The event card: status pill and close, title, time and session rows, text actions. */
function FireCard({
  fire,
  ctx,
  onClose,
}: {
  fire: ReminderFire;
  ctx: CalendarContext;
  onClose: () => void;
}) {
  const t = useTranslations('reminders');
  const common = useTranslations('common');
  const actions = useContext(CalendarActions);
  const { reminder } = fire;
  const { locale } = ctx;
  const colors = reminderColors(reminder);
  const status = fireStatus(fire);
  const sessionHref = `/projects/${ctx.projectId}/sessions/${reminder.session_id}`;
  const date = dateFormat(locale, { weekday: 'short', day: 'numeric', month: 'short' }).format(
    fire.at,
  );

  return (
    <>
      <div className="flex items-center justify-between pt-2 pr-2 pl-3">
        <span
          className={cn(
            'flex h-5 items-center gap-1.5 rounded-full px-2 text-xs font-medium',
            STATUS_BG[status.tone],
          )}
        >
          <span className={cn('size-1.5 rounded-full', STATUS_DOT[status.tone])} aria-hidden />
          {t(status.key)}
        </span>
        <Button variant="ghost" size="icon-sm" aria-label={common('close')} onClick={onClose}>
          <XIcon className="size-3.5 shrink-0" />
        </Button>
      </div>
      <div className="flex items-start gap-2.5 px-3 pt-2.5 pb-3">
        <span className={cn(ICON_COLUMN, 'h-5 items-center')} aria-hidden>
          <span className="size-3 rounded-xs" style={{ background: colors.border }} />
        </span>
        <p
          className="text-foreground line-clamp-2 min-w-0 text-sm font-medium"
          title={reminder.prompt}
        >
          {reminderTitle(reminder)}
        </p>
      </div>
      <div className="flex flex-col gap-1.5 px-3 pb-3">
        <InfoRow icon={<ClockIcon className={ICON} />}>
          <span className="tabular-nums">
            {date} · {clockTime(fire.at, locale)}
            <span className="text-muted-foreground"> {relativeFire(fire.at, ctx.now, locale)}</span>
          </span>
          {fire.past && !fire.confirmed ? (
            <span className="text-muted-foreground">{t('calendarEstimated')}</span>
          ) : null}
        </InfoRow>
        <InfoRow icon={<ChatCircleIcon className={ICON} />} label={t('calendarSession')}>
          <HoverPrefetchLink
            href={sessionHref}
            className="truncate underline-offset-4 hover:underline"
          >
            {reminder.session_name ?? t('untitledSession')}
          </HoverPrefetchLink>
        </InfoRow>
      </div>
      {actions ? <FireActions fire={fire} actions={actions} onClose={onClose} /> : null}
    </>
  );
}

/** Text actions on a hairline footer: Pause/Resume left, Remove right. The session row is the link. */
const ACTION =
  'text-foreground hover:text-muted-foreground flex items-center gap-1.5 text-xs font-medium transition-colors aria-disabled:opacity-50';

function FireActions({
  fire,
  actions,
  onClose,
}: {
  fire: ReminderFire;
  actions: ReminderActions;
  onClose: () => void;
}) {
  const t = useTranslations('reminders');
  const { reminder } = fire;
  const pending = actions.pendingAction(reminder);
  const active = reminder.state === 'active';
  const locked = actions.busy || undefined;
  return (
    <div className="flex items-center gap-4 border-t px-3 py-2.5">
      {reminder.state !== 'done' ? (
        <button
          type="button"
          className={ACTION}
          aria-disabled={locked}
          // Paused reminders leave the calendar (no upcoming fires): the host
          // closes the card once its chip is gone, and the toast confirms it.
          onClick={actions.busy ? undefined : () => actions.setEnabled(reminder, !active)}
        >
          {pending === 'toggle' ? <Loading className="size-3" /> : null}
          {active ? t('pause') : t('resume')}
        </button>
      ) : null}
      <button
        type="button"
        className={cn(ACTION, 'text-destructive hover:text-destructive/70 ml-auto')}
        aria-disabled={locked}
        onClick={
          actions.busy
            ? undefined
            : () => {
                onClose();
                actions.setRemoving(reminder);
              }
        }
      >
        {t('remove')}
      </button>
    </div>
  );
}
