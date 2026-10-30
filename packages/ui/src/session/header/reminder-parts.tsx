'use client';

/**
 * The pieces a session reminder is drawn with, shared by the header popover's
 * hover card and the panel's Reminders view (`session-reminders-panel.tsx`):
 * the countdown ring, the facts block, the action row, and the pause/remove
 * mutations with their confirm dialog.
 */

import { HoverPrefetchLink } from '../../internal/components/hover-prefetch-link';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import Hint from '../../primitives/hint';
import { errorToast, successToast } from '../../primitives/toast';
import { elapsedShare, formatFireTime, reminderTitle, scheduleLabel } from '../../internal/reminders/reminder-format';
import { cn } from '../../internal/lib/utils';
import { useLocale, useTranslations } from '../../i18n';
import type { SessionReminder } from '@kortix/sdk';
import { useSessionReminders } from '@kortix/sdk/react';
import { ArrowClockwiseIcon, ArrowUpRightIcon, PauseIcon, PlayIcon } from '@phosphor-icons/react';
import { useState, type ReactNode } from 'react';

export const isFailedReminder = (reminder: SessionReminder) => reminder.last_status === 'failed';

/** Soonest next fire first; paused ones, which have no next fire, last. */
export function sortReminders(reminders: SessionReminder[]): SessionReminder[] {
  const key = (reminder: SessionReminder) =>
    reminder.state === 'active' && reminder.next_fire_at ? Date.parse(reminder.next_fire_at) : Infinity;
  return [...reminders].sort((a, b) => key(a) - key(b));
}

/** A ring filled clockwise from the top by `share`; an empty track around a pause glyph while paused. */
export function CountdownRing({
  share,
  size,
  stroke,
  tone,
  paused,
  children,
}: {
  share: number | null;
  size: number;
  stroke: number;
  tone: 'purple' | 'red';
  paused: boolean;
  children?: ReactNode;
}) {
  const r = (size - stroke) / 2;
  const length = 2 * Math.PI * r;
  return (
    <span className="relative flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <svg aria-hidden width={size} height={size} className="absolute inset-0 -rotate-90">
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          className="text-border"
        />
        {!paused && share !== null ? (
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="currentColor"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${length * share} ${length}`}
            className={tone === 'red' ? 'text-kortix-red' : 'text-kortix-purple'}
          />
        ) : null}
      </svg>
      {paused ? (
        <PauseIcon
          aria-hidden
          weight="fill"
          className="text-muted-foreground"
          style={{ width: Math.round(size * 0.4), height: Math.round(size * 0.4) }}
        />
      ) : (
        children
      )}
    </span>
  );
}

/** "6h" over "12m": the time left in its two largest units, narrow and localized. */
export function countdownParts(ms: number, locale: string): [string, string | null] {
  const min = Math.max(0, Math.round(ms / 60_000));
  const unit = (value: number, name: 'day' | 'hour' | 'minute') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);
  if (min >= 24 * 60) return [unit(Math.floor(min / (24 * 60)), 'day'), unit(Math.floor((min % (24 * 60)) / 60), 'hour')];
  if (min >= 60) return [unit(Math.floor(min / 60), 'hour'), unit(min % 60, 'minute')];
  return [unit(min, 'minute'), null];
}

/** What a row and its details show for one reminder at `now`. */
export function useReminderView(now: number) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  return (reminder: SessionReminder) => {
    const paused = reminder.state !== 'active';
    const nextAt = reminder.next_fire_at ? Date.parse(reminder.next_fire_at) : NaN;
    const failed = isFailedReminder(reminder);
    return {
      paused,
      isFailed: failed,
      next: !paused && reminder.next_fire_at ? formatFireTime(reminder.next_fire_at, locale, now) : null,
      nextAt,
      countdown: countdownParts(nextAt - now, locale),
      share: elapsedShare(reminder, now),
      tone: failed ? ('red' as const) : ('purple' as const),
      pauseLabel: paused ? t('resume') : t('pause'),
      schedule: scheduleLabel(reminder, (key, values) => t(key, values)),
      meta: [failed ? t('lastRunFailed') : paused ? t('pausedLabel') : null, scheduleLabel(reminder, (key, values) => t(key, values))]
        .filter(Boolean)
        .join(' · '),
    };
  };
}

/** Repeats, time zone, last run, and the last error when the run failed. */
export function ReminderFacts({
  reminder,
  now,
  className,
}: {
  reminder: SessionReminder;
  now: number;
  className?: string;
}) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  const failed = isFailedReminder(reminder);
  return (
    <dl className={cn('space-y-1.5 text-xs', className)}>
      <div className="flex justify-between gap-3">
        <dt className="text-muted-foreground">{t('repeats')}</dt>
        <dd className="text-foreground truncate">{scheduleLabel(reminder, (key, values) => t(key, values))}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-muted-foreground">{t('timeZone')}</dt>
        <dd className="text-foreground truncate">{reminder.timezone}</dd>
      </div>
      <div className="flex justify-between gap-3">
        <dt className="text-muted-foreground">{t('lastRun')}</dt>
        <dd className="text-foreground flex items-center gap-1.5">
          {reminder.last_fired_at ? (
            <>
              <span aria-hidden className={cn('size-1.5 rounded-full', failed ? 'bg-kortix-red' : 'bg-kortix-green')} />
              {formatFireTime(reminder.last_fired_at, locale, now)}
            </>
          ) : (
            t('neverRun')
          )}
        </dd>
      </div>
      {failed && reminder.last_error ? (
        <p className="text-foreground bg-kortix-red/15 mt-2 rounded-md px-2 py-1.5 font-mono break-words">
          {reminder.last_error}
        </p>
      ) : null}
    </dl>
  );
}

/** Retry a failed run, pause or resume, remove, and the link into the Reminders tab. */
export function ReminderActions({
  reminder,
  controls,
  manageHref,
  onNavigate,
  className,
}: {
  reminder: SessionReminder;
  controls: ReminderControls;
  manageHref: string | null;
  onNavigate?: () => void;
  className?: string;
}) {
  const t = useTranslations('reminders');
  const paused = reminder.state !== 'active';
  return (
    <div className={cn('flex items-center gap-1', className)}>
      {isFailedReminder(reminder) ? (
        <Button variant="secondary" size="xs" disabled={controls.running} onClick={() => controls.run(reminder)}>
          <ArrowClockwiseIcon className="size-3.5" />
          {t('retry')}
        </Button>
      ) : null}
      <Button
        variant="secondary"
        size="xs"
        disabled={controls.pending}
        onClick={() => controls.setEnabled(reminder, paused)}
      >
        {paused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
        {paused ? t('resume') : t('pause')}
      </Button>
      <Button variant="ghost" size="xs" className="text-destructive" onClick={() => controls.requestRemove(reminder)}>
        {t('remove')}
      </Button>
      {manageHref ? (
        // An icon, not a label: three text buttons overflow the 288px card.
        <Hint label={t('openInReminders')} side="top" sideOffset={6} alignOffset={0}>
          <Button
            asChild
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground ml-auto"
            aria-label={t('openInReminders')}
          >
            <HoverPrefetchLink href={manageHref} onClick={onNavigate}>
              <ArrowUpRightIcon className="size-3.5" />
            </HoverPrefetchLink>
          </Button>
        </Hint>
      ) : null}
    </div>
  );
}

export interface ReminderControls {
  pending: boolean;
  running: boolean;
  /** Fire the reminder once now. */
  run: (reminder: SessionReminder) => void;
  setEnabled: (reminder: SessionReminder, enabled: boolean) => void;
  requestRemove: (reminder: SessionReminder) => void;
}

/**
 * The session's reminders with run, pause, resume and remove. Remove asks first:
 * render `confirm` once next to whatever calls `requestRemove`.
 */
export function useReminderControls(projectId: string | null, sessionId: string | null | undefined) {
  const t = useTranslations('reminders');
  const reminders = useSessionReminders(projectId, sessionId);
  const [removing, setRemoving] = useState<SessionReminder | null>(null);
  const controls: ReminderControls = {
    pending: reminders.update.isPending,
    running: reminders.run.isPending,
    run: (reminder) =>
      reminders.run.mutate(reminder.id, {
        onSuccess: () => successToast(t('runQueued')),
        onError: (error) => errorToast(error instanceof Error ? error.message : t('runFailed')),
      }),
    setEnabled: (reminder, enabled) =>
      reminders.update.mutate(
        { reminderId: reminder.id, enabled },
        {
          onSuccess: () => successToast(enabled ? t('resumed') : t('paused')),
          onError: (error) => errorToast(error instanceof Error ? error.message : t('updateFailed')),
        },
      ),
    requestRemove: setRemoving,
  };
  const confirm = (
    <ConfirmDialog
      open={!!removing}
      onOpenChange={(next) => !next && setRemoving(null)}
      title={t('removeTitle')}
      description={t('removeDescription')}
      confirmLabel={t('remove')}
      confirmVariant="destructive"
      isPending={reminders.remove.isPending}
      onConfirm={() =>
        removing &&
        reminders.remove.mutate(removing.id, {
          onSuccess: () => {
            successToast(t('removed'));
            setRemoving(null);
          },
          onError: (error) => errorToast(error instanceof Error ? error.message : t('updateFailed')),
        })
      }
    />
  );
  return { reminders, controls, confirm };
}

/**
 * A reminder row's cells, for a `REMINDER_ROW_GRID` container: the ring and
 * the title share the first grid row, so the ring centres on the title line;
 * the next run sits at the end of that line, the schedule under the title.
 */
export const REMINDER_ROW_GRID = 'grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-2.5';

export function ReminderRowCells({
  reminder,
  view,
  trailing,
}: {
  reminder: SessionReminder;
  view: ReturnType<ReturnType<typeof useReminderView>>;
  /** Replaces the next-run time in the end column, e.g. a disclosure caret. */
  trailing?: ReactNode;
}) {
  return (
    <>
      <CountdownRing share={view.share} size={14} stroke={2} tone={view.tone} paused={view.paused} />
      <span
        className={cn('truncate text-sm leading-5', view.paused ? 'text-muted-foreground' : 'text-foreground font-medium')}
      >
        {reminderTitle(reminder)}
      </span>
      {trailing ?? (view.next ? (
        <span className="text-muted-foreground col-start-3 row-start-1 text-xs tabular-nums pointer-coarse:hidden">
          {view.next}
        </span>
      ) : null)}
      <span className="text-muted-foreground col-start-2 truncate text-xs leading-4">{view.meta}</span>
    </>
  );
}
