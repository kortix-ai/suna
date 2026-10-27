'use client';

import { Button } from '@kortix/ui/button';
import { Checkbox } from '@kortix/ui/checkbox';
import { Switch } from '@kortix/ui/switch';
import { plainGrantSwitch } from '@kortix/ui/customize/shared/agent-resource-scope';
import { Badge } from '@kortix/ui/badge';
// Leaf modules, never `customize/agents/agent-page`: that module is the whole
// agent editor, and this screen is also the project-wide `/apps` route.
import { appGrantRows } from '@kortix/ui/customize/agents/agent-apps-grant';
import {
  type AgentGrant,
  GrantModeTabs,
  grantOrphans,
  type ResourceScope,
} from '@kortix/ui/customize/shared/agent-resource-scope';
import { CapabilityPageShell } from '@kortix/ui/customize/shared/capability-page-shell';

import { Skeleton } from '@kortix/ui/skeleton';
import { errorToast } from '@kortix/ui/toast';

import { EmptyState } from '@kortix/ui/empty-state';
import { ErrorState } from '@kortix/ui/error-state';
import { ProjectPageHeader, PROJECT_ACTIONS, useProjectCan } from '@kortix/ui/workspace';
import { useTranslations } from '@/i18n/use-translations';

import { useDebounce, cn } from '@kortix/ui';
import { createAppAccessSession, type App } from '@kortix/sdk';
import { useAppAccess, useProjectApps, useProjectTriggers } from '@kortix/sdk/react';
import { ArrowUpRightIcon, HardDrivesIcon, PlusIcon } from '@phosphor-icons/react';

import Link from '@/components/site-link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import {
  AppPreview,
  PREVIEW_TILE_ASPECT,
  appCan,
  appStatus,
  cardPreviewApp,
  gridApps,
  hiddenApps,
} from '@kortix/ui/apps';
import { APP_GRID_CONTAINER, APP_GRID_COLUMN_OPTIONS, AppGridColumnsControl, useAppGridColumns, type AppGridColumns } from './app-density';
import { AppDetailModal } from './app-detail';
import { AddExternalAppDialog } from './app-add-external';
import { BackgroundApps } from './app-background-list';
export { DEPLOYMENT_COPY, deployNotice, appHost } from '@kortix/ui/apps';
export { AppPreview, AppPreviewOverlay, PREVIEW_SPINNER_DELAY_MS, scheduleSlowPreview, PREVIEW_VIEWPORT_WIDTH, PREVIEW_VIEWPORT_HEIGHT, PREVIEW_TILE_ASPECT, previewScale } from '@kortix/ui/apps';
export { APP_GRID_CONTAINER, APP_GRID_DEFAULT_COLUMNS, APP_GRID_COLUMN_OPTIONS, APP_GRID_COLUMN_ORDER, APP_GRID_COLUMNS_STORAGE_KEY, parseAppGridColumns, type AppGridColumns } from './app-density';

function AppsControls({
  columns,
  onColumnsChange,
  showColumns,
  onAdd,
}: {
  columns: AppGridColumns;
  onColumnsChange: (next: AppGridColumns) => void;
  /** Absent: the viewer may not add Apps, and the control is not shown. */
  onAdd?: () => void;
  /**
   * The control only exists to reshape a grid, so it is absent whenever there
   * is no grid — the feature gate, the error state and the empty state each
   * fill the page on their own, and a column picker over any of them is a dead
   * switch. It stays visible over the SKELETON: a control that appears once
   * loading finishes moves the two beside it on every page load.
   */
  showColumns: boolean;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');

  return (
    <>
      {showColumns ? (
        <div className="flex shrink-0 items-center pr-1">
          <AppGridColumnsControl value={columns} onChange={onColumnsChange} />
        </div>
      ) : null}
      <Link
        href="/docs/apps"
        target="_blank"
        rel="noopener noreferrer"
        prefetch={false}
        className="text-muted-foreground hover:text-foreground flex w-fit flex-none items-center gap-1 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors"
      >
        {tI18nComplete.raw('text7af023c43013')}
        <ArrowUpRightIcon className="size-3 opacity-60" aria-hidden />
      </Link>
      {onAdd ? (
        <Button size="sm" variant="secondary" className="shrink-0 gap-1.5" onClick={onAdd} data-testid="apps-add-external">
          <PlusIcon className="size-3.5 shrink-0" aria-hidden />
          {tI18nComplete.raw('text3dd46a7b552c')}
        </Button>
      ) : null}
    </>
  );
}

/**
 * The Apps screen in two variants (the agent editor's resource-page contract,
 * `packages/ui/src/customize/shared/agent-resource-scope.tsx`):
 *
 *  - `global` (default): `/projects/<id>/apps`, every App in the project.
 *  - `agent`: the same screen on one agent's page, inside the agent editor's
 *    pane. Every App carries a checkbox that grants it to the agent
 *    (`agents.<name>.apps`, by slug), driven by `grant`; the page's All ·
 *    Specific · None tabs set the mode. Everything else — the grid, the
 *    background list, Add, the detail modal — is the global screen.
 */
export function AppsView({
  projectId,
  surface = { kind: 'global' },
  grant,
}: {
  projectId: string;
  surface?: ResourceScope;
  /** Required in `agent` scope: the agent's `apps` grant. */
  grant?: AgentGrant;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const tAgentApps = useTranslations('agentApps');
  const tAgentScope = useTranslations('agentScope');
  const agentGrant = surface.kind === 'agent' ? grant : undefined;
  const apps = useProjectApps(projectId);
  const searchParams = useSearchParams();
  // Apps own their leaves — the routes assert project.app.write for policy and
  // shape changes and project.app.deploy for anything that changes what the
  // public hostname serves. Gating on a broader settings leaf let a custom role
  // that granted Apps still render read-only, and one that revoked Apps still
  // render the controls.
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_WRITE).allowed === true;
  const canDeploy = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_DEPLOY).allowed === true;
  // Exec, a volume restore or destroy: project.app.admin.
  const canAdmin = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_ADMIN).allowed === true;
  // Which App the detail modal is showing. Held by id, not by object, so a
  // refetch (a lifecycle toggle, a rollback) re-renders the modal against the
  // fresh row instead of a stale copy captured at click time. `?app=<id>`
  // opens one on arrival: the links the CLI prints and the retired
  // `/backends/<id>` routes land here.
  const [openAppId, setOpenAppId] = useState<string | null>(() => searchParams.get('app'));
  const [gridColumns, setGridColumns] = useAppGridColumns();
  const [adding, setAdding] = useState(false);
  const triggers = useProjectTriggers(projectId);
  const grid = apps.data ? gridApps(apps.data, canAdmin) : [];
  const background = apps.data ? hiddenApps(apps.data, canAdmin) : [];
  // Open or closed is the reader's call and survives a reload. Until they
  // choose, it opens only when there is no grid above it to look at instead.
  const backgroundKey = `kortix:apps:background-open:${projectId}`;
  const [backgroundChoice, setBackgroundChoice] = useState<boolean | null>(null);
  // Read after mount: the server render has no storage, and the first client
  // render must match it.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(backgroundKey);
      if (stored !== null) setBackgroundChoice(stored === '1');
    } catch {
      // Blocked storage: keep the default.
    }
  }, [backgroundKey]);
  const backgroundOpen = backgroundChoice ?? grid.length === 0;
  const setBackgroundOpen = (next: boolean) => {
    setBackgroundChoice(next);
    try {
      window.localStorage.setItem(backgroundKey, next ? '1' : '0');
    } catch {
      // Private window or blocked storage: the choice lasts until reload.
    }
  };
  const openApp = apps.data?.find((item) => item.app_id === openAppId) ?? null;
  // Agent scope: the per-App grant control. The grant stores slugs
  // (`appGrantRows`). An App whose access mode admits agents without it is
  // still grantable, and its card says so.
  const grantNeeded = new Set(appGrantRows(apps.data).filter((r) => r.needsGrant).map((r) => r.id));
  // One switch per App in every mode, like every Access view: turning one off
  // under All keeps the rest (`plainGrantSwitch`).
  const grantSwitch = agentGrant?.set
    ? plainGrantSwitch(agentGrant.value, (apps.data ?? []).map((item) => item.slug), agentGrant.set)
    : null;
  const selectFor = (app: App): AppSelect | undefined => {
    if (!grantSwitch) return undefined;
    const control = grantSwitch(app.slug);
    return {
      checked: control.checked ?? false,
      disabled: false,
      onToggle: () => control.onCheckedChange?.(!control.checked),
      label: tI18nComplete('textd4170e74c3b0', { value0: app.name }),
      note: grantNeeded.has(app.slug) ? null : tAgentApps('openWithoutGrant'),
    };
  };
  // Mirror the open App into `?app=` so a reload or a copied link reopens it.
  // Debounced so a fast open/close writes one history entry, not two.
  // `replaceState` touches only the `app` key and does not re-run the route.
  const { debouncedValue: urlAppId } = useDebounce(openAppId, 200);
  useEffect(() => {
    const url = new URL(window.location.href);
    if ((url.searchParams.get('app') ?? null) === urlAppId) return;
    if (urlAppId) url.searchParams.set('app', urlAppId);
    else url.searchParams.delete('app');
    window.history.replaceState(window.history.state, '', url);
  }, [urlAppId]);

  useEffect(() => {
    const target = searchParams.get('open_app');
    if (!target || !apps.data) return;
    const app = apps.data.find((item) => item.app_id === target);
    if (!app) return;
    void createAppAccessSession(projectId, app.app_id)
      .then((session) => window.location.replace(session.url))
      .catch((error) =>
        errorToast(error instanceof Error ? error.message : tI18nComplete.raw('texta68c25790cbe')),
      );
  }, [apps.data, projectId, searchParams, tI18nComplete]);

  const controls = (
    <AppsControls
      columns={gridColumns}
      onColumnsChange={setGridColumns}
      showColumns={apps.isLoading || grid.length > 0}
      onAdd={canWrite ? () => setAdding(true) : undefined}
    />
  );
  const body = (
    <>
          {apps.isLoading ? (
            <AppGridSkeleton columns={gridColumns} />
          ) : apps.isError ? (
            <ErrorState
              size="sm"
              title={tI18nComplete.raw('text17168ad2af4a')}
              description={(apps.error as Error).message}
              action={
                <Button size="sm" variant="outline" onClick={() => apps.refetch()}>
                  {tI18nComplete.raw('text942087cc2d41')}
                </Button>
              }
            />
          ) : grid.length ? (
            /* A gallery grid, sized by the space it has rather than by the
               window (`APP_GRID_COLUMN_OPTIONS`). `gap-y` is larger than `gap-x`
               because each tile's caption hangs BELOW it with no border to
               close it off — an equal gap would let the next row's thumbnail
               crowd the previous row's text. */
            <ul className={cn('grid gap-6', APP_GRID_COLUMN_OPTIONS[gridColumns].grid)}>
              {grid.map((app) => (
                <AppCard
                  key={app.app_id}
                  projectId={projectId}
                  app={app}
                  shown={cardPreviewApp(apps.data!, app, canAdmin)}
                  onOpen={() => setOpenAppId(app.app_id)}
                  select={selectFor(app)}
                />
              ))}
            </ul>
          ) : background.length ? (
            <p className="text-muted-foreground mb-7 text-sm text-pretty">{tI18nComplete.raw('text0d209cd1f377')}</p>
          ) : (
            <AppsEmptyState />
          )}
          {background.length && !apps.isLoading ? (
            <section className={cn(grid.length && 'mt-10')} aria-label={tI18nComplete.raw('textea2b8a878841')} data-testid="apps-background">
              <BackgroundApps
                apps={background}
                triggers={triggers.data?.triggers ?? []}
                open={backgroundOpen}
                onOpenChange={setBackgroundOpen}
                onOpen={setOpenAppId}
                select={agentGrant ? selectFor : undefined}
              />
            </section>
          ) : null}
    </>
  );
  const overlays = (
    <>
      <AddExternalAppDialog projectId={projectId} open={adding} onOpenChange={setAdding} onAdded={setOpenAppId} />
      {openApp ? (
        <AppDetailModal
          key={openApp.app_id}
          projectId={projectId}
          app={openApp}
          canWrite={canWrite}
          canDeploy={canDeploy}
          canAdmin={canAdmin}
          open
          onOpenChange={(next) => {
            if (!next) setOpenAppId(null);
          }}
        />
      ) : null}
    </>
  );

  if (agentGrant) {
    // Granted slugs with no App behind them (deleted, or renamed): listed
    // above the grid with a Missing mark, so the grant can be revoked.
    const missing = apps.data ? grantOrphans(agentGrant.value, apps.data.map((app) => app.slug)) : [];
    // Inside the agent editor's pane: the capability shell is the scroller and
    // the heading, the grant mode its filter row. The grid measures the shell's
    // column (`@container/apps`), as it measures the page's column below.
    return (
      <CapabilityPageShell
        wide
        title={tI18nComplete.raw('text89dd748442c1')}
        description={tAgentApps('description')}
        action={<div className="flex shrink-0 items-center">{controls}</div>}
        filters={<GrantModeTabs grant={agentGrant} label={tAgentScope('appsAccess')} />}
      >
        <p className="text-muted-foreground mb-4 text-xs">{tAgentApps('grantNote')}</p>
        {missing.length > 0 ? (
          <section className="mb-6 space-y-2">
            <h2 className="text-sm font-medium">{tAgentScope('missingApps')}</h2>
            <ul className="space-y-1.5">
              {missing.map((slug) => (
                <li key={slug} className="flex min-w-0 items-center gap-3">
                  <Checkbox
                    checked={agentGrant.isGranted(slug)}
                    disabled={agentGrant.mode !== 'specific'}
                    onCheckedChange={() => agentGrant.toggle(slug)}
                    aria-label={tI18nComplete('textd4170e74c3b0', { value0: slug })}
                  />
                  <code className="text-foreground truncate font-mono text-xs">{slug}</code>
                  <Badge variant="destructive" size="xs">
                    {tI18nComplete.raw('text6be36ca49ee8')}
                  </Badge>
                  <span className="text-muted-foreground hidden truncate text-xs sm:block">
                    {tI18nComplete.raw('textfecc36d012be')}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <div className={cn('flex flex-col', APP_GRID_CONTAINER)}>{body}</div>
        {overlays}
      </CapabilityPageShell>
    );
  }

  return (
    // `h-svh`, for the same reason the `(capabilities)` layout carries it:
    // nothing above this box has a definite height (every ancestor from
    // `<body>` down is `min-h-*` or `flex-1 overflow-hidden`), so without one
    // the body below would never have a bound to scroll within and the WINDOW
    // would scroll — taking the header bar with it. Bounded here, the bar needs
    // no `sticky` and no `fixed`: it is a sibling above the only scrolling
    // element on the page, so it structurally cannot move. `svh` (not `dvh`)
    // assumes mobile browser chrome is visible, so the bar can never be pushed
    // under a toolbar that reappears.
    <div className="flex h-svh flex-col overflow-hidden">
      <ProjectPageHeader title={tI18nComplete.raw('text89dd748442c1')}>{controls}</ProjectPageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* `max-w-7xl px-4` — the gallery's column, and the CONTAINER the grid
            measures itself against (`@container/apps`). Putting the container
            here and not on the scroll box is the point: this is the element
            whose width the tiles actually divide, so it already accounts for
            the cap, the gutter, and the sidebar. `px-4` matches
            `CapabilityPageShell`'s gutter so the grid never presses flush
            against the browser edge.

            `flex min-h-full flex-col` so the one child that asks for height
            gets it: `EmptyState`/`ErrorState` are built on `Empty`, which is
            `flex-1 … justify-center`, and with no bound to grow into they
            collapsed to their own content and clung to the top of a tall,
            otherwise blank page. The grid, the skeleton and the feature gate
            take their natural height and stay at the top, unaffected. */}
        <div
          className={cn(
            'mx-auto flex min-h-full w-full max-w-7xl flex-col px-4 py-6 pb-20 md:px-8',
            APP_GRID_CONTAINER,
          )}
        >
          {body}
        </div>
      </div>
      {overlays}
    </div>
  );
}

/**
 * Shape-matched placeholder: same grid, same 16:9 tile, same ONE-line caption
 * hanging below it as `AppCard`. It takes the SAME column count as the real
 * grid — a skeleton laid out three across in front of a grid that resolves to
 * four is a layout shift dressed as a loading state.
 *
 * Nine tiles: three full rows at the default three columns, so the placeholder
 * fills the page it stands in for instead of trailing off half way down it.
 *
 * The second caption bar went when the card's hostname line did. A skeleton
 * taller than the thing it stands in for is a layout shift dressed as a
 * loading state.
 */
function AppGridSkeleton({ columns }: { columns: AppGridColumns }) {
  return (
    <ul className={cn('grid gap-6', APP_GRID_COLUMN_OPTIONS[columns].grid)}>
      {Array.from({ length: 9 }).map((_, index) => (
        <li key={index}>
          <Skeleton className={cn(PREVIEW_TILE_ASPECT, 'w-full rounded-lg')} />
          <Skeleton className="mt-3 h-3.5 w-1/2 rounded-sm" />
        </li>
      ))}
    </ul>
  );
}

/**
 * Nothing here yet — so hand over the exact command that changes that.
 *
 * The old empty state described the feature and stopped, which left the one
 * question it raises ("how do I get an App onto this page?") unanswered on the
 * one screen that has room to answer it. The command is copyable, not prose:
 * `kortix apps deploy .` run in a project directory is the whole path from
 * this screen to a card.
 */
function AppsEmptyState() {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // One muted line and a hint (brand D4g): Apps are what agents build, so the
  // hint points at an agent, not at a CLI command.
  return (
    <EmptyState
      title={tI18nComplete.raw('textdb4764b8b3e7')}
      description={tI18nComplete.raw('texta7a8d2a5fb25')}
    />
  );
}

/** Agent scope: one App's grant checkbox, and the note for an App that
 *  admits agents without a grant. */
export interface AppSelect {
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
  label: string;
  note: string | null;
}

export function AppCard({
  projectId,
  app,
  shown,
  onOpen,
  select,
}: {
  projectId: string;
  app: App;
  shown: App | null;
  onOpen: () => void;
  select?: AppSelect;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // `shown` is the App whose live preview the card frames: the App itself, or
  // the first tab of one that hides its own (a backend shows its dashboard).
  // Null: an icon. The session URL is minted only for an App with capability
  // `preview`.
  const preview = !!shown && appCan(shown, 'preview');
  // SESSION only, and only when the viewer may actually open the framed App.
  // The access POLICY is an administrative read that 403s for an ordinary
  // member, and the card never renders it — the detail modal asks. The SESSION
  // 403s for any App the viewer may see but not open, which is a state the
  // server now reports up front instead of leaving the card to discover it by
  // failing.
  const canAccess = shown?.viewer_can_access !== false;
  const access = useAppAccess(projectId, shown?.app_id ?? app.app_id, { policy: false, session: canAccess && preview });
  const status = appStatus(app, tI18nComplete);
  const captionText = (
    <>
      <h3 className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">{app.name}</h3>
      <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
        {app.external_url ? null : <span aria-hidden className={cn('size-1.5 rounded-full', status.dot)} />}
        {status.label}
      </span>
    </>
  );

  return (
    <li>
      {/* Still ONE control per card, and that is why there is no hover `⋯`
          menu on the tile: the whole card is the button, and a second button
          inside it is invalid HTML and a nested hit area. Every per-App action
          lives in the detail modal's header instead. */}
      <button
        type="button"
        onClick={onOpen}
        aria-label={`Open ${app.name}`}
        className="group w-full text-left focus-visible:outline-none"
      >
        {/* The thumbnail is the ONLY bordered surface. The card used to be one
            panel with the text inside it under a divider, which framed the
            name and the host as card chrome; here they sit on the page like a
            caption under a picture, and the picture is the object. */}
        <div
          className={cn(
            'duration-normal relative overflow-hidden rounded-lg border transition-transform ease-out group-hover:-translate-y-1',
          )}
        >
          {shown ? (
            <AppPreview
              key={shown.active_deployment_id ?? shown.app_id}
              app={shown}
              url={access.session.data?.url ?? null}
              accessError={!canAccess || access.session.isError}
              interactive={false}
            />
          ) : (
            <div className={cn(PREVIEW_TILE_ASPECT, 'bg-muted/20 text-muted-foreground flex items-center justify-center')} data-testid="app-preview-icon">
              <HardDrivesIcon className="size-8" aria-hidden />
            </div>
          )}
        </div>

        {/* The caption: the App's name and whether it is up. One line. No padding of its own — it is page
            text, not the inside of a panel.

            The hostname used to sit under the name in monospace. It is the
            same `<generated-key>.apps.<domain>` shape on every card, so a
            column of them is a column of near-identical strings that differ in
            a random token nobody reads or types — noise measured in a third of
            the caption's height, on the surface whose whole job is to show the
            App. The full URL is still one click away in the detail layer,
            beside the control that opens it, which is where someone who wants
            to copy it is already going. */}
        {select ? null : <div className="mt-3 flex items-center gap-2">{captionText}</div>}
      </button>
      {/* Agent scope: the checkbox is a sibling of the card's button, never
          inside it, so the caption moves out beside it. The thumbnail still
          opens the App. */}
      {select ? (
        <div className="mt-3 flex items-center gap-2">
          {/* The caption opens the App as the thumbnail does: its own button,
              a sibling of the switch. */}
          <button
            type="button"
            onClick={onOpen}
            className="focus-visible:ring-ring/50 flex min-w-0 flex-1 items-center gap-2 rounded-sm text-left focus-visible:ring-2 focus-visible:outline-none"
          >
            {captionText}
          </button>
          {select.note ? (
            <Badge variant="muted" size="xs">
              {select.note}
            </Badge>
          ) : null}
          <Switch
            checked={select.checked}
            disabled={select.disabled}
            onCheckedChange={select.onToggle}
            aria-label={select.label}
          />
        </div>
      ) : null}
    </li>
  );
}
