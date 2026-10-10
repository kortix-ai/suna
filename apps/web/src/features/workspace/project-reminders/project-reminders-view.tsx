'use client';

/**
 * Reminders — every scheduled check-in on the project's sessions the viewer
 * can open. A reminder is a trigger scoped to one session (API:
 * `routes/session-reminders.ts`); this page is the place to see what will
 * fire next and to pause or remove one, since each fire is a model turn.
 *
 * The shell: header, toolbar, then the List (a table) or the Calendar. View, range and session filter live in the URL.
 */

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import { ProjectPageHeader } from '@/features/workspace/project-layout/project-page-header';
import { useTranslations } from '@/i18n/use-translations';
import type { SessionReminderState } from '@kortix/sdk';
import { useFeatureFlag, useProjectReminders } from '@kortix/sdk/react';
import { AlarmIcon, ArrowUpRightIcon } from '@phosphor-icons/react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import {
  useDeferredValue,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { parseDateParam } from './reminder-calendar-model';
import { ReminderCalendarControls, ReminderCalendarTitle } from './reminder-calendar-nav';
import { ReminderCalendarView } from './reminder-calendar-view';
import { ReminderList } from './reminder-list';
import { rowsForTab } from './reminder-list-model';
import {
  ReminderSessionFilter,
  reminderSessions,
  ReminderStateTabs,
  RemindersToolbar,
  ReminderViewSwitch,
} from './reminders-toolbar';
import { CalendarStoreContext, createCalendarStore } from './use-calendar-scroll';
import { useNow, useRefetchAfterFire } from './use-refetch-after-fire';
import {
  createRemindersUrlStore,
  RemindersUrlContext,
  useRemindersUrlState,
} from './use-reminders-url-state';

const DOCS_HREF = '/docs/connect/reminders';

/** The app's mobile breakpoint (`useIsMobile`): below it the page is the List only. */
const NARROW = '(max-width: 767px)';

/**
 * Whether the viewport is phone-width, read on the first client render. Not
 * `useIsMobile`: that answers false until an effect runs, which would mount
 * the whole calendar on a phone before swapping it for the List.
 */
function useNarrowViewport(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia(NARROW);
      query.addEventListener('change', onChange);
      return () => query.removeEventListener('change', onChange);
    },
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
}

/** The page header; `actions` (the List | Calendar switch) sit on the right. */
function RemindersHeader({ projectId, actions }: { projectId: string; actions?: ReactNode }) {
  const t = useTranslations('reminders');
  return (
    <ProjectPageHeader title={t('title')} href={`/projects/${projectId}/reminders`}>
      {actions}
    </ProjectPageHeader>
  );
}

/** No reminders anywhere in the project: the first-run state, no toolbar. */
function RemindersEmpty() {
  const t = useTranslations('reminders');
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center">
      <span className="bg-kortix-purple/15 flex size-10 items-center justify-center rounded-md">
        <AlarmIcon weight="fill" className="text-kortix-purple size-6" />
      </span>
      <EmptyState
        size="sm"
        title={t('emptyTitle')}
        description={t('emptyDescription')}
        action={
          <Button asChild variant="outline" size="sm" className="gap-1.5">
            <Link href={DOCS_HREF} target="_blank" rel="noopener noreferrer" prefetch={false}>
              {t('docs')}
              <ArrowUpRightIcon className="size-3.5 shrink-0" aria-hidden />
            </Link>
          </Button>
        }
      />
    </div>
  );
}

export function ProjectRemindersView({ projectId }: { projectId: string }) {
  const params = useSearchParams();
  const query = params.toString();
  // Read from the URL once; the store writes it back. A Next navigation to
  // this page with other params (a link) still reaches it through `sync`.
  const [url] = useState(() => createRemindersUrlStore(query));
  useEffect(() => url.sync(query), [url, query]);
  return (
    <RemindersUrlContext.Provider value={url}>
      <RemindersPage projectId={projectId} />
    </RemindersUrlContext.Provider>
  );
}

function RemindersPage({ projectId }: { projectId: string }) {
  const t = useTranslations('reminders');
  const url = useRemindersUrlState();
  // The List | Calendar switch flips at once; the other view mounts as a
  // background render, so its mount never holds the click. A phone gets the
  // List only: a 7-column time grid does not fit, and the switch is hidden.
  const narrow = useNarrowViewport();
  const deferredView = useDeferredValue(url.view);
  const view = narrow ? 'list' : deferredView;
  const gate = useFeatureFlag(projectId, 'reminders');
  const reminders = useProjectReminders(gate.enabled ? projectId : null);
  useRefetchAfterFire(reminders.data?.reminders, reminders.refetch);
  const now = useNow();
  const [tab, setTab] = useState<SessionReminderState>('active');
  // The calendar position: read from `?date=` once, written back as the grid settles.
  const [calendar] = useState(() => createCalendarStore(parseDateParam(url.date, now), url.set));
  useEffect(() => calendar.dispose, [calendar]);

  const list = reminders.data?.reminders;
  const all = useMemo(() => list ?? [], [list]);
  // Stable between renders: the calendar model memoizes on it.
  const scoped = useMemo(
    () => (url.session ? all.filter((r) => r.session_id === url.session) : all),
    [all, url.session],
  );
  // Sorted once per data, filter or tab change, not on every 30 s clock tick.
  const rows = useMemo(() => rowsForTab(scoped, tab), [scoped, tab]);
  // A failed background refetch keeps the loaded rows; only a first load can fail.
  const loaded = !reminders.isLoading && !!reminders.data;

  let body: ReactNode;
  // The view switch only means something where the toolbar shows.
  let showsToolbar = false;
  if (gate.isLoading) {
    body = <Skeleton className="m-4 h-14 rounded-md" />;
  } else if (!gate.enabled) {
    body = <FeatureGateScreen featureName={t('title')} description={t('gateDescription')} />;
  } else if (loaded && all.length === 0 && !url.session) {
    body = <RemindersEmpty />;
  } else {
    showsToolbar = true;
    body = (
      <>
        <RemindersToolbar
          leading={
            view === 'list' ? (
              <ReminderStateTabs value={tab} onChange={setTab} />
            ) : (
              <ReminderCalendarTitle />
            )
          }
        >
          <ReminderSessionFilter
            sessions={reminderSessions(all)}
            value={url.session}
            onChange={(session) => url.set({ session })}
          />
          {view === 'calendar' ? <ReminderCalendarControls now={now} /> : null}
        </RemindersToolbar>
        {reminders.isError && !reminders.data ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <ErrorState
              size="sm"
              title={t('loadFailed')}
              action={
                <Button variant="outline" size="sm" onClick={() => void reminders.refetch()}>
                  {t('retry')}
                </Button>
              }
            />
          </div>
        ) : view === 'calendar' ? (
          <ReminderCalendarView
            projectId={projectId}
            query={reminders}
            reminders={scoped}
            now={now}
          />
        ) : (
          <ReminderList
            // A new tab or filter starts with nothing selected.
            key={`${tab}:${url.session ?? ''}`}
            projectId={projectId}
            query={reminders}
            rows={rows}
            tab={tab}
            now={now}
            footer={
              url.session && loaded ? (
                <p className="text-muted-foreground flex items-center justify-center gap-1 text-xs">
                  {t('filterFooter', { count: scoped.length, total: all.length })}
                  <span aria-hidden>·</span>
                  <Button
                    variant="link"
                    size="sm"
                    className="h-auto p-0 text-xs"
                    onClick={() => url.set({ session: null })}
                  >
                    {t('clearFilter')}
                  </Button>
                </p>
              ) : null
            }
          />
        )}
      </>
    );
  }

  return (
    <CalendarStoreContext.Provider value={calendar}>
      <div className="flex h-svh flex-col overflow-hidden">
        <RemindersHeader
          projectId={projectId}
          actions={
            showsToolbar && !narrow ? (
              <ReminderViewSwitch value={url.view} onChange={(view) => url.set({ view })} />
            ) : null
          }
        />
        {body}
      </div>
    </CalendarStoreContext.Provider>
  );
}
