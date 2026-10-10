'use client';

import { useTranslations } from '@/i18n/use-translations';
/**
 * Triggers — the single capability page at `/projects/<id>/triggers`,
 * mounted by `features/workspace/capabilities/triggers/triggers-page.tsx`.
 *
 * A trigger is one resource with two ways to start it: on a schedule, or from
 * an incoming webhook. This view lists both together — the create flow is
 * where a person picks which kind they want (`schedule/schedule-create-modal.tsx`).
 * Per-kind wording lives in `schedule/schedule-copy.ts`'s `KIND_COPY`, keyed
 * off each row's own `trigger.type`, never a page-wide prop.
 *
 * The list, panel, and create flow live in `./schedule/*`; this file owns the
 * data, the permissions, and the mutations the row actions and the panel both
 * fire, so a pause started from a row and a pause started from the panel are
 * the same code path.
 *
 * **Chrome.** This view renders `CapabilityPageShell` itself — the same shell
 * Connectors, Agents and Skills use — so all four tabs of the Customize bar
 * share one column width (`max-w-5xl`), one heading shape, and one header
 * group (search, then the actions). The shell can only own the heading if the
 * page hands it the controls that sit beside it, which is why the search box
 * and the "New trigger" button are passed up into its `search` / `action`
 * slots rather than rendered inside the list column. `triggers-page.tsx` is a
 * one-line mount as a result: the shell is the route's scroll container.
 */

import { AppLogo } from '@/components/projects/onboarding/app-logo';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Field, FieldContent, FieldDescription, FieldTitle } from '@/components/ui/field';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { PixelKortixMark } from '@/components/ui/pixel-kortix-mark';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { agentDisplayLabel } from '@/features/session/session-chat-input';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { NewEntityMenu } from '@/features/workspace/capabilities/shared/new-entity-menu';
import {
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { PROJECT_ACTIONS } from '@/lib/project-actions';
import { useProjectCan } from '@/lib/use-project-can';
import { useProjectFeatureFlags } from '@/lib/use-project-feature-flags';
import {
  type ProjectTrigger,
  deleteProjectTrigger,
  fireProjectTrigger,
  listProjectTriggers,
  setProjectTriggersActivation,
  updateProjectTrigger,
} from '@kortix/sdk';
import { contract, qk, useProjectTriggerEventApps, useVisibleAgents } from '@kortix/sdk/react';
import {
  GearSixIcon,
  LockKeyIcon,
  MagnifyingGlassIcon as SearchIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useState } from 'react';

import { EventAppsStrip } from './schedule/event-apps-strip';
import { eventAppName, indexEventApps } from './schedule/event-trigger-copy';
import {
  type TriggerKind,
  describeWhen,
  isCustomerTrigger,
  isTriggerKind,
  localizedKindCopy,
  localizedTriggersCopy,
  matchesQuery,
  triggerName,
} from './schedule/schedule-copy';
import { ScheduleDetailSheet } from './schedule/schedule-detail-sheet';
import { ScheduleTable } from './schedule/schedule-table';
import { TriggerComposer } from './schedule/trigger-composer';
import { useTriggerControls } from './schedule/trigger-controls';
import {
  TRIGGER_FILTERS,
  type TriggerFilter,
  filterTriggers,
  groupTriggersByApp,
  parseTriggerFilter,
  triggerCounts,
} from './schedule/trigger-filter';
import { useEventAppConnect } from './schedule/use-event-app-connect';
import { useEventTitles } from './schedule/use-event-titles';

/** Tab label per filter: the three kinds reuse the page's existing words. */
const FILTER_LABEL_KEY: Record<TriggerFilter, string> = {
  all: 'texta52ace420f21',
  cron: 'text221ff19c904c',
  event: 'text4b4847a6fb87',
  webhook: 'text45808d75bf89',
};

/**
 * Pure — no hooks, no data fetching. Renders the pause switch for a MANAGER
 * only; returns `null` for anyone else. Split out from
 * {@link TriggerActivationMenu} (its data-fetching container, below) purely
 * so this gate is testable under `renderToStaticMarkup` — apps/web has no DOM
 * testing library (no jsdom, no `@testing-library/react`), so a pure component
 * taking `canManage` as a prop is the only way `schedule-view.test.tsx` can pin
 * "an editor doesn't see this" without a live QueryClient. See
 * {@link TriggerActivationMenu}'s header comment for why `canManage` here is
 * deliberately NOT `ScheduleView`'s own `canWrite`.
 *
 * It is the body of a popover now, not a banner, so it carries no surface of
 * its own — `PopoverContent` supplies the border, background and padding.
 */
export function TriggerPauseSwitch({
  canManage,
  paused,
  isPending,
  onToggle,
}: {
  canManage: boolean;
  paused: boolean;
  isPending: boolean;
  onToggle: (next: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (!canManage) return null;

  return (
    <Field orientation="horizontal" className="items-start gap-3">
      <FieldContent>
        <FieldTitle>
          {tI18nComplete.raw('textf31740d0e328')}
          {paused && (
            <span className="text-muted-foreground font-normal">
              {' '}
              {tI18nComplete.raw('textcfaba14736c2')}
            </span>
          )}
        </FieldTitle>
        <FieldDescription>{tI18nComplete.raw('text19a4be984642')}</FieldDescription>
      </FieldContent>
      <Switch
        checked={paused}
        disabled={isPending}
        onCheckedChange={onToggle}
        aria-label={tI18nComplete.raw('textac910c2802d5')}
      />
    </Field>
  );
}

/**
 * Project-wide "pause everything" switch — rendered on Triggers only (see
 * {@link ScheduleView}'s call site), since it needs exactly one home.
 * Formerly `TriggersActivationCard`, a full-width banner above the list.
 *
 * **Why it is a menu now.** Pausing every trigger in a project is a rare,
 * deliberate act; the banner spent the top of the page on it and pushed the
 * list — the reason anyone opens this tab — below the fold. It lives behind
 * the gear beside "New trigger": one click away, and no longer the first
 * thing a reader sees. The paused STATE keeps its prominent home in the
 * page's warning banner, which is real, actionable information; only the
 * control moved.
 *
 * **Access gate — deliberately NOT `canWrite`, on purpose, do not merge
 * them.** `ScheduleView` below computes a `canWrite` from
 * `PROJECT_ACTIONS.PROJECT_TRIGGER_CREATE` for its own create button. This
 * control is the project-wide kill switch, and the route behind it
 * (`PATCH /projects/:id/triggers/activation`, `routes/triggers.ts`) asserts
 * `project.trigger.update` — a DIFFERENT leaf, independently grantable. So this
 * component probes that leaf directly instead of re-deriving it from a role
 * label, which is what it used to do (`effective_project_role === 'manager'`).
 *
 * Reads `qk.project.triggers(projectId)` with its OWN `useQuery` — the SAME
 * key `ScheduleView` queries below. React Query dedupes both calls into one
 * request and one cache write, so this switch and `ScheduleView`'s paused
 * banner can never disagree or double-fetch.
 */
function TriggerActivationMenu({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const queryKey = qk.project.triggers(projectId);
  const triggersQuery = useQuery({
    queryKey,
    queryFn: () => listProjectTriggers(projectId),
    ...contract('config'),
  });
  const paused = triggersQuery.data?.triggers_paused ?? false;

  // The exact leaf the activation route asserts — see this component's header
  // comment for why this is its OWN probe rather than `ScheduleView`'s create gate.
  const canManage =
    useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_TRIGGER_UPDATE).allowed === true;

  const mutation = useMutation({
    mutationFn: (next: boolean) => setProjectTriggersActivation(projectId, next),
    onSuccess: (data, next) => {
      queryClient.setQueryData(queryKey, data);
      successToast(
        next ? tI18nComplete.raw('text5f6f23bff165') : tI18nComplete.raw('text5e4efd91b927'),
      );
    },
    onError: (error: Error) => errorToast(error.message || tI18nComplete.raw('text43ec39943667')),
  });

  // The SAME leaf, applied one level up as well: the trigger
  // button must not exist for a non-manager either, or the header would carry
  // a control that opens an empty popover.
  if (!canManage) return null;

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="icon-base"
          aria-label={tI18nComplete.raw('text17c982d8eb68')}
          title={tI18nComplete.raw('text17c982d8eb68')}
        >
          <GearSixIcon className="size-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <TriggerPauseSwitch
          canManage={canManage}
          paused={paused}
          isPending={mutation.isPending || triggersQuery.isLoading}
          onToggle={(v) => mutation.mutate(v)}
        />
      </PopoverContent>
    </Popover>
  );
}

export function ScheduleView({ projectId }: { projectId: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const copy = localizedTriggersCopy(tI18nComplete);
  const kindCopy = localizedKindCopy(tI18nComplete);
  const queryClient = useQueryClient();
  // One leaf per control, the same as on the Agent page (KRTX-1720).
  const controls = useTriggerControls(projectId);
  const canWrite = controls.canCreate;

  // Same entity/fetcher `TriggersActivationCard` above reads — both must share
  // this key, via `qk.project.triggers`, or a pause in one goes unseen in the
  // other (see that component's own header comment).
  const queryKey = useMemo(() => qk.project.triggers(projectId), [projectId]);
  const triggersQuery = useQuery({
    queryKey,
    queryFn: () => listProjectTriggers(projectId),
    ...contract('config'),
    refetchInterval: 10_000,
  });

  const [query, setQuery] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  // The empty state's "App event" button opens the form past the type step.
  const [createKind, setCreateKind] = useState<TriggerKind | null>(null);
  // The app picked in the "Apps with events" strip. The composer lists its events and sends no request.
  const [createApp, setCreateApp] = useState<{ app: string } | null>(null);
  const openCreate = (kind: TriggerKind | null = null, app: { app: string } | null = null) => {
    setCreateKind(kind);
    setCreateApp(app);
    setCreateOpen(true);
  };
  const eventConnect = useEventAppConnect(projectId);
  const configure = useConfigureThread(projectId);
  // `?t=<slug>` opens that trigger's sheet: the connector page links here.
  const searchParams = useSearchParams();
  const linkedSlug = searchParams?.get('t') ?? null;
  // App events are a beta feature behind the project flag `event_triggers`. Fail
  // closed: until the flag resolves on, nothing that lists, browses or requests events renders.
  const featureFlags = useProjectFeatureFlags(projectId);
  const eventsOn = featureFlags.flags.event_triggers === true;
  const filters = useMemo(
    () => (eventsOn ? TRIGGER_FILTERS : TRIGGER_FILTERS.filter((f) => f !== 'event')),
    [eventsOn],
  );
  // `?type=cron|event|webhook` is the kind filter; anything else, and `event` while events are off, is all.
  const filter = parseTriggerFilter(searchParams?.get('type'), filters);
  const setFilter = (next: TriggerFilter) => {
    const params = new URLSearchParams(searchParams?.toString() ?? '');
    if (next === 'all') params.delete('type');
    else params.set('type', next);
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  };
  // A null project id keeps the hook idle: with events off the page asks for no event data at all.
  const eventApps = useProjectTriggerEventApps(eventsOn ? projectId : null);
  const appIndex = useMemo(() => indexEventApps(eventApps.data?.apps), [eventApps.data]);
  const agents = useVisibleAgents({ projectId });
  const agentLabel = useCallback((slug: string) => agentDisplayLabel(agents, slug), [agents]);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(linkedSlug);
  const [deleteTarget, setDeleteTarget] = useState<ProjectTrigger | null>(null);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey],
  );

  /* ── Mutations shared by the row menu and the detail panel ───────────── */

  const run = useMutation({
    mutationFn: (trigger: ProjectTrigger) => fireProjectTrigger(projectId, trigger.slug),
    onSuccess: (res) => {
      if (res.status === 'fired') {
        successToast(tI18nComplete.raw('textecbc89cd37a0'), {
          description: res.session_id
            ? `Session ${res.session_id.slice(0, 8)}…`
            : tI18nComplete.raw('text747e9e0e8e92'),
        });
      } else if (res.status === 'queued') {
        successToast(tI18nComplete.raw('text661ff40a07e0'), {
          description: res.reason ?? tI18nComplete.raw('text17cf41bd6a6f'),
        });
      } else {
        errorToast(tI18nComplete.raw('text9c18cb990345'), { description: res.error });
      }
      invalidate();
    },
    onError: (err) =>
      errorToast(err instanceof Error ? err.message : tI18nComplete.raw('textfc56800b00af')),
  });

  const toggle = useMutation({
    mutationFn: (trigger: ProjectTrigger) =>
      updateProjectTrigger(projectId, trigger.slug, { enabled: !trigger.enabled }),
    onSuccess: (_data, trigger) => {
      successToast(
        trigger.enabled
          ? tI18nComplete.raw('texte159b06187d3')
          : tI18nComplete.raw('texta97d32ddb6ba'),
      );
      invalidate();
    },
    onError: (err) =>
      errorToast(err instanceof Error ? err.message : tI18nComplete.raw('text43ec39943667')),
  });

  const remove = useMutation({
    mutationFn: (trigger: ProjectTrigger) => deleteProjectTrigger(projectId, trigger.slug),
    onSuccess: (_data, trigger) => {
      // Safe: `trigger` came off the `triggers` list above, already filtered
      // to `isTriggerKind`.
      const noun = kindCopy[trigger.type as TriggerKind].noun;
      successToast(
        tI18nComplete('text65e31e8628a9', { value0: noun[0].toUpperCase(), value1: noun.slice(1) }),
      );
      setDeleteTarget(null);
      setSelectedSlug(null);
      invalidate();
    },
    onError: (err) =>
      errorToast(err instanceof Error ? err.message : tI18nComplete.raw('text76bf191d6426')),
  });

  /* ── Derived state ──────────────────────────────────────────────────── */

  const isForbidden =
    triggersQuery.isError && /403|forbidden/i.test((triggersQuery.error as Error)?.message ?? '');
  const showContent = !triggersQuery.isLoading && !isForbidden && !triggersQuery.isError;

  // Both kinds, together — the create flow is where a person picks one.
  // `isTriggerKind` also drops `monitor`-type entries: a separate
  // experimental feature that shares this backend list but not this screen.
  // `isCustomerTrigger` then hides the reflector cron the starter seeds into
  // every new project: hiding it keeps the empty state reachable on a fresh
  // project without making the customer delete a trigger they never created.
  // It still schedules and fires — this is display only.
  const triggers = useMemo(
    () =>
      (triggersQuery.data?.triggers ?? []).filter(
        (t) => isTriggerKind(t.type) && isCustomerTrigger(t),
      ),
    [triggersQuery.data],
  );
  const eventNames = useEventTitles(projectId, triggers, eventsOn, eventApps.data?.apps);
  const counts = useMemo(() => triggerCounts(triggers), [triggers]);
  const ofKind = useMemo(() => filterTriggers(triggers, filter), [triggers, filter]);
  const filtered = useMemo(
    () => ofKind.filter((t) => matchesQuery(t, query, tI18nComplete)),
    [ofKind, query, tI18nComplete],
  );
  const appGroups = useMemo(
    () =>
      filter === 'event'
        ? groupTriggersByApp(filtered, eventApps.data?.apps ?? []).map((g) => ({
            key: g.app,
            triggers: g.triggers,
            heading: (
              <span className="flex items-center gap-2">
                <AppLogo src={g.logo} />
                <span className="text-foreground text-sm font-medium">{g.name}</span>
                <span className="text-muted-foreground text-xs tabular-nums">
                  {g.triggers.length}
                </span>
              </span>
            ),
          }))
        : undefined,
    [filter, filtered, eventApps.data],
  );

  const showFilter = showContent && (triggers.length > 0 || filter !== 'all');
  const selected = triggers.find((t) => t.slug === selectedSlug) ?? null;
  const parseErrors = triggersQuery.data?.errors ?? [];
  const paused = triggersQuery.data?.triggers_paused ?? false;

  return (
    <CapabilityPageShell
      /* The heading comes from `TRIGGERS_COPY` — this is one page now, not a
         pane switched by `type`. It read the Settings rail while
         Schedules/Webhooks were overlay panes; a capability page has no rail
         entry, and a rail lookup that misses renders no heading at all. */
      title={copy.title}
      description={copy.description}
      search={
        showContent && triggers.length > 0 ? (
          <InputGroupSearch>
            <InputGroupSearchIcon>
              <SearchIcon />
            </InputGroupSearchIcon>
            <InputGroupSearchInput
              placeholder={copy.searchPlaceholder}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              variant="popover"
              size="sm"
            />
            <InputGroupSearchClear onClick={() => setQuery('')} />
          </InputGroupSearch>
        ) : undefined
      }
      filters={
        showFilter ? (
          <Tabs
            value={filter}
            onValueChange={(next) => setFilter(parseTriggerFilter(next, filters))}
            className="max-w-full overflow-x-auto"
          >
            <TabsList aria-label={tI18nComplete.raw('text51035b5b67dc')}>
              {filters.map((value) => (
                <TabsTrigger key={value} value={value} className="gap-1.5">
                  {tI18nComplete.raw(FILTER_LABEL_KEY[value])}
                  <span className="text-muted-foreground tabular-nums">{counts[value]}</span>
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        ) : undefined
      }
      action={
        /* One right-hand cluster, secondary control first: the gear holds the
           project-wide pause (its own manager-only probe, NOT this view's
           `canWrite`), and the primary create action stays last and labelled.
           Both are hidden until the list has loaded — neither means anything
           on an error or a 403. */
        showContent ? (
          <div className="flex items-center gap-2">
            <TriggerActivationMenu projectId={projectId} />
            {canWrite ? (
              <NewEntityMenu
                label={copy.createLabel}
                pending={configure.pending}
                onChat={() => configure.start(newConfigPrompt('trigger'))}
                manual={{ onSelect: () => openCreate() }}
              />
            ) : null}
          </div>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {/* The paused STATE, not the control: it stays at the top of the page
            because a project that runs nothing on its own is something a
            reader has to know before they read the list. The switch itself
            now lives behind the header gear. */}
        {paused && showContent && (
          <InfoBanner
            tone="warning"
            icon={WarningIcon}
            title={tI18nComplete.raw('textb18b93a52cd2')}
          >
            {tI18nComplete.raw('text3bc554b5c290')}{' '}
            {copy.createLabel}.
          </InfoBanner>
        )}

        {triggersQuery.isLoading ? (
          <div className="space-y-1">
            {Array.from({ length: 5 }).map((_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder
              <Skeleton key={i} className="h-10 rounded-md" />
            ))}
          </div>
        ) : isForbidden ? (
          <InfoBanner
            tone="warning"
            icon={LockKeyIcon}
            title={tI18nComplete.raw('textabb84be05cfa')}
          >
            {tI18nComplete.raw('text22cd1f210415')} {copy.noun}
            {tI18nComplete.raw('text382584f2456e')}
          </InfoBanner>
        ) : triggersQuery.isError ? (
          <ErrorState
            size="sm"
            title={tI18nComplete('text7ce02a51e3dd', { value0: copy.noun })}
            description={
              (triggersQuery.error as Error)?.message ?? tI18nComplete.raw('text0c953ab32c60')
            }
            action={
              <Button variant="outline" size="sm" onClick={() => triggersQuery.refetch()}>
                {tI18nComplete.raw('textd8b8392e2c54')}
              </Button>
            }
          />
        ) : filter !== 'all' && ofKind.length === 0 ? (
          <EmptyState size="sm" title={kindCopy[filter as TriggerKind].emptyTitle} />
        ) : triggers.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-6 py-8">
            <EmptyState size="sm" title={copy.emptyTitle} description={copy.emptyBody} />
            <PixelKortixMark className="opacity-50" />
          </div>
        ) : filtered.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {tI18nComplete.raw('text965b516df3ba')}{' '}
            <span className="text-foreground font-medium">{query}</span>.
          </p>
        ) : (
          <ScheduleTable
            triggers={filtered}
            groups={appGroups}
            apps={appIndex}
            eventNames={eventNames}
            agentLabel={agentLabel}
            controls={controls}
            runningSlug={run.isPending ? (run.variables?.slug ?? null) : null}
            togglingSlug={toggle.isPending ? (toggle.variables?.slug ?? null) : null}
            onOpen={(t) => setSelectedSlug(t.slug)}
            onRun={(t) => run.mutate(t)}
            onToggle={(t) => toggle.mutate(t)}
            onDelete={(t) => setDeleteTarget(t)}
            onConnect={
              eventConnect.canConnect
                ? (t) =>
                    t.event &&
                    eventConnect.connect({
                      app: t.event.app ?? t.event.connector,
                      name: eventAppName(t.event, appIndex),
                      connector: t.event.connector,
                    })
                : undefined
            }
          />
        )}

        {showContent && eventsOn && filter === 'event' ? (
          <EventAppsStrip
            projectId={projectId}
            disabled={!canWrite}
            onPick={(app) => openCreate('event', { app: app.app })}
          />
        ) : null}

        {parseErrors.length > 0 && (
          <InfoBanner
            tone="warning"
            icon={WarningIcon}
            title={tI18nComplete.raw('text5f6dc605ac36')}
          >
            <ul className="space-y-0.5 text-xs">
              {parseErrors.map((err) => (
                <li key={err.slug}>
                  <code className="font-mono">{err.path}</code> — {err.error}
                </li>
              ))}
            </ul>
          </InfoBanner>
        )}
      </div>

      <TriggerComposer
        projectId={projectId}
        open={createOpen}
        onOpenChange={setCreateOpen}
        initialKind={createKind}
        initialApp={createApp}
        onCreated={(slug) => {
          setCreateOpen(false);
          invalidate();
          // Drop straight into the new entry so the address or the first run
          // is one click away, not two.
          setSelectedSlug(slug);
        }}
      />

      <ScheduleDetailSheet
        projectId={projectId}
        trigger={selected}
        eventsEnabled={eventsOn}
        controls={controls}
        open={!!selected}
        onOpenChange={(next) => {
          if (!next) setSelectedSlug(null);
        }}
        onRun={() => selected && run.mutate(selected)}
        running={run.isPending && run.variables?.slug === selected?.slug}
        onDelete={() => selected && setDeleteTarget(selected)}
        onMutated={invalidate}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(next) => {
          if (!next) setDeleteTarget(null);
        }}
        title={tI18nComplete('text4e9e0de01d8a', {
          value0: deleteTarget ? kindCopy[deleteTarget.type as TriggerKind].noun : copy.noun,
        })}
        description={
          deleteTarget ? (
            <>
              <span className="text-foreground font-medium">{triggerName(deleteTarget)}</span> (
              {describeWhen(deleteTarget).toLowerCase()}
              {tI18nComplete.raw('text33575b279b5e')}
            </>
          ) : null
        }
        confirmLabel={tI18nComplete.raw('texte2d0a54968ea')}
        confirmVariant="destructive"
        isPending={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate(deleteTarget)}
      />
    </CapabilityPageShell>
  );
}
