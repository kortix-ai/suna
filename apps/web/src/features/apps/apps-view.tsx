'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { Skeleton } from '@/components/ui/skeleton';
import { errorToast } from '@/components/ui/toast';

import { EmptyState } from '@/features/layout/section/empty-state';
import { ErrorState } from '@/features/layout/section/error-state';
import { FeatureGateScreen } from '@/features/workspace/feature-gate-screen';
import { ProjectPageHeader } from '@/features/workspace/project-layout/project-page-header';
import { useTranslations } from '@/i18n/use-translations';
import { PROJECT_ACTIONS } from '@/lib/project-actions';

import { useProjectCan } from '@/lib/use-project-can';
import { cn } from '@/lib/utils';
import { createAppAccessSession, type App } from '@kortix/sdk';
import { useAppAccess, useFeatureFlag, useProjectApps } from '@kortix/sdk/react';
import { ArrowUpRightIcon, GlobeIcon } from '@phosphor-icons/react';

import Link from '@/components/site-link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';

import { AppPreview, PREVIEW_TILE_ASPECT } from './app-preview';
import { APP_GRID_CONTAINER, APP_GRID_COLUMN_OPTIONS, AppGridColumnsControl, useAppGridColumns, type AppGridColumns } from './app-density';
import { AppDetailModal } from './app-detail';
import { appStatus, DeployCommand, FIRST_DEPLOY_COMMAND } from './app-shared';
export { DEPLOYMENT_COPY, deployNotice, appHost } from './app-shared';
export { AppPreview, AppPreviewOverlay, PREVIEW_SPINNER_DELAY_MS, scheduleSlowPreview, PREVIEW_VIEWPORT_WIDTH, PREVIEW_VIEWPORT_HEIGHT, PREVIEW_TILE_ASPECT, previewScale } from './app-preview';
export { APP_GRID_CONTAINER, APP_GRID_DEFAULT_COLUMNS, APP_GRID_COLUMN_OPTIONS, APP_GRID_COLUMN_ORDER, APP_GRID_COLUMNS_STORAGE_KEY, parseAppGridColumns, type AppGridColumns } from './app-density';

function AppsHeader({
  projectId,
  columns,
  onColumnsChange,
  showColumns,
}: {
  projectId: string;
  columns: AppGridColumns;
  onColumnsChange: (next: AppGridColumns) => void;
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
    <ProjectPageHeader title={tI18nComplete.raw('text89dd748442c1')} href={`/projects/${projectId}/apps`}>
      {showColumns ? (
        <div className="flex shrink-0 items-center pr-1">
          <AppGridColumnsControl value={columns} onChange={onColumnsChange} />
        </div>
      ) : null}
      <Link
        href="/docs/feature-flags/apps"
        target="_blank"
        rel="noopener noreferrer"
        prefetch={false}
        className="text-muted-foreground hover:text-foreground flex w-fit flex-none items-center gap-1 px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors"
      >
        {tI18nComplete.raw('text7af023c43013')}
        <ArrowUpRightIcon className="size-3 opacity-60" aria-hidden />
      </Link>
    </ProjectPageHeader>
  );
}

export function AppsView({ projectId }: { projectId: string }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // One gating primitive, fail-closed. Apps NEVER enables itself from here:
  // activation lives only in Customize → Feature flags, so this page has no
  // mutation and no self-enable button.
  const appsGate = useFeatureFlag(projectId, 'apps');
  const apps = useProjectApps(appsGate.enabled ? projectId : null);
  const searchParams = useSearchParams();
  // Apps own their leaves — the routes assert project.app.write for policy and
  // shape changes and project.app.deploy for anything that changes what the
  // public hostname serves. Gating on project.customize.write let a custom role
  // that granted Apps still render read-only, and one that revoked Apps still
  // render the controls.
  const canWrite = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_WRITE).allowed === true;
  const canDeploy = useProjectCan(projectId, PROJECT_ACTIONS.PROJECT_APP_DEPLOY).allowed === true;
  // Which App the detail modal is showing. Held by id, not by object, so a
  // refetch (a lifecycle toggle, a rollback) re-renders the modal against the
  // fresh row instead of a stale copy captured at click time.
  const [openAppId, setOpenAppId] = useState<string | null>(null);
  const [gridColumns, setGridColumns] = useAppGridColumns();
  const openApp = apps.data?.find((item) => item.app_id === openAppId) ?? null;

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
      <AppsHeader
        projectId={projectId}
        columns={gridColumns}
        onColumnsChange={setGridColumns}
        showColumns={
          appsGate.isLoading || (appsGate.enabled && (apps.isLoading || !!apps.data?.length))
        }
      />

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
          {appsGate.isLoading ? (
            <AppGridSkeleton columns={gridColumns} />
          ) : !appsGate.enabled ? (
            <FeatureGateScreen
              featureName="Apps"
              description={tI18nComplete.raw('text3387c31a18b3')}
            />
          ) : apps.isLoading ? (
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
          ) : apps.data?.length ? (
            /* A gallery grid, sized by the space it has rather than by the
               window (`APP_GRID_COLUMN_OPTIONS`). `gap-y` is larger than `gap-x`
               because each tile's caption hangs BELOW it with no border to
               close it off — an equal gap would let the next row's thumbnail
               crowd the previous row's text. */
            <ul className={cn('grid gap-6', APP_GRID_COLUMN_OPTIONS[gridColumns].grid)}>
              {apps.data.map((app) => (
                <AppCard
                  key={app.app_id}
                  projectId={projectId}
                  app={app}
                  onOpen={() => setOpenAppId(app.app_id)}
                />
              ))}
            </ul>
          ) : (
            <AppsEmptyState />
          )}
        </div>
      </div>

      {openApp ? (
        <AppDetailModal
          key={openApp.app_id}
          projectId={projectId}
          app={openApp}
          canWrite={canWrite}
          canDeploy={canDeploy}
          open
          onOpenChange={(next) => {
            if (!next) setOpenAppId(null);
          }}
        />
      ) : null}
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
  return (
    <EmptyState
      icon={GlobeIcon}
      title={tI18nComplete.raw('text7aaec6fe02f0')}
      description={tI18nComplete.raw('text4b2e1a2b9cbc')}
      action={<DeployCommand code={FIRST_DEPLOY_COMMAND} />}
    />
  );
}

function AppCard({ projectId, app, onOpen }: { projectId: string; app: App; onOpen: () => void }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  // SESSION only, and only when the viewer may actually open this App. The
  // access POLICY is an administrative read that 403s for an ordinary member,
  // and the card never renders it — the detail modal asks. The SESSION 403s for
  // any App the viewer may see but not open, which is a state the server now
  // reports up front instead of leaving the card to discover it by failing.
  const canAccess = app.viewer_can_access !== false;
  const access = useAppAccess(projectId, app.app_id, { policy: false, session: canAccess });
  const status = appStatus(app, tI18nComplete);

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
          <AppPreview
            key={app.active_deployment_id ?? app.app_id}
            app={app}
            url={access.session.data?.url ?? null}
            accessError={!canAccess || access.session.isError}
            interactive={false}
          />
        </div>

        {/* The caption: the App's name and whether it is up. One line.
            No padding of its own — it is page text, not the inside of a panel.

            The hostname used to sit under the name in monospace. It is the
            same `<generated-key>.apps.<domain>` shape on every card, so a
            column of them is a column of near-identical strings that differ in
            a random token nobody reads or types — noise measured in a third of
            the caption's height, on the surface whose whole job is to show the
            App. The full URL is still one click away in the detail layer,
            beside the control that opens it, which is where someone who wants
            to copy it is already going. */}
        <div className="mt-3 flex items-center gap-2">
          <h3 className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
            {app.name}
          </h3>
          <Badge variant={status.live ? 'success' : 'muted'} className="shrink-0">
            {status.label}
          </Badge>
        </div>
      </button>
    </li>
  );
}
