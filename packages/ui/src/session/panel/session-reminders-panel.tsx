'use client';

/**
 * The session's reminders as a side-panel view, for a session with more than
 * the header popover holds (`REMINDERS_POPOVER_MAX`). It is the Triggers list
 * (`customize/triggers/schedule/trigger-list.tsx`) for reminders: the search
 * field and underline tabs from the Triggers page, a time filter by next run,
 * and the same 56px rows — the clock that carries its health, the name over
 * its schedule, the next run over the last run. A row opens its prompt, facts
 * and actions in place.
 */

import { Button } from '../../primitives/button';
import { EmptyState } from '../../primitives/empty-state';
import { ErrorState } from '../../primitives/error-state';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '../../primitives/input-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../primitives/select';
import { Skeleton } from '../../primitives/skeleton';
import { Tabs, TabsList, TabsTrigger } from '../../primitives/tabs';
import { REFLECTION_MASK } from '../../primitives/toast';
import { useDebounce } from '../../hooks/use-debounce';
import { remindersHref } from '../../internal/lib/capability-tab-routes';
import { useCapabilityAccess } from '../../internal/layout/project-settings-nav';
import { reminderTitle, scheduleLabel } from '../../internal/reminders/reminder-format';
import {
  matchesQuery,
  matchesStatus,
  matchesTime,
  REMINDER_STATUS_FILTERS,
  REMINDER_TIME_FILTERS,
  type ReminderStatusFilter,
  type ReminderTimeFilter,
} from '../../internal/reminders/reminder-filter';
import { useNow } from '../../internal/reminders/use-refetch-after-fire';
import { cn } from '../../internal/lib/utils';
import { useLocale, useTranslations } from '../../i18n';
import type { SessionReminder } from '@kortix/sdk';
import { AlarmIcon, MagnifyingGlassIcon as SearchIcon } from '@phosphor-icons/react';
import { useState } from 'react';
import { CLOCK_TONE, lastRunLabel } from '../../internal/lib/trigger-clock';
import {
  ReminderActions,
  ReminderFacts,
  isFailedReminder,
  sortReminders,
  useReminderControls,
  type ReminderControls,
} from '../header/reminder-parts';

const STATUS_LABEL_KEY = {
  all: 'statusAll',
  active: 'tabActive',
  paused: 'tabPaused',
  failed: 'calendarFailed',
} as const satisfies Record<ReminderStatusFilter, string>;

const TIME_LABEL_KEY = {
  any: 'timeAny',
  hour: 'timeHour',
  day: 'timeDay',
  week: 'timeWeek',
  later: 'timeLater',
} as const satisfies Record<ReminderTimeFilter, string>;

/** The Triggers clock (`TriggerTile`) in a reminder's health, drawn with the alarm the header chip uses. */
function ReminderTile({ reminder }: { reminder: SessionReminder }) {
  const tone = isFailedReminder(reminder)
    ? CLOCK_TONE.failed
    : reminder.state !== 'active'
      ? CLOCK_TONE.paused
      : CLOCK_TONE.ok;
  return (
    <span aria-hidden className="relative size-5 shrink-0">
      <span className="text-muted-foreground absolute inset-0 flex items-center justify-center [&_svg]:size-5">
        <AlarmIcon />
      </span>
      <span
        className={cn('absolute inset-0 flex items-center justify-center [&_svg]:size-5', tone.reflection)}
        style={{ maskImage: REFLECTION_MASK, WebkitMaskImage: REFLECTION_MASK }}
      >
        <AlarmIcon />
      </span>
      <span className="absolute -right-0.75 -bottom-0.75 flex size-3 items-center justify-center rounded-full bg-(--row-surface)">
        <span className={cn('size-1.5 rounded-full', tone.dot)} />
      </span>
    </span>
  );
}

/** "in 25m", "in 8h", "in 3d": the next run in the last-run label's narrow style. */
function nextRunIn(iso: string | null, locale: string, now: number): string {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return '—';
  const rtf = new Intl.RelativeTimeFormat(locale, { style: 'narrow', numeric: 'auto' });
  const min = Math.max(0, Math.round((at - now) / 60_000));
  if (min < 60) return rtf.format(min, 'minute');
  if (min < 24 * 60) return rtf.format(Math.round(min / 60), 'hour');
  return rtf.format(Math.round(min / (24 * 60)), 'day');
}

function ReminderListRow({
  reminder,
  schedule,
  now,
  open,
  onToggle,
  controls,
  manageHref,
}: {
  reminder: SessionReminder;
  schedule: string;
  now: number;
  open: boolean;
  onToggle: () => void;
  controls: ReminderControls;
  manageHref: string | null;
}) {
  const t = useTranslations('reminders');
  const tTriggers = useTranslations('hardcodedUi.i18nComplete');
  const locale = useLocale();
  const active = reminder.state === 'active';
  // The Triggers last-run label takes a trigger's shape.
  const asTrigger = { last_fired_at: reminder.last_fired_at, event: null };
  return (
    <li
      className={cn(
        'rounded-md',
        // One variable paints the row and the clock's dot disc, so the cutout
        // always matches: rest = card, hover = muted at 60% over card, open = muted.
        'bg-(--row-surface) [--row-surface:var(--card)] transition-[background-color] duration-(--duration-fast)',
        open
          ? '[--row-surface:var(--muted)]'
          : 'hover:[--row-surface:color-mix(in_oklab,var(--muted)_60%,var(--card))] has-[button:focus-visible]:[--row-surface:color-mix(in_oklab,var(--muted)_60%,var(--card))]',
      )}
    >
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="session-reminder-panel-row"
        className="flex h-14 w-full items-center gap-3 rounded-md px-3 text-left outline-none"
      >
        <span className="flex size-5 shrink-0 items-center justify-center">
          <ReminderTile reminder={reminder} />
        </span>
        {/* No gap and tight leading: the two lines read as one block, centred on the clock. */}
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-foreground truncate text-sm leading-tight font-medium">{reminderTitle(reminder)}</span>
          <span className="text-muted-foreground truncate text-xs leading-tight">{schedule}</span>
        </span>
        <span className="flex shrink-0 flex-col items-end text-xs tabular-nums">
          <span className={cn('whitespace-nowrap', active ? 'text-foreground' : 'text-muted-foreground')}>
            {active ? nextRunIn(reminder.next_fire_at, locale, now) : t('pausedLabel')}
          </span>
          <span className="text-muted-foreground whitespace-nowrap">{lastRunLabel(asTrigger, tTriggers, locale, now)}</span>
        </span>
      </button>
      {open ? (
        // Starts under the name: the row's px-3, the 20px clock slot, gap-3.
        <div className="space-y-3 pr-3 pb-3 pl-11">
          {reminder.name ? (
            <p className="text-muted-foreground text-xs text-pretty whitespace-pre-line">{reminder.prompt}</p>
          ) : null}
          <ReminderFacts reminder={reminder} now={now} />
          <ReminderActions reminder={reminder} controls={controls} manageHref={manageHref} className="-ml-1.5" />
        </div>
      ) : null}
    </li>
  );
}

export function SessionRemindersPanel({
  projectId,
  projectSessionId,
}: {
  projectId?: string;
  projectSessionId?: string;
}) {
  const t = useTranslations('reminders');
  const now = useNow();
  const { reminders, controls, confirm } = useReminderControls(projectId ?? null, projectSessionId);
  const hasTab = useCapabilityAccess(projectId).tabs.includes('reminders');
  const manageHref = hasTab && projectId ? `${remindersHref(projectId)}?session=${projectSessionId}` : null;
  const [query, setQuery] = useState('');
  // The input shows every keystroke; the list filters 200 ms after the last one.
  const { debouncedValue: debouncedQuery } = useDebounce(query, 200);
  const [status, setStatus] = useState<ReminderStatusFilter>('all');
  const [time, setTime] = useState<ReminderTimeFilter>('any');
  const [openId, setOpenId] = useState<string | null>(null);

  if (reminders.isPending) {
    return (
      <div className="space-y-1">
        {Array.from({ length: 6 }, (_, index) => (
          <Skeleton key={index} className="h-14 rounded-md" />
        ))}
      </div>
    );
  }
  if (reminders.isError) {
    return (
      <ErrorState
        size="sm"
        title={t('loadFailed')}
        action={
          <Button variant="outline" size="sm" onClick={() => void reminders.refetch()}>
            {t('retry')}
          </Button>
        }
      />
    );
  }

  const schedule = (reminder: SessionReminder) => scheduleLabel(reminder, (key, values) => t(key, values));
  const live = sortReminders((reminders.data?.reminders ?? []).filter((reminder) => reminder.state !== 'done'));
  const shown = live.filter(
    (reminder) =>
      matchesStatus(reminder, status) &&
      matchesTime(reminder, time, now) &&
      matchesQuery(reminder, debouncedQuery, schedule(reminder)),
  );

  return (
    <div className="space-y-3">
      <InputGroupSearch>
        <InputGroupSearchIcon>
          <SearchIcon />
        </InputGroupSearchIcon>
        <InputGroupSearchInput
          placeholder={t('searchPlaceholder')}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          size="sm"
        />
        <InputGroupSearchClear onClick={() => setQuery('')} />
      </InputGroupSearch>
      <div className="flex items-center justify-between gap-3">
        <Tabs
          value={status}
          onValueChange={(next) => setStatus(next as ReminderStatusFilter)}
          className="min-w-0 overflow-x-auto"
        >
          {/* The Triggers page's tab style (underline), so both lists read the same. */}
          <TabsList type="underline" underlineSize="md" size="sm" className="h-8 justify-start gap-5">
            {REMINDER_STATUS_FILTERS.map((value) => (
              <TabsTrigger key={value} value={value} className="flex-none px-0 text-xs font-medium">
                {t(STATUS_LABEL_KEY[value])}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <Select value={time} onValueChange={(next) => setTime(next as ReminderTimeFilter)}>
          <SelectTrigger
            variant="transparent"
            size="sm"
            aria-label={t('timeFilterLabel')}
            className="text-muted-foreground h-8 shrink-0 text-xs"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {REMINDER_TIME_FILTERS.map((value) => (
              <SelectItem key={value} value={value}>
                {t(TIME_LABEL_KEY[value])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {shown.length > 0 ? (
        // The Triggers list's resting panel: `bg-card`, border, `rounded-lg`.
        <ul className="bg-card border-border flex flex-col rounded-lg border p-1">
          {shown.map((reminder) => (
            <ReminderListRow
              key={reminder.id}
              reminder={reminder}
              schedule={schedule(reminder)}
              now={now}
              open={openId === reminder.id}
              onToggle={() => setOpenId((current) => (current === reminder.id ? null : reminder.id))}
              controls={controls}
              manageHref={manageHref}
            />
          ))}
        </ul>
      ) : (
        <EmptyState size="sm" title={t('noMatch')} />
      )}
      {shown.length < live.length ? (
        <p className="text-muted-foreground px-1 text-xs tabular-nums">
          {t('filterFooter', { count: shown.length, total: live.length })}
        </p>
      ) : null}
      {confirm}
    </div>
  );
}
