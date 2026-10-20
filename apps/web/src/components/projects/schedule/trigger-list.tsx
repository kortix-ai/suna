'use client';

/**
 * The Triggers list (Paper C03 rows, C09 trailing slot). One 52 px row per
 * trigger: the clock, which carries its health; the name over its schedule;
 * and at the end the next run over the last run. The row opens the trigger;
 * the selected row is `bg-muted`. Actions live in the sheet.
 */

import { Checkbox } from '@/components/ui/checkbox';
import { SessionDotMatrix } from '@/components/ui/dot-matrix/session-dot-matrix';
import type { UiTranslator } from '@/i18n/translator';
import { useLocale, useTranslations } from '@/i18n/use-translations';
import { cn } from '@/lib/utils';
import type { ProjectTrigger } from '@kortix/sdk';
import { Fragment, type ReactNode } from 'react';

import { describeWhen, triggerName, triggerSubtitle } from './schedule-copy';
import { TriggerTile } from './trigger-tile';

const DAY = 24 * 60 * 60 * 1000;

/** "next Mon 09:00", "next 08:45" today, "On event" for webhooks and app events, "Paused" while paused. */
export function nextRunLabel(
  trigger: Pick<ProjectTrigger, 'type' | 'enabled' | 'next_fire_at' | 'auto_paused_at'>,
  t: UiTranslator,
  locale: string,
  now: number = Date.now(),
): string {
  // An auto-pause (KRTX-1721) is runtime state: the manifest still says enabled.
  if (!trigger.enabled || trigger.auto_paused_at) return t.raw('texte159b06187d3');
  if (trigger.type !== 'cron') return t.raw('text84b05fbb7f76');
  const at = trigger.next_fire_at ? Date.parse(trigger.next_fire_at) : Number.NaN;
  if (!Number.isFinite(at)) return '—';
  const date = new Date(at);
  const time = date.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  const today = new Date(now).toDateString() === date.toDateString();
  const day = today
    ? null
    : at - now < 6 * DAY
      ? date.toLocaleDateString(locale, { weekday: 'short' })
      : date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  return t('text27a2c8b3a0d2', { value0: day ? `${day} ${time}` : time });
}

/** "2d ago", "9h ago", "3w ago" in the viewer's locale, or "Never run". */
export function lastRunLabel(
  trigger: Pick<ProjectTrigger, 'last_fired_at' | 'event'>,
  t: UiTranslator,
  locale: string,
  now: number = Date.now(),
): string {
  const iso = trigger.last_fired_at ?? trigger.event?.last_event_at ?? null;
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return t.raw('text3d40a69d3160');
  const rtf = new Intl.RelativeTimeFormat(locale, { style: 'narrow', numeric: 'auto' });
  const min = Math.floor(Math.max(0, now - at) / 60_000);
  if (min < 1) return rtf.format(0, 'second');
  if (min < 60) return rtf.format(-min, 'minute');
  if (min < 24 * 60) return rtf.format(-Math.floor(min / 60), 'hour');
  if (min < 7 * 24 * 60) return rtf.format(-Math.floor(min / (24 * 60)), 'day');
  return rtf.format(-Math.floor(min / (7 * 24 * 60)), 'week');
}

export function TriggerList({
  triggers,
  groups,
  eventNames,
  selectedSlug,
  runningSlug = null,
  onOpen,
  selection = null,
  projectPaused = false,
}: {
  triggers: ProjectTrigger[];
  /** The trigger whose Run now is in flight: its row shows the session busy mark. */
  runningSlug?: string | null;
  /** Rows under a heading each (the App events view, by app). Replaces `triggers`' order. */
  groups?: { key: string; heading: ReactNode; triggers: ProjectTrigger[] }[];
  eventNames?: ReadonlyMap<string, string>;
  selectedSlug: string | null;
  onOpen: (trigger: ProjectTrigger) => void;
  /** The project-wide pause switch is on: every clock shows paused. */
  projectPaused?: boolean;
  /** Select mode: a row toggles its checkbox instead of opening (shift: a range). */
  selection?: {
    selected: ReadonlySet<string>;
    onToggle: (trigger: ProjectTrigger, range: boolean) => void;
  } | null;
}) {
  const row = (trigger: ProjectTrigger) => (
    <TriggerRow
      key={trigger.slug}
      trigger={trigger}
      eventNames={eventNames}
      selected={!selection && trigger.slug === selectedSlug}
      running={trigger.slug === runningSlug}
      onOpen={() => onOpen(trigger)}
      checked={selection ? selection.selected.has(trigger.slug) : null}
      projectPaused={projectPaused}
      onToggle={(range) => selection?.onToggle(trigger, range)}
    />
  );
  return (
    // A resting panel (`bg-card`, border, `rounded-lg`), so the rows sit on a
    // surface in both themes; hover is one step up, the open row one more.
    <ul
      role={selection ? 'listbox' : undefined}
      aria-multiselectable={selection ? true : undefined}
      className="bg-card border-border flex flex-col rounded-lg border p-1"
    >
      {groups
        ? groups.map((group) => (
            <Fragment key={group.key}>
              <li role={selection ? 'presentation' : undefined} className="px-3 pt-3.5 pb-1.5">
                {group.heading}
              </li>
              {group.triggers.map(row)}
            </Fragment>
          ))
        : triggers.map(row)}
    </ul>
  );
}

function TriggerRow({
  trigger,
  eventNames,
  selected,
  running,
  onOpen,
  checked,
  onToggle,
  projectPaused,
}: {
  trigger: ProjectTrigger;
  eventNames?: ReadonlyMap<string, string>;
  selected: boolean;
  running: boolean;
  onOpen: () => void;
  /** Select mode: whether this row is checked; null outside select mode. */
  checked: boolean | null;
  onToggle: (range: boolean) => void;
  projectPaused: boolean;
}) {
  const t = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const name = triggerName(trigger);
  const subtitle = triggerSubtitle(
    name,
    describeWhen(trigger, eventNames),
    trigger.prompt_template,
  );
  const selecting = checked !== null;
  const rowClass = cn(
    'flex h-14 w-full items-center gap-3 rounded-md px-3 text-left outline-none',
    'transition-[background-color] duration-(--duration-fast)',
    // One variable paints the row and the clock's dot disc, so the cutout
    // always matches: rest = card, hover = muted at 60% over card, open = muted.
    'bg-(--row-surface) [--row-surface:var(--card)]',
    selected || checked
      ? '[--row-surface:var(--muted)]'
      : 'hover:[--row-surface:color-mix(in_oklab,var(--muted)_60%,var(--card))] focus-visible:[--row-surface:color-mix(in_oklab,var(--muted)_60%,var(--card))]',
  );
  const cells = (
    <>
      {/* One fixed 20 px slot: the clock, or the checkbox in select mode. Nothing shifts. */}
      <span className="flex size-5 shrink-0 items-center justify-center">
        {selecting ? (
          <Checkbox checked={checked} tabIndex={-1} aria-hidden className="pointer-events-none" />
        ) : (
          <TriggerTile
            trigger={trigger}
            projectPaused={projectPaused}
            running={running}
            surface="row"
          />
        )}
      </span>
      {/* No gap and tight leading: the two lines read as one block, centred on the clock. */}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-foreground truncate text-sm leading-tight font-medium">{name}</span>
        {subtitle ? (
          <span className="text-muted-foreground truncate text-xs leading-tight">{subtitle}</span>
        ) : null}
      </span>
      <span className="flex w-24 shrink-0 flex-col items-end text-xs tabular-nums">
        <span
          className={cn(
            'whitespace-nowrap',
            trigger.enabled && !trigger.auto_paused_at && !projectPaused ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {/* The project switch stops every schedule: never show a next run it will not make. */}
          {nextRunLabel(projectPaused ? { ...trigger, enabled: false } : trigger, t, locale)}
        </span>
        {running ? (
          <span className="flex h-4 items-center">
            <SessionDotMatrix sessionId={trigger.slug} size={14} className="shrink-0" />
          </span>
        ) : (
          <span className="text-muted-foreground whitespace-nowrap">
            {lastRunLabel(trigger, t, locale)}
          </span>
        )}
      </span>
    </>
  );

  if (selecting) {
    return (
      <li
        role="option"
        aria-selected={checked}
        tabIndex={0}
        onClick={(e) => onToggle(e.shiftKey)}
        onKeyDown={(e) => {
          if (e.key === ' ' || e.key === 'Enter') {
            e.preventDefault();
            onToggle(e.shiftKey);
          }
        }}
        className={cn(rowClass, 'cursor-pointer select-none')}
      >
        {cells}
      </li>
    );
  }
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? 'true' : undefined}
        className={rowClass}
      >
        {cells}
      </button>
    </li>
  );
}
