'use client';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useTranslations } from '@/i18n/use-translations';
import type { ProjectReminder, SessionReminderState } from '@kortix/sdk';
import { CaretDownIcon, XIcon } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import type { RemindersView } from './use-reminders-url-state';

const ALL_SESSIONS = '__all';
const STATE_TABS = [
  ['active', 'tabActive'],
  ['paused', 'tabPaused'],
  ['done', 'tabDone'],
] as const satisfies readonly (readonly [SessionReminderState, string])[];

/** The distinct sessions the reminders sit on, by name. */
export function reminderSessions(reminders: readonly ProjectReminder[]) {
  const sessions = new Map<string, string | null>();
  for (const reminder of reminders) {
    if (reminder.session_id && !sessions.has(reminder.session_id)) {
      sessions.set(reminder.session_id, reminder.session_name);
    }
  }
  return [...sessions].map(([id, name]) => ({ id, name }));
}

/** The toolbar row under the page header: `leading` on the left, the shared controls right. */
export function RemindersToolbar({
  leading,
  children,
}: {
  leading?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
      <div className="flex min-w-0 items-center gap-2">{leading}</div>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

export function ReminderStateTabs({
  value,
  onChange,
}: {
  value: SessionReminderState;
  onChange: (value: SessionReminderState) => void;
}) {
  const t = useTranslations('reminders');
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as SessionReminderState)}>
      <TabsList>
        {STATE_TABS.map(([state, label]) => (
          <TabsTrigger key={state} value={state}>
            {t(label)}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}

/**
 * "All sessions" or one session. A set filter is tinted purple and carries its
 * own clear button beside the menu trigger (never inside it: no nested buttons).
 */
export function ReminderSessionFilter({
  sessions,
  value,
  onChange,
}: {
  sessions: { id: string; name: string | null }[];
  value: string | null;
  onChange: (sessionId: string | null) => void;
}) {
  const t = useTranslations('reminders');
  const nameOf = (name: string | null) => name ?? t('untitledSession');
  const selected = value ? sessions.find((session) => session.id === value) : undefined;
  return (
    <div
      data-testid="reminder-session-filter"
      className={value ? 'bg-kortix-purple/15 flex min-w-0 items-center rounded-md' : 'flex'}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant={value ? 'ghost' : 'outline'} size="sm" className="min-w-0 gap-1.5">
            <span className="max-w-60 truncate">
              {value
                ? t('sessionFilter', { name: nameOf(selected?.name ?? null) })
                : t('allSessions')}
            </span>
            <CaretDownIcon className="size-3.5 shrink-0" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-80">
          <DropdownMenuRadioGroup
            value={value ?? ALL_SESSIONS}
            onValueChange={(next) => onChange(next === ALL_SESSIONS ? null : next)}
          >
            <DropdownMenuRadioItem value={ALL_SESSIONS}>{t('allSessions')}</DropdownMenuRadioItem>
            {sessions.length > 0 ? <DropdownMenuSeparator /> : null}
            {sessions.map((session) => (
              <DropdownMenuRadioItem key={session.id} value={session.id}>
                <span className="truncate">{nameOf(session.name)}</span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {value ? (
        <Hint label={t('clearSessionFilter')}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('clearSessionFilter')}
            onClick={() => onChange(null)}
          >
            <XIcon className="size-3.5 shrink-0" />
          </Button>
        </Hint>
      ) : null}
    </div>
  );
}

export function ReminderViewSwitch({
  value,
  onChange,
}: {
  value: RemindersView;
  onChange: (view: RemindersView) => void;
}) {
  const t = useTranslations('reminders');
  return (
    <Tabs value={value} onValueChange={(next) => onChange(next as RemindersView)}>
      <TabsList animate="none" aria-label={t('viewLabel')}>
        <TabsTrigger value="list">{t('viewList')}</TabsTrigger>
        <TabsTrigger value="calendar">{t('viewCalendar')}</TabsTrigger>
      </TabsList>
    </Tabs>
  );
}
