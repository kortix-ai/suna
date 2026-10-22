'use client';

/**
 * Header chip for this session's reminders (scheduled check-ins that re-prompt
 * the session), Paper R08 "Countdown rings". Renders nothing until the session
 * has a reminder that can still fire; then `ReminderMark`, and a popover that
 * lists each reminder behind a ring of how much of its wait has passed. On a
 * pointer that hovers, a row's details and actions open in a hover card on the
 * popover's left; on a touch screen the pause and remove buttons sit in the row.
 * Past `REMINDERS_POPOVER_MAX` the popover would be a wall to scroll, so the
 * chip opens the panel's Reminders view instead (`session-reminders-panel.tsx`).
 * The session reminders read needs `project.session.start`, so a read-only
 * viewer's 403 simply leaves the chip hidden. The "Open in Reminders" link
 * shows only to a caller who has the tab (`capabilityAccess()`).
 */

import { HoverPrefetchLink } from '../../internal/components/hover-prefetch-link';
import { Button } from '../../primitives/button';
import { CountBadge } from '../../primitives/count-badge';
import { FLOATING_PANEL_SURFACE } from '../../primitives/menu-recipe';
import { Popover, PopoverContent, PopoverTrigger } from '../../primitives/popover';
import { remindersHref } from '../../internal/lib/capability-tab-routes';
import { useCapabilityAccess } from '../../internal/layout/project-settings-nav';
import { BELL_REFLECTION_MASK } from '../../internal/notifications/notification-bell';
import { badgeCount } from '../../internal/notifications/notification-rows';
import { reminderTitle } from '../../internal/reminders/reminder-format';
import {
  useNow,
  useRefetchAfterFire,
} from '../../internal/reminders/use-refetch-after-fire';
import { cn } from '../../internal/lib/utils';
import { useTranslations } from '../../i18n';
import { qk, useFeatureFlag, useSessionWorking } from '@kortix/sdk/react';
import { AlarmIcon, PauseIcon, PlayIcon, TrashIcon } from '@phosphor-icons/react';
import { useQueryClient } from '@tanstack/react-query';
import { useSessionIds } from '../../providers/session-ids';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { openSessionQuickView } from '../panel/open-session-quick-view';
import {
  CountdownRing,
  isFailedReminder,
  REMINDER_ROW_GRID,
  ReminderActions,
  ReminderFacts,
  ReminderRowCells,
  sortReminders,
  useReminderControls,
  useReminderView,
} from './reminder-parts';

/** More live reminders than this open in the side panel, not the popover. */
export const REMINDERS_POPOVER_MAX = 30;

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
      <AlarmIcon className={cn('size-4', count === 0 && 'text-muted-foreground')} />
      {count > 0 ? (
        <>
          <AlarmIcon
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

const CARD_OPEN_DELAY_MS = 200;
/** While open, a move to another row waits this long; a newer row restarts it. */
const CARD_MOVE_DEBOUNCE_MS = 50;
const CARD_CLOSE_DELAY_MS = 100;
const CARD_EDGE_PX = 8;

/**
 * The reminder card's position beside the popover. The first hover opens it
 * after a delay; while it is open, hovering another row moves it there after a
 * short debounce, so a sweep across rows moves it once, and it glides (no glide
 * and no debounce for keyboard focus; no glide under reduced motion).
 */
function useGlidingCard() {
  const panelRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<{
    id: string;
    top: number;
    side: 'left' | 'right';
    glide: boolean;
  } | null>(null);
  const openTimer = useRef<number | undefined>(undefined);
  const closeTimer = useRef<number | undefined>(undefined);
  const clearTimers = () => {
    window.clearTimeout(openTimer.current);
    window.clearTimeout(closeTimer.current);
  };
  useEffect(() => clearTimers, []);

  // Before paint: keep the card inside the viewport, then place it.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const el = cardRef.current;
    if (!active || !panel || !el) return;
    const panelTop = panel.getBoundingClientRect().top;
    const max = window.innerHeight - CARD_EDGE_PX - panelTop - el.offsetHeight;
    const top = Math.max(CARD_EDGE_PX - panelTop, Math.min(active.top, max));
    el.style.transform = `translateY(${top}px)`;
  }, [active]);

  const show = (id: string, row: HTMLElement, keyboard: boolean) => {
    const panel = panelRef.current;
    if (!panel) return;
    clearTimers();
    const panelRect = panel.getBoundingClientRect();
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const place = (glide: boolean) =>
      setActive({
        id,
        top: row.getBoundingClientRect().top - panelRect.top,
        // 288px card + 12px bridge; the right side only when the left has no room.
        side: panelRect.left >= 300 + CARD_EDGE_PX ? 'left' : 'right',
        glide,
      });
    if (keyboard) place(false);
    else if (active) openTimer.current = window.setTimeout(() => place(!reduce), CARD_MOVE_DEBOUNCE_MS);
    else openTimer.current = window.setTimeout(() => place(false), CARD_OPEN_DELAY_MS);
  };
  const leave = () => {
    clearTimers();
    closeTimer.current = window.setTimeout(() => setActive(null), CARD_CLOSE_DELAY_MS);
  };
  const close = () => {
    clearTimers();
    setActive(null);
  };
  return { panelRef, cardRef, active, show, leave, close, cancelClose: clearTimers };
}

export function SessionRemindersIndicator({ runtimeSessionId }: { runtimeSessionId: string }) {
  const t = useTranslations('reminders');
  // useSessionIds: the project and the Kortix session reminders key on.
  const { projectId, sessionId } = useSessionIds<{ projectId: string; sessionId: string }>();
  const gate = useFeatureFlag(projectId, 'reminders');
  const { reminders, controls, confirm } = useReminderControls(gate.enabled ? projectId : null, sessionId);
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
  const { panelRef, cardRef, active: activeCard, show: showCard, leave: leaveCard, close: closeCard, cancelClose } =
    useGlidingCard();
  const view = useReminderView(now);

  const live = (reminders.data?.reminders ?? []).filter((reminder) => reminder.state !== 'done');
  if (live.length === 0) return null;
  const activeCount = live.filter((reminder) => reminder.state === 'active').length;
  const rows = sortReminders(live);
  const mark = <ReminderMark count={activeCount} failed={live.some(isFailedReminder)} />;

  if (live.length > REMINDERS_POPOVER_MAX) {
    return (
      <Button
        variant="ghost"
        size="icon"
        aria-label={t('chipLabel', { count: activeCount })}
        className="relative"
        data-testid="session-reminders-chip"
        onClick={() => openSessionQuickView('reminders', 'chip')}
      >
        {mark}
      </Button>
    );
  }
  const shown = activeCard ? rows.find((reminder) => reminder.id === activeCard?.id) : undefined;

  return (
    <>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) closeCard();
        }}
      >
        <PopoverTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t('chipLabel', { count: activeCount })}
            className="relative"
            data-testid="session-reminders-chip"
          >
            {mark}
          </Button>
        </PopoverTrigger>
        {/* No overflow-hidden: the card sits outside the panel's left edge. */}
        <PopoverContent ref={panelRef} align="end" sideOffset={8} className="relative w-96 p-0">
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
          <ul className="max-h-96 overflow-y-auto p-1" onPointerLeave={leaveCard} onScroll={closeCard}>
            {rows.map((reminder) => {
              const v = view(reminder);
              return (
                <li key={reminder.id}>
                  <div
                    tabIndex={0}
                    data-testid="session-reminder-row"
                    data-active={activeCard?.id === reminder.id || undefined}
                    onPointerEnter={(event) => {
                      if (event.pointerType !== 'touch') showCard(reminder.id, event.currentTarget, false);
                    }}
                    onFocus={(event) => {
                      if (event.currentTarget.matches(':focus-visible')) showCard(reminder.id, event.currentTarget, true);
                    }}
                    className={cn(
                      REMINDER_ROW_GRID,
                      'hover:bg-hover focus-visible:ring-ring data-active:bg-hover rounded-lg px-2.5 py-1.5 outline-none focus-visible:ring-2',
                    )}
                  >
                    <ReminderRowCells reminder={reminder} view={v} />
                    {/* A touch screen has no hover card: its actions sit in the row. */}
                    <span className="col-start-3 row-span-2 row-start-1 hidden items-center pointer-coarse:flex">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={v.pauseLabel}
                        disabled={controls.pending}
                        onClick={() => controls.setEnabled(reminder, v.paused)}
                      >
                        {v.paused ? <PlayIcon className="size-4" /> : <PauseIcon className="size-4" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={t('remove')}
                        onClick={() => controls.requestRemove(reminder)}
                      >
                        <TrashIcon className="size-4" />
                      </Button>
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
          {shown && activeCard
            ? (() => {
                const { paused, next, nextAt, countdown, share, tone } = view(shown);
                const [major, minor] = countdown;
                return (
                  // One card for the whole list: hovering the next row moves it
                  // instead of closing one card and opening another. The padding
                  // on the popover side bridges the gap, so the pointer never
                  // leaves on its way into the card.
                  <div
                    ref={cardRef}
                    onPointerEnter={cancelClose}
                    onPointerLeave={leaveCard}
                    className={cn(
                      'absolute top-0 starting:opacity-0 pointer-coarse:hidden',
                      activeCard.side === 'left' ? 'right-full pr-3' : 'left-full pl-3',
                    )}
                    style={{
                      transition: activeCard.glide
                        ? 'transform var(--duration-normal) var(--ease-in-out)'
                        : 'opacity var(--duration-fast) var(--ease-out)',
                    }}
                  >
                    <div
                      data-testid="session-reminder-card"
                      className={cn(FLOATING_PANEL_SURFACE, 'w-72 overflow-hidden')}
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
                            {reminderTitle(shown)}
                          </p>
                          <p className="text-muted-foreground mt-0.5 text-xs">
                            {next ? t('nextRun', { time: next }) : t('pausedLabel')}
                          </p>
                        </div>
                      </div>
                      {shown.name ? (
                        <p className="text-muted-foreground line-clamp-4 px-4 pb-3 text-xs text-pretty whitespace-pre-line">
                          {shown.prompt}
                        </p>
                      ) : null}
                      <ReminderFacts reminder={shown} now={now} className="border-t px-4 py-3" />
                      <ReminderActions
                        reminder={shown}
                        controls={controls}
                        manageHref={manageHref}
                        onNavigate={() => setOpen(false)}
                        className="border-t p-2"
                      />
                    </div>
                  </div>
                );
              })()
            : null}
        </PopoverContent>
      </Popover>
      {confirm}
    </>
  );
}
