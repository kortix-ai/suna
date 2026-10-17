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
import { fireResultToast, triggerToastEntity } from '@/components/projects/schedule/trigger-toast';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { InfoBanner } from '@/components/ui/info-banner';
import {
  InputGroupSearch,
  InputGroupSearchClear,
  InputGroupSearchIcon,
  InputGroupSearchInput,
} from '@/components/ui/input-group';
import { Skeleton } from '@/components/ui/skeleton';
import { SplitSheet, SplitSheetMain } from '@/components/ui/split-sheet';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';
import { errorToast, successToast } from '@/components/ui/toast';
import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { CapabilityPageShell } from '@/features/workspace/capabilities/shared/capability-page-shell';
import { NewEntityMenu } from '@/features/workspace/capabilities/shared/new-entity-menu';
import {
  newConfigPrompt,
  useConfigureThread,
} from '@/features/workspace/customize/use-configure-thread';
import { useProjectFeatureFlags } from '@/lib/use-project-feature-flags';
import {
  type ProjectTrigger,
  deleteProjectTrigger,
  fireProjectTrigger,
  listProjectTriggers,
  setProjectTriggersActivation,
} from '@kortix/sdk';
import { contract, qk, useProjectTriggerEventApps } from '@kortix/sdk/react';
import {
  DotsThreeIcon,
  LightningIcon,
  LockKeyIcon,
  PauseIcon,
  PlayIcon,
  PlusIcon,
  MagnifyingGlassIcon as SearchIcon,
  WarningIcon,
} from '@phosphor-icons/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo, useRef, useState } from 'react';

import { useDebounce } from '@/hooks/use-debounce';
import { useSlashFocus } from '@/hooks/utils';
import { EventAppsStrip } from './schedule/event-apps-strip';
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
import { ScheduleDetailSplitContent } from './schedule/schedule-detail-sheet';
import { TriggerComposer } from './schedule/trigger-composer';
import { useTriggerControls } from './schedule/trigger-controls';
import {
  TRIGGER_FILTERS,
  type TriggerFilter,
  filterTriggers,
  groupTriggersByApp,
  parseTriggerFilter,
  readTriggerSheet,
  triggerSheetHref,
} from './schedule/trigger-filter';
import { TriggerList } from './schedule/trigger-list';
import { useEventTitles } from './schedule/use-event-titles';

/** Tab label per filter: the three kinds reuse the page's existing words. */
const FILTER_LABEL_KEY: Record<TriggerFilter, string> = {
  all: 'texta52ace420f21',
  cron: 'text221ff19c904c',
  event: 'text4b4847a6fb87',
  webhook: 'text45808d75bf89',
};

/**
 * Pure: no hooks, no data fetching. The toolbar's ⋯ menu (Paper C03 `6O9-0`
 * + `6YS-0`) for a viewer who may update triggers; `null` for anyone else.
 * It holds the project-wide switch: Pause all (with the active count beside
 * it) and Resume all, each disabled while it would change nothing. Split from
 * {@link TriggerActivationMenu} so the gate renders under
 * `renderToStaticMarkup` without a QueryClient.
 */
export function TriggerToolbarMenu({
  canManage,
  paused,
  isPending,
  activeCount,
  onToggle,
}: {
  canManage: boolean;
  paused: boolean;
  isPending: boolean;
  /** Enabled triggers, for the count beside Pause all. */
  activeCount: number;
  onToggle: (next: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  if (!canManage) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="icon-base"
          disabled={isPending}
          aria-label={tI18nComplete.raw('textd47d7cb0e4f8')}
        >
          <DotsThreeIcon className="text-muted-foreground size-4 shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuItem disabled={paused} onSelect={() => onToggle(true)}>
          <PauseIcon />
          {tI18nComplete.raw('text0b6258b50010')}
          <span className="text-muted-foreground ml-auto text-xs font-normal tabular-nums">
            {tI18nComplete('text3ec84fbbfd0e', { count: activeCount })}
          </span>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!paused} onSelect={() => onToggle(false)}>
          <PlayIcon />
          {tI18nComplete.raw('text43e673c5503d')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * Project-wide "pause everything" control — rendered on Triggers only (see
 * {@link ScheduleView}'s call site), since it needs exactly one home.
 * Formerly `TriggersActivationCard`, a full-width banner above the list, then
 * a switch inside a gear popover.
 *
 * It sits in the header beside "New trigger": one click, labelled, and not in
 * the list column. The paused STATE keeps its prominent home in the page's
 * warning banner; only the control lives here.
 *
 * **Access gate — the update control, not the create one.** `ScheduleView`
 * below offers New trigger on `canCreate`. This control is the project-wide
 * kill switch, and the route behind it (`PATCH /projects/:id/triggers/activation`,
 * `routes/triggers.ts`) loads the project for write and asserts
 * `project.trigger.update` — a DIFFERENT leaf, independently grantable. So it
 * reads `canUpdate` from the same trigger controls (KRTX-1720), never a role
 * label, which is what it used to do (`effective_project_role === 'manager'`).
 *
 * Reads `qk.project.triggers(projectId)` with its OWN `useQuery` — the SAME
 * key `ScheduleView` queries below. React Query dedupes both calls into one
 * request and one cache write, so this button and `ScheduleView`'s paused
 * banner can never disagree or double-fetch.
 *
 * Exported for `trigger-activation-menu.test.tsx`, which renders it per role.
 */
export function TriggerActivationMenu({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const queryClient = useQueryClient();
  const queryKey = qk.project.triggers(projectId);
  const triggersQuery = useQuery({
    queryKey,
    queryFn: () => listProjectTriggers(projectId),
    ...contract('config'),
  });
  const paused = triggersQuery.data?.triggers_paused ?? false;
  const activeCount = (triggersQuery.data?.triggers ?? []).filter(
    (t) => isTriggerKind(t.type) && isCustomerTrigger(t) && t.enabled,
  ).length;

  // The leaves the activation route asserts (project.write +
  // project.trigger.update) — see this component's header comment for why this
  // is the update control rather than `ScheduleView`'s create gate.
  const canManage = useTriggerControls(projectId).canUpdate;

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

  return (
    <TriggerToolbarMenu
      canManage={canManage}
      paused={paused}
      isPending={mutation.isPending || triggersQuery.isLoading}
      activeCount={activeCount}
      onToggle={(v) => mutation.mutate(v)}
    />
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
  // The input shows every keystroke; the list filters 200 ms after the last one.
  const { debouncedValue: debouncedQuery } = useDebounce(query, 200);
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
  const configure = useConfigureThread(projectId);
  const searchParams = useSearchParams();
  // `?id=<trigger id>[&tab=runs]` is the open trigger: a link, Back and Forward all open it.
  const sheet = readTriggerSheet(searchParams);
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
  const navigateSheet = (next: Parameters<typeof triggerSheetHref>[2]) => {
    const { href, mode } = triggerSheetHref(
      pathname,
      searchParams?.toString() ?? '',
      next,
      selected !== null,
    );
    if (mode === 'push') router.push(href, { scroll: false });
    else router.replace(href, { scroll: false });
  };
  const openTrigger = (slug: string) => navigateSheet({ slug });
  const closeTrigger = () => navigateSheet({ slug: null });
  const [deleteTarget, setDeleteTarget] = useState<ProjectTrigger | null>(null);

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey }),
    [queryClient, queryKey],
  );

  /* ── Mutations shared by the row menu and the detail panel ───────────── */

  const run = useMutation({
    mutationFn: (trigger: ProjectTrigger) => fireProjectTrigger(projectId, trigger.slug),
    onSuccess: (res, trigger) => {
      fireResultToast(res, trigger, projectId, tI18nComplete);
      invalidate();
    },
    onError: (err) =>
      errorToast(err instanceof Error ? err.message : tI18nComplete.raw('textfc56800b00af')),
  });

  const remove = useMutation({
    mutationFn: (trigger: ProjectTrigger) => deleteProjectTrigger(projectId, trigger.slug),
    onSuccess: (_data, trigger) => {
      // Safe: `trigger` came off the `triggers` list above, already filtered
      // to `isTriggerKind`.
      const noun = kindCopy[trigger.type as TriggerKind].noun;
      successToast(
        tI18nComplete('text65e31e8628a9', { value0: noun[0].toUpperCase(), value1: noun.slice(1) }),
        { entity: triggerToastEntity(trigger) },
      );
      setDeleteTarget(null);
      closeTrigger();
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
  // The search only renders over a non-empty list; focus it once it does.
  const searchRef = useRef<HTMLInputElement>(null);
  useSlashFocus(searchRef, showContent && triggers.length > 0);
  const eventNames = useEventTitles(projectId, triggers, eventsOn, eventApps.data?.apps);
  const ofKind = useMemo(() => filterTriggers(triggers, filter), [triggers, filter]);
  const filtered = useMemo(
    () => ofKind.filter((t) => matchesQuery(t, debouncedQuery, tI18nComplete)),
    [ofKind, debouncedQuery, tI18nComplete],
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
  // An unknown slug matches nothing: the sheet stays closed, with no error.
  const selected = triggers.find((t) => t.slug === sheet.slug) ?? null;
  const parseErrors = triggersQuery.data?.errors ?? [];
  const paused = triggersQuery.data?.triggers_paused ?? false;

  return (
    // The open trigger takes a column beside the list, wider than it (60/40):
    // while it is open it is the main content. Below 48rem it covers the list.
    // The route's `flex min-h-0 flex-1` column bounds the height.
    <SplitSheet
      open={!!selected}
      onOpenChange={(next) => {
        if (!next) closeTrigger();
      }}
      size="lg"
      className="flex-1 [--split-sheet-max:60%] [--split-sheet-width:60%]"
    >
      <SplitSheetMain>
        <CapabilityPageShell
          /* The heading comes from `TRIGGERS_COPY` — this is one page now, not a
         pane switched by `type`. It read the Settings rail while
         Schedules/Webhooks were overlay panes; a capability page has no rail
         entry, and a rail lookup that misses renders no heading at all. */
          title={copy.title}
          description={copy.description}
          // Beside an open trigger the list is a 40% column: stack the header so
          // search, Pause all and New trigger share one full-width row.
          stacked={!!selected}
          search={
            showContent && triggers.length > 0 ? (
              <InputGroupSearch>
                <InputGroupSearchIcon>
                  <SearchIcon />
                </InputGroupSearchIcon>
                <InputGroupSearchInput
                  ref={searchRef}
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
                <TabsListCompact aria-label={tI18nComplete.raw('text51035b5b67dc')}>
                  {filters.map((value) => (
                    <TabsTriggerCompact key={value} value={value}>
                      {tI18nComplete.raw(FILTER_LABEL_KEY[value])}
                    </TabsTriggerCompact>
                  ))}
                </TabsListCompact>
              </Tabs>
            ) : undefined
          }
          action={
            /* One right-hand cluster, secondary control first: the project-wide
           pause (its own manager-only probe, NOT this view's `canWrite`), then
           the primary create action, last and labelled.
           Both are hidden until the list has loaded — neither means anything
           on an error or a 403. */
            showContent ? (
              // Paper C03 toolbar: search, then ⋯, then New trigger, `gap-2`.
              <div className="flex items-center gap-2">
                {triggers.length > 0 || paused ? (
                  <TriggerActivationMenu projectId={projectId} />
                ) : null}
                {canWrite ? (
                  <NewEntityMenu
                    label={copy.createLabel}
                    pending={configure.pending}
                    onChat={() => configure.start(newConfigPrompt('trigger'))}
                    manual={{ onSelect: () => openCreate() }}
                    variant="default"
                  />
                ) : null}
              </div>
            ) : undefined
          }
        >
          <div className="space-y-4">
            {/* The paused STATE, not the control: it stays at the top of the page
            because a project that runs nothing on its own is something a
            reader has to know before they read the list. The control itself
            is the header's Pause all / Resume all button. */}
            {paused && showContent && (
              <InfoBanner
                tone="warning"
                icon={WarningIcon}
                title={tI18nComplete.raw('textb18b93a52cd2')}
              >
                {tI18nComplete.raw('text3bc554b5c290')}
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
              <EmptyState
                icon={LightningIcon}
                title={copy.emptyTitle}
                description={copy.emptyBody}
                className="py-12"
                action={
                  canWrite ? (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => openCreate()}
                    >
                      <PlusIcon className="size-4 shrink-0" />
                      {copy.createLabel}
                    </Button>
                  ) : undefined
                }
              />
            ) : filtered.length === 0 ? (
              <p className="text-muted-foreground px-3 py-6 text-center text-xs">
                {tI18nComplete.raw('text965b516df3ba')}{' '}
                <span className="text-foreground font-medium">{debouncedQuery}</span>.
              </p>
            ) : (
              <TriggerList
                triggers={filtered}
                groups={appGroups}
                eventNames={eventNames}
                selectedSlug={selected?.slug ?? null}
                runningSlug={run.isPending ? (run.variables?.slug ?? null) : null}
                onOpen={(t) => openTrigger(t.slug)}
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
              openTrigger(slug);
            }}
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
      </SplitSheetMain>
      <ScheduleDetailSplitContent
        projectId={projectId}
        trigger={selected}
        eventsEnabled={eventsOn}
        controls={controls}
        initialTab={sheet.tab}
        onTabChange={(tab) => selected && navigateSheet({ slug: selected.slug, tab })}
        onRun={() => selected && run.mutate(selected)}
        running={run.isPending && run.variables?.slug === selected?.slug}
        onDelete={() => selected && setDeleteTarget(selected)}
        onMutated={invalidate}
      />
    </SplitSheet>
  );
}
