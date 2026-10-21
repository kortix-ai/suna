'use client';

/**
 * Header chip for this session's reminders (scheduled check-ins that re-prompt
 * the session), Paper R08 "Countdown rings". Renders nothing until the session
 * has a reminder that can still fire; then `ReminderMark`, and a popover that
 * lists each reminder behind a ring of how much of its wait has passed. On a
 * pointer that hovers, a row's details and actions open in a hover card on the
 * popover's left; on a touch screen the pause and remove buttons sit in the row.
 * The session reminders read needs `project.session.start`, so a read-only
 * viewer's 403 simply leaves the chip hidden. The "Open in Reminders" link
 * shows only to a caller who has the tab (`capabilityAccess()`).
 */

import { HoverPrefetchLink } from '../../internal/components/hover-prefetch-link';
import { Button } from '../../primitives/button';
import { ConfirmDialog } from '../../primitives/confirm-dialog';
import { CountBadge } from '../../primitives/count-badge';
import Hint from '../../primitives/hint';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '../../primitives/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { errorToast, successToast } from '../../primitives/toast';
import { remindersHref } from '../../internal/lib/capability-tab-routes';
import { useCapabilityAccess } from '../../internal/layout/project-settings-nav';
import { BELL_REFLECTION_MASK } from '../../internal/notifications/notification-bell';
import { badgeCount } from '../../internal/notifications/notification-rows';
import {
  elapsedShare,
  formatFireTime,
  reminderTitle,
  scheduleLabel,
} from '../../internal/reminders/reminder-format';
import {
  useNow,
  useRefetchAfterFire,
} from '../../internal/reminders/use-refetch-after-fire';
import { cn } from '../../internal/lib/utils';
import { useLocale, useTranslations } from '../../i18n';
import type { SessionReminder } from '@kortix/sdk';
import { qk, useFeatureFlag, useSessionReminders, useSessionWorking } from '@kortix/sdk/react';
import { ClockIcon, PauseIcon, PlayIcon, TrashIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useSessionIds } from '../../providers/session-ids';
import { useEffect, useRef, useState, type ReactNode } from 'react';

const failed = (reminder: SessionReminder) => reminder.last_status === 'failed';

/**
 * The clock in `BellMark`'s badge-glow style: the glyph, then again in the
 * count's colour under the bell's corner mask, so the colour reaches in from
 * the corner the count sits on. Purple for active reminders, red while one's
 * last run failed. With nothing active the glyph is muted and has no count.
 */
export function ReminderMark({
  count,
  failed: anyFailed,
  surface = 'bg-background',
}: {
  count: number;
  failed: boolean;
  surface?: 'bg-background' | 'bg-sidebar';
}) {
  const tone = anyFailed
    ? { reflection: 'text-kortix-red', disc: 'bg-kortix-red' }
    : { reflection: 'text-kortix-purple', disc: 'bg-kortix-purple' };
  return (
    <span className="relative size-4 shrink-0">
      <ClockIcon className={cn('size-4', count === 0 && 'text-muted-foreground')} />
      {count > 0 ? (
        <>
          <ClockIcon
            aria-hidden
            className={cn('absolute inset-0 size-4', tone.reflection)}
            style={{ maskImage: BELL_REFLECTION_MASK, WebkitMaskImage: BELL_REFLECTION_MASK }}
          />
          {/* On the glyph's corner; the ring paints the surface so the disc reads as cut out. */}
          <span
            aria-hidden
            className={cn('absolute -right-1.5 -bottom-1.5 flex rounded-full p-px', surface)}
          >
            <span
              data-slot="reminder-count"
              className={cn(
                'text-background flex h-3 min-w-3 items-center justify-center rounded-full px-0.5 text-[9px] leading-none font-semibold tabular-nums', // audit:allow a numeral in an 11px disc on a 16px glyph; no type rung fits
                tone.disc,
              )}
            >
              {badgeCount(count)}
            </span>
          </span>
        </>
      ) : null}
    </span>
  );
}

/** A ring filled clockwise from the top by `share`; dashed and empty while paused. */
function CountdownRing({
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
          strokeDasharray={paused ? `${stroke} ${stroke * 1.5}` : undefined}
          className={paused ? 'text-muted-foreground' : 'text-border'}
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
      {children}
    </span>
  );
}

/** "6h" over "12m": the time left in its two largest units, narrow and localized. */
function countdownParts(ms: number, locale: string): [string, string | null] {
  const min = Math.max(0, Math.round(ms / 60_000));
  const unit = (value: number, name: 'day' | 'hour' | 'minute') =>
    new Intl.NumberFormat(locale, { style: 'unit', unit: name, unitDisplay: 'narrow' }).format(value);
  if (min >= 24 * 60) return [unit(Math.floor(min / (24 * 60)), 'day'), unit(Math.floor((min % (24 * 60)) / 60), 'hour')];
  if (min >= 60) return [unit(Math.floor(min / 60), 'hour'), unit(min % 60, 'minute')];
  return [unit(min, 'minute'), null];
}

export function SessionRemindersIndicator({ runtimeSessionId }: { runtimeSessionId: string }) {
  const t = useTranslations('reminders');
  const locale = useLocale();
  // useSessionIds: the project and the Kortix session reminders key on.
  const { projectId, sessionId } = useSessionIds<{ projectId: string; sessionId: string }>();
  const gate = useFeatureFlag(projectId, 'reminders');
  const reminders = useSessionReminders(gate.enabled ? projectId : null, sessionId);
  useRefetchAfterFire(reminders.data?.reminders, reminders.refetch);
  const now = useNow();
  const hasTab = useCapabilityAccess(projectId).tabs.includes('reminders');
  // Null when the host serves no customize pages: no "Open in Reminders" link.
  const manageHref = hasTab ? `${remindersHref(projectId)}?session=${sessionId}` : null;
  // An agent sets reminders mid-turn with `kortix remind`; nothing announces
  // that to this query. The turn ending is the moment to look again.
  const working = useSessionWorking(projectId ?? '', sessionId ?? '', {
    enabled: gate.enabled && !!projectId && !!sessionId,
    runtimeSessionId,
  });
  const isWorking = working.state === 'working';
  const wasWorking = useRef(isWorking);
  const queryClient = useQueryClient();
  useEffect(() => {
    // The whole project prefix: the Reminders tab moves with the chip.
    if (wasWorking.current && !isWorking && projectId) {
      void queryClient.invalidateQueries({ queryKey: qk.project.reminders(projectId) });
    }
    wasWorking.current = isWorking;
  }, [isWorking, projectId, queryClient]);
  const [open, setOpen] = useState(false);
  const [removing, setRemoving] = useState<SessionReminder | null>(null);

  const live = (reminders.data?.reminders ?? []).filter((reminder) => reminder.state !== 'done');
  if (live.length === 0) return null;
  const activeCount = live.filter((reminder) => reminder.state === 'active').length;
  // Soonest first; paused ones, which have no next fire, last.
  const rows = [...live].sort(
    (a, b) =>
      (a.state === 'active' && a.next_fire_at ? Date.parse(a.next_fire_at) : Infinity) -
      (b.state === 'active' && b.next_fire_at ? Date.parse(b.next_fire_at) : Infinity),
  );

  const setEnabled = (reminder: SessionReminder, enabled: boolean) =>
    reminders.update.mutate(
      { reminderId: reminder.id, enabled },
      {
        onSuccess: () => successToast(enabled ? t('resumed') : t('paused')),
        onError: (error) => errorToast(error instanceof Error ? error.message : t('updateFailed')),
      },
    );
  const schedule = (reminder: SessionReminder) =>
    scheduleLabel(reminder, (key, values) => t(key, values));
  const nextLabel = (reminder: SessionReminder) =>
    reminder.state === 'active' && reminder.next_fire_at
      ? formatFireTime(reminder.next_fire_at, locale, now)
      : null;

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('chipLabel', { count: activeCount })}
            className="relative"
            data-testid="session-reminders-chip"
          >
            <ReminderMark count={activeCount} failed={live.some(failed)} />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={8} className="w-96 overflow-hidden p-0">
          <div className="flex items-center justify-between gap-2 px-4 pt-3 pb-1">
            <h3 className="text-foreground flex items-center gap-2 text-sm font-medium">
              {t('title')}
              {activeCount > 0 ? <CountBadge count={activeCount} tone="reminder" /> : null}
            </h3>
            {manageHref ? (
              <Button asChild variant="ghost" size="xs" className="text-muted-foreground -mr-2.5">
                <HoverPrefetchLink href={manageHref} onClick={() => setOpen(false)}>
                  {t('cardManage')}
                </HoverPrefetchLink>
              </Button>
            ) : null}
          </div>
          <ul className="max-h-96 space-y-0.5 overflow-y-auto p-1.5">
            {rows.map((reminder) => {
              const paused = reminder.state !== 'active';
              const isFailed = failed(reminder);
              const next = nextLabel(reminder);
              const nextAt = reminder.next_fire_at ? Date.parse(reminder.next_fire_at) : NaN;
              const [major, minor] = countdownParts(nextAt - now, locale);
              const share = elapsedShare(reminder, now);
              const tone = isFailed ? 'red' : 'purple';
              const pauseLabel = paused ? t('resume') : t('pause');
              return (
                <li key={reminder.id}>
                  <HoverCard openDelay={200} closeDelay={100}>
                    <HoverCardTrigger asChild>
                      <div
                        tabIndex={0}
                        data-testid="session-reminder-row"
                        className="hover:bg-hover focus-visible:ring-ring data-[state=open]:bg-hover flex items-start gap-3 rounded-lg px-3 py-2.5 outline-none focus-visible:ring-2"
                      >
                        <span className="flex h-5 shrink-0 items-center">
                          <CountdownRing share={share} size={16} stroke={2} tone={tone} paused={paused} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span
                            className={cn(
                              'block truncate text-sm',
                              paused ? 'text-muted-foreground' : 'text-foreground font-medium',
                            )}
                          >
                            {reminderTitle(reminder)}
                          </span>
                          <span className="text-muted-foreground mt-0.5 block truncate text-xs">
                            {[
                              isFailed ? t('lastRunFailed') : paused ? t('pausedLabel') : null,
                              schedule(reminder),
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                        </span>
                        {next ? (
                          <span className="text-muted-foreground shrink-0 text-xs leading-5 tabular-nums pointer-coarse:hidden">
                            {next}
                          </span>
                        ) : null}
                        {/* A touch screen has no hover card: its actions sit in the row. */}
                        <span className="hidden shrink-0 items-center pointer-coarse:flex">
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={pauseLabel}
                            disabled={reminders.update.isPending}
                            onClick={() => setEnabled(reminder, paused)}
                          >
                            {paused ? <PlayIcon className="size-4" /> : <PauseIcon className="size-4" />}
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label={t('remove')}
                            onClick={() => setRemoving(reminder)}
                          >
                            <TrashIcon className="size-4" />
                          </Button>
                        </span>
                      </div>
                    </HoverCardTrigger>
                    <HoverCardContent
                      side="left"
                      align="start"
                      sideOffset={12}
                      animated={false}
                      className="w-72 overflow-hidden p-0"
                      data-testid="session-reminder-card"
                    >
                      <div className="flex items-center gap-3 px-4 pt-4 pb-3">
                        <CountdownRing share={share} size={44} stroke={3} tone={tone} paused={paused}>
                          {!paused && Number.isFinite(nextAt) ? (
                            <span className="flex flex-col items-center leading-none tabular-nums">
                              <span className="text-foreground text-xs font-medium">{major}</span>
                              {minor ? (
                                <span
                                  className="text-muted-foreground mt-0.5 text-[10px]" // audit:allow the minor unit inside a 44px ring
                                >
                                  {minor}
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </CountdownRing>
                        <div className="min-w-0 flex-1">
                          <p className="text-foreground text-sm font-medium text-pretty">
                            {reminderTitle(reminder)}
                          </p>
                          <p className="text-muted-foreground mt-0.5 text-xs">
                            {next ? t('nextRun', { time: next }) : t('pausedLabel')}
                          </p>
                        </div>
                      </div>
                      {reminder.name ? (
                        <p className="text-muted-foreground line-clamp-4 px-4 pb-3 text-xs text-pretty whitespace-pre-line">
                          {reminder.prompt}
                        </p>
                      ) : null}
                      <dl className="space-y-1.5 border-t px-4 py-3 text-xs">
                        <div className="flex justify-between gap-3">
                          <dt className="text-muted-foreground">{t('repeats')}</dt>
                          <dd className="text-foreground truncate">{schedule(reminder)}</dd>
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
                                <span
                                  aria-hidden
                                  className={cn(
                                    'size-1.5 rounded-full',
                                    isFailed ? 'bg-kortix-red' : 'bg-kortix-green',
                                  )}
                                />
                                {formatFireTime(reminder.last_fired_at, locale, now)}
                              </>
                            ) : (
                              t('neverRun')
                            )}
                          </dd>
                        </div>
                        {isFailed && reminder.last_error ? (
                          <p className="text-foreground bg-kortix-red/15 mt-2 rounded-md px-2 py-1.5 font-mono break-words">
                            {reminder.last_error}
                          </p>
                        ) : null}
                      </dl>
                      <div className="flex items-center gap-1 border-t p-2">
                        <Button
                          variant="secondary"
                          size="xs"
                          disabled={reminders.update.isPending}
                          onClick={() => setEnabled(reminder, paused)}
                        >
                          {paused ? <PlayIcon className="size-3.5" /> : <PauseIcon className="size-3.5" />}
                          {pauseLabel}
                        </Button>
                        <Button
                          variant="ghost"
                          size="xs"
                          className="text-destructive"
                          onClick={() => setRemoving(reminder)}
                        >
                          {t('remove')}
                        </Button>
                        {manageHref ? (
                          <Button asChild variant="ghost" size="xs" className="text-muted-foreground ml-auto">
                            <HoverPrefetchLink href={manageHref} onClick={() => setOpen(false)}>
                              {t('openInReminders')}
                            </HoverPrefetchLink>
                          </Button>
                        ) : null}
                      </div>
                    </HoverCardContent>
                  </HoverCard>
                </li>
              );
            })}
          </ul>
        </PopoverContent>
      </Popover>
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
            onError: (error) =>
              errorToast(error instanceof Error ? error.message : t('updateFailed')),
          })
        }
      />
    </>
  );
}
