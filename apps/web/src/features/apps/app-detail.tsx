'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';

import Loading from '@/components/ui/loading';
import { Modal, ModalContent } from '@/components/ui/modal';
import { Tabs, TabsListCompact, TabsTriggerCompact } from '@/components/ui/tabs';

import { successToast } from '@/components/ui/toast';


import { useTranslations } from '@/i18n/use-translations';

import { relativeTime } from '@/lib/relative-time';

import { cn } from '@/lib/utils';
import { type App, type AppDeployment } from '@kortix/sdk';
import { useAppAccess, useAppDeployment, useAppDeployments, useProjectApps } from '@kortix/sdk/react';
import { ArrowClockwiseIcon, ArrowSquareOutIcon, CaretDownIcon, CaretRightIcon, ClockCounterClockwiseIcon, DotsThreeIcon, LockKeyIcon, PauseIcon, PlayIcon, PlugsConnectedIcon, TrashIcon, XIcon } from '@phosphor-icons/react';

import { useState } from 'react';

import { AppPreview } from './app-preview';
import { frameKey, reloadFrame } from './app-preview-pool';
import { AppAccessModal } from './app-access';
import { AppConnectDialog } from './app-connect';
import { AppMachinesPanel, AppVolumesPanel } from './app-fleet';
import { localizedAppCopy, appCan, appCommand, appHost, appStatus, appTabLabel, childApps, deployNotice, DeployCommand } from './app-shared';

/**
 * The App, full screen, with its controls above it.
 *
 * Opening an App used to mean a new browser tab, which left Kortix behind and
 * lost every control the moment you arrived. The App now runs in place and the
 * actions that used to crowd the card sit in one bar over the top of it.
 *
 * The body and the capability items of the menu follow `app.capabilities`:
 * `preview` frames the App itself, and Connect shows for the Apps that offer
 * `member_tokens`.
 */
export function AppDetailModal({
  projectId,
  app,
  canWrite,
  canDeploy,
  canAdmin = false,
  open,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  canWrite: boolean;
  canDeploy: boolean;
  /** project.app.admin: restore a volume. */
  canAdmin?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const appCopy = localizedAppCopy(tI18nComplete);
  const apps = useProjectApps(projectId);
  const deployments = useAppDeployments(projectId, app.app_id);
  const preview = appCan(app, 'preview');
  const canAccess = app.viewer_can_access !== false;
  const access = useAppAccess(projectId, app.app_id, { policy: canWrite, session: canAccess && preview });
  const [versionsOpen, setVersionsOpen] = useState(false);
  /** The bottom panel's tab: releases, or (by capability) machines and volumes. */
  const [panelTab, setPanelTab] = useState<'releases' | 'machines' | 'volumes'>('releases');
  // The deployment whose events and build log are unfolded in the version drawer.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<
    'access' | 'delete' | 'connect' | null
  >(null);
  // Apps shown as tabs of this one (`display.parent`): a backend's dashboard.
  // An App that hides its own thumbnail opens on its first tab.
  const children = childApps(apps.data ?? [], app, canAdmin);
  const [view, setView] = useState(() =>
    app.display?.preview === 'none' && children[0] ? children[0].app_id : app.app_id,
  );
  const viewedChild = children.find((child) => child.app_id === view) ?? null;
  // The tab on screen decides what Open and Refresh act on.
  const childAccess = useAppAccess(projectId, viewedChild?.app_id ?? null, {
    policy: false,
    session: !!viewedChild && viewedChild.viewer_can_access !== false && appCan(viewedChild, 'preview'),
  });
  const viewed = viewedChild ?? app;
  const viewedSession = viewedChild ? childAccess.session : access.session;
  const [refreshing, setRefreshing] = useState(false);
  const refresh = async () => {
    setRefreshing(true);
    try {
      const fresh = await viewedSession.refetch();
      if (fresh.data?.url) reloadFrame(frameKey(viewed), fresh.data.url);
    } finally {
      setRefreshing(false);
    }
  };
  const latest = deployments.data?.[0];
  const status = appStatus(app, tI18nComplete);
  const notice = deployNotice(latest, tI18nComplete);
  const running = app.desired_state === 'running';
  // A static App is served from storage: no runtime to start, stop or keep on.
  // `hosting_type` on the App is the source; the history covers an older server.
  const isStatic =
    app.hosting_type === 'static' ||
    deployments.data?.find((row) => row.deployment_id === app.active_deployment_id)?.hosting_type === 'static';
  // An App with a runtime.
  const isServer = status.deployed && !isStatic;
  const canSleep = appCan(app, 'sleep');
  const busy = apps.start.isPending || apps.stop.isPending || apps.remove.isPending;
  const liveUrl = access.session.data?.url ?? app.url;
  const viewedUrl = viewedChild ? (childAccess.session.data?.url ?? viewedChild.url) : liveUrl;

  const lifecycle = async (action: 'start' | 'stop') => {
    try {
      await (action === 'start'
        ? apps.start.mutateAsync(app.app_id)
        : apps.stop.mutateAsync(app.app_id));
      successToast(
        `${app.name} ${action === 'start' ? tI18nComplete.raw('text61659f74fe37') : tI18nComplete.raw('textde2d423ac039')}`,
      );
    } catch {
      // Failure is already toasted by the query client's global mutations.onError.
    }
  };

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        side="fullscreen"
        animation="none"
        showCloseButton={false}
        // Radix focuses the first focusable descendant on open, which is an
        // action in the bar — and a focused icon button shows its Hint, so the
        // modal opened with a black tooltip sitting over its own controls.
        // Focus the dialog instead: the focus trap still holds, Tab still walks
        // into the bar, and nothing pops unbidden.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          (event.currentTarget as HTMLElement | null)?.focus?.();
        }}
        className="border-border bg-background! inset-0! h-dvh! max-h-none! min-h-dvh! w-auto! max-w-none! translate-x-0! translate-y-0! gap-0! space-y-0! overflow-hidden! rounded-none! border-0! focus:outline-none focus-visible:outline-none"
        aria-label={`${app.name} App`}
      >
        <div className="flex h-full min-h-0 flex-col">
          <div className="kx-titlebar-spacer" aria-hidden />
          {/* Name, and what the name needs qualifying with — nothing else.
              This row carried five things: a dot, the name, the status word, a
              raw pipeline-stage badge, an access-mode badge, and the hostname
              in monospace underneath. Four of those are answers to questions
              nobody asked while looking at their own App, and together they
              read as a debug readout rather than a title bar.

              What each one became:
               - the status WORD now appears only when it is not "Running" —
                 the green dot already says the happy path, and a permanent
                 label restating it is the noisiest kind of quiet;
               - the pipeline stage became one plain badge, and only while
                 something is actually happening (`deployNotice`);
               - the access mode moved onto the control that changes it, where
                 it reads as a current value instead of a floating label;
               - the hostname moved into the Open button's tooltip. It is a
                 thing you act on, not a thing you read. */}
          <header className="flex shrink-0 items-center gap-3 border-b px-3 py-2">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', status.dot)} />
              <h2 className="text-foreground truncate text-sm font-medium">{app.name}</h2>
              {/* One announcement, either way. The dot is `aria-hidden`, so the
                  running case needs a screen-reader-only label — but rendering
                  it unconditionally alongside the visible one made every
                  non-running state read its status out twice. */}
              {children.length ? (
                <Tabs value={view} onValueChange={setView} className="shrink-0">
                  <TabsListCompact>
                    <TabsTriggerCompact value={app.app_id}>{app.name}</TabsTriggerCompact>
                    {children.map((child) => (
                      <TabsTriggerCompact key={child.app_id} value={child.app_id}>{appTabLabel(child, app)}</TabsTriggerCompact>
                    ))}
                  </TabsListCompact>
                </Tabs>
              ) : null}
              {status.live ? (
                <span className="sr-only">{status.label}</span>
              ) : (
                <span className="text-muted-foreground shrink-0 text-xs">{status.label}</span>
              )}
              {/* A failed deploy opens its own log: the badge is the way in. */}
              {notice && latest ? (
                <button
                  type="button"
                  className="shrink-0"
                  onClick={() => {
                    setVersionsOpen(true);
                    setExpandedId(latest.deployment_id);
                  }}
                >
                  <Badge size="xs" variant={notice.tone}>
                    {notice.label}
                  </Badge>
                </button>
              ) : null}
            </div>

            {/* Two registers, and the gap is what separates them: the App's own
                actions on the left, the window's Close on the right. Close was
                the fifth button inside the group, which made "stop this App"
                and "shut this panel" look like peers of each other. It is
                `ghost` for the same reason — chrome, not an action. */}
            <div className="flex shrink-0 items-center gap-2">
              <ButtonGroup>
                {canDeploy && canSleep ? (
                  <Hint
                    label={
                      running
                        ? tI18nComplete.raw('text6f50fb1f4f46')
                        : tI18nComplete.raw('text971ed7129524')
                    }
                    side="bottom"
                  >
                    <Button
                      size="icon"
                      variant="outline"
                      disabled={busy || !status.deployed}
                      aria-label={
                        running
                          ? tI18nComplete.raw('text6f50fb1f4f46')
                          : tI18nComplete.raw('text971ed7129524')
                      }
                      onClick={() => lifecycle(running ? 'stop' : 'start')}
                    >
                      {busy ? (
                        <Loading className="size-4 shrink-0" />
                      ) : running ? (
                        <PauseIcon weight="fill" className="size-4 shrink-0" />
                      ) : (
                        <PlayIcon className="size-4 shrink-0" />
                      )}
                    </Button>
                  </Hint>
                ) : null}
                {appCan(viewed, 'preview') && viewed.active_deployment_id ? (
                  <Hint label={tI18nComplete.raw('text5b529abadacc')} side="bottom">
                    <Button
                      size="icon"
                      variant="outline"
                      disabled={refreshing}
                      aria-label={tI18nComplete.raw('text5b529abadacc')}
                      onClick={() => void refresh()}
                      data-testid="app-preview-refresh"
                    >
                      {refreshing ? <Loading className="size-4 shrink-0" /> : <ArrowClockwiseIcon className="size-4 shrink-0" />}
                    </Button>
                  </Hint>
                ) : null}
                {appCan(viewed, 'preview') ? (
                  <Hint
                    label={tI18nComplete('text06ce842278f6', { value0: appHost(viewed.url) })}
                    side="bottom"
                  >
                    <Button asChild size="icon" variant="outline">
                      <a
                        href={viewedUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={tI18nComplete.raw('text306ef19c8ac3')}
                      >
                        <ArrowSquareOutIcon className="size-4 shrink-0" />
                      </a>
                    </Button>
                  </Hint>
                ) : null}
                {/* Everything rare or configural, behind one control. Three
                    icon buttons became one, and Delete came UP out of the
                    version drawer — a destructive action does not belong
                    hidden behind a history toggle, where you find it by
                    looking for something else. */}
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="icon"
                      variant="outline"
                      aria-label={tI18nComplete.raw('textf8d46c2570e7')}
                    >
                      <DotsThreeIcon className="size-4 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-60">
                    {canWrite ? (
                      <DropdownMenuItem onClick={() => setOverlay('access')}>
                        <LockKeyIcon className="size-3.5 shrink-0" />
                        {tI18nComplete.raw('text407951d1c2e0')}
                        {/* The current value, on the row that changes it. */}
                        <span className="text-muted-foreground ml-auto pl-3 text-xs">
                          {
                            appCopy.access[app.access_mode].label
                          }
                        </span>
                      </DropdownMenuItem>
                    ) : null}
                    {canWrite && canSleep ? (
                      <DropdownMenuCheckboxItem
                        checked={app.always_on === true}
                        disabled={apps.update.isPending}
                        onCheckedChange={(on) =>
                          apps.update.mutate({ appId: app.app_id, input: { always_on: on } })
                        }
                      >
                        <span className="flex flex-col">
                          {tI18nComplete.raw('text044ba8a9ae43')}
                          <span className="text-muted-foreground text-xs">{tI18nComplete.raw('text853696d5a64d')}</span>
                        </span>
                      </DropdownMenuCheckboxItem>
                    ) : null}
                    <DropdownMenuItem onClick={() => setVersionsOpen((value) => !value)}>
                      <ClockCounterClockwiseIcon className="size-3.5 shrink-0" />
                      {versionsOpen
                        ? tI18nComplete.raw('text26b1a7703eac')
                        : tI18nComplete.raw('text401dc1a55cb9')}
                    </DropdownMenuItem>
                    {/* Capability items: only the Apps that offer them list them. */}
                    {appCan(app, 'member_tokens') ? (
                      <DropdownMenuItem onClick={() => setOverlay('connect')}>
                        <PlugsConnectedIcon className="size-3.5 shrink-0" />
                        {tI18nComplete.raw('textc0e20f6d5a3a')}
                      </DropdownMenuItem>
                    ) : null}
                    {canWrite ? (
                      <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem variant="destructive" onClick={() => setOverlay('delete')}>
                          <TrashIcon className="size-3.5 shrink-0" />
                          {tI18nComplete.raw('textd1b0a6e3985a')}
                        </DropdownMenuItem>
                      </>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              </ButtonGroup>

              <Hint label={tI18nComplete.raw('text7d9eb7acb13e')} side="bottom">
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={tI18nComplete.raw('text7d9eb7acb13e')}
                  onClick={() => onOpenChange(false)}
                >
                  <XIcon className="size-4 shrink-0" />
                </Button>
              </Hint>
            </div>
          </header>

          <div className="relative min-h-0 flex-1">
            {viewedChild ? (
              <AppPreview
                key={viewedChild.app_id}
                app={viewedChild}
                url={childAccess.session.data?.url ?? null}
                accessError={viewedChild.viewer_can_access === false || childAccess.session.isError}
                interactive
                className="absolute inset-0 size-full"
              />
            ) : preview ? (
              <AppPreview
                key={app.active_deployment_id ?? app.app_id}
                app={app}
                url={access.session.data?.url ?? null}
                accessError={!canAccess || access.session.isError}
                interactive
                className="absolute inset-0 size-full"
              />
            ) : null}
          </div>

          {versionsOpen ? (
            <div className="bg-muted/20 max-h-[40vh] shrink-0 overflow-y-auto border-t px-4 py-3">
              {/* One thing, so no `justify-between` row to hold it. Delete used
                  to sit on the right of this line: a destructive action parked
                  inside a history panel, reachable only by opening something
                  else. It lives in the header's overflow menu now.

                  The command is spelled out rather than hidden behind a copy
                  glyph — it is the only way a new version gets here, and a bare
                  icon made the reader guess what it would put on their
                  clipboard. */}
              <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
                <DeployCommand code={appCommand(app)} className="min-w-0" />
                {/* How this App runs and how much history it keeps: the facts
                    that explain what the list below can and cannot roll back to. */}
                <span className="text-muted-foreground text-xs">
                  {[
                    isStatic
                      ? tI18nComplete.raw('text903b49a91e18')
                      : isServer
                        ? tI18nComplete.raw('textaef7de28d529')
                        : null,
                    isServer
                      ? app.always_on
                        ? tI18nComplete.raw('text044ba8a9ae43')
                        : tI18nComplete.raw('text7be15cd189a3')
                      : null,
                    appCan(app, 'rollback') && app.retained_deployments !== undefined
                      ? tI18nComplete('text04957fa46a70', { value0: app.retained_deployments })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
              {appCan(app, 'machines') || appCan(app, 'volumes') ? (
                <Tabs value={panelTab} onValueChange={(value) => setPanelTab(value as typeof panelTab)} className="mb-2">
                  <TabsListCompact>
                    <TabsTriggerCompact value="releases">{tI18nComplete.raw('text1a6f7cae06cc')}</TabsTriggerCompact>
                    {appCan(app, 'machines') ? <TabsTriggerCompact value="machines">{tI18nComplete.raw('textc061da196eae')}</TabsTriggerCompact> : null}
                    {appCan(app, 'volumes') ? <TabsTriggerCompact value="volumes">{tI18nComplete.raw('text53a480e304c0')}</TabsTriggerCompact> : null}
                  </TabsListCompact>
                </Tabs>
              ) : null}
              {panelTab === 'machines' && appCan(app, 'machines') ? (
                <AppMachinesPanel projectId={projectId} app={app} canDeploy={canDeploy} />
              ) : panelTab === 'volumes' && appCan(app, 'volumes') ? (
                <AppVolumesPanel projectId={projectId} app={app} canDeploy={canDeploy} canAdmin={canAdmin} />
              ) : (
                <>
                {deployments.isLoading ? (
                  <Loading className="text-muted-foreground" />
                ) : deployments.data?.length ? (
                  <div className="space-y-1">
                    {deployments.data.map((deployment) => (
                      <DeploymentRow
                        key={deployment.deployment_id}
                        projectId={projectId}
                        deployment={deployment}
                        expanded={expandedId === deployment.deployment_id}
                        onToggle={() =>
                          setExpandedId((current) =>
                            current === deployment.deployment_id ? null : deployment.deployment_id,
                          )
                        }
                        active={deployment.deployment_id === app.active_deployment_id}
                        canDeploy={canDeploy && appCan(app, 'rollback')}
                        rollbackPending={deployments.rollback.isPending}
                        onRollback={async () => {
                          try {
                            await deployments.rollback.mutateAsync(deployment.deployment_id);
                            successToast(
                              tI18nComplete('text94c0f4d10610', { value0: deployment.version }),
                            );
                          } catch {
                            // Failure is already toasted by the query client's global mutations.onError.
                          }
                        }}
                      />
                    ))}
                  </div>
                ) : (
                  <p className="text-muted-foreground text-xs">
                    {tI18nComplete.raw('textf1fc77ca3b24')}
                  </p>
                )}
                </>
              )}
            </div>
          ) : null}
        </div>
      </ModalContent>

      <ConfirmDialog
        open={overlay === 'delete'}
        onOpenChange={(next) => setOverlay(next ? 'delete' : null)}
        title={tI18nComplete.raw('textd1b0a6e3985a')}
        description={tI18nComplete('textb7ddab3f7df8', { value0: app.name })}
        confirmLabel={tI18nComplete.raw('texte2d0a54968ea')}
        confirmVariant="destructive"
        isPending={apps.remove.isPending}
        onConfirm={async () => {
          try {
            await apps.remove.mutateAsync(app.app_id);
            setOverlay(null);
            // The App this modal is about no longer exists — close it, or the
            // frame keeps rendering a deleted App behind a dead action bar.
            onOpenChange(false);
            successToast(tI18nComplete('text84a4a73df826', { value0: app.name }));
          } catch {
            // Failure is already toasted by the query client's global mutations.onError.
          }
        }}
      />
      {overlay === 'connect' ? (
        <AppConnectDialog
          app={app}
          onOpenChange={(next) => setOverlay(next ? 'connect' : null)}
        />
      ) : null}
      {overlay === 'access' ? (
        <AppAccessModal
          projectId={projectId}
          app={app}
          access={access}
          open={overlay === 'access'}
          onOpenChange={(next) => setOverlay(next ? 'access' : null)}
        />
      ) : null}
    </Modal>
  );
}

function DeploymentRow({
  projectId,
  deployment,
  active,
  expanded,
  onToggle,
  canDeploy,
  rollbackPending,
  onRollback,
}: {
  projectId: string;
  deployment: AppDeployment;
  active: boolean;
  expanded: boolean;
  onToggle: () => void;
  canDeploy: boolean;
  rollbackPending: boolean;
  onRollback: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const appCopy = localizedAppCopy(tI18nComplete);
  const toggleLabel = expanded ? tI18nComplete.raw('text163de9edcec1') : tI18nComplete.raw('text34b66838fe48');
  return (
    <div>
      <div className="hover:bg-muted/40 flex items-center gap-3 rounded-md px-2 py-1.5">
        <Hint label={toggleLabel} side="top">
          <Button
            size="icon-xs"
            variant="ghost"
            className="shrink-0"
            aria-label={toggleLabel}
            aria-expanded={expanded}
            onClick={onToggle}
          >
            {expanded ? <CaretDownIcon className="size-3.5 shrink-0" /> : <CaretRightIcon className="size-3.5 shrink-0" />}
          </Button>
        </Hint>
        <span className="text-foreground w-8 shrink-0 font-mono text-xs tabular-nums">
          v{deployment.version}
        </span>
        {/* "Live" is the state of THIS version, so the active one says so and the
            rest report their own build outcome. Showing both — a `ready` badge
            and a separate "Live" word on the same row — said one thing twice. */}
        {/* An earlier ready version is not live: its Restore button says what it is. */}
        {active || deployment.status !== 'ready' ? (
          <Badge size="xs" variant={active ? 'success' : appCopy.deployment[deployment.status].tone}>
            {active ? appCopy.deployment.ready.label : appCopy.deployment[deployment.status].label}
          </Badge>
        ) : null}
        {/* Age, not `hosting_provider`. That field is the name of the sandbox
            fleet the build landed on ("daytona", "platinum") — infrastructure
            this reader neither chose nor can change, printed where the one fact
            they actually want ("when was this?") was missing. */}
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {relativeTime(deployment.created_at)}
        </span>
        {canDeploy && deployment.status === 'ready' && !active ? (
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0"
            disabled={rollbackPending}
            onClick={onRollback}
          >
            {rollbackPending ? (
              <Loading className="size-3.5 shrink-0" />
            ) : (
              <ClockCounterClockwiseIcon className="size-3.5 shrink-0" />
            )}
            {tI18nComplete.raw('texta76e13b98392')}
          </Button>
        ) : null}
      </div>
      {expanded ? <DeploymentLog projectId={projectId} deployment={deployment} /> : null}
    </div>
  );
}

/**
 * One deployment's events, build log included, as one block of text. A build
 * keeps at most 5,001 lines (apps/api/src/apps/build-log.ts), so one `pre`
 * renders it without a virtual list.
 */
function DeploymentLog({ projectId, deployment }: { projectId: string; deployment: AppDeployment }) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const detail = useAppDeployment(projectId, deployment.app_id, deployment.deployment_id);
  const events = detail.data?.events ?? [];
  const text = events
    .map((event) => (event.type === 'build_log' ? event.message : `[${event.type}] ${event.message}`))
    .join('\n');
  return (
    <div className="space-y-2 py-1 pr-2 pl-10">
      {deployment.error ? <p className="text-destructive text-xs">{deployment.error}</p> : null}
      {detail.isLoading ? (
        <Loading className="text-muted-foreground" />
      ) : detail.isError ? (
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text245c1e26ba4c')}</p>
      ) : text ? (
        <pre className="bg-popover text-foreground max-h-64 overflow-auto rounded-md border p-2 font-mono text-xs whitespace-pre-wrap">
          {text}
        </pre>
      ) : (
        <p className="text-muted-foreground text-xs">{tI18nComplete.raw('text80c652c4eeec')}</p>
      )}
    </div>
  );
}
