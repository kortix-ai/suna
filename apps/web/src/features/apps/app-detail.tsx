'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { CopyButton } from '@/components/markdown/copy-button';
import Hint from '@/components/ui/hint';

import Loading from '@/components/ui/loading';
import { Modal, ModalContent } from '@/components/ui/modal';
import {
  SplitSheet,
  SplitSheetBody,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetMain,
  SplitSheetTitle,
} from '@/components/ui/split-sheet';
import { Tabs, TabsList, TabsListCompact, TabsTrigger, TabsTriggerCompact } from '@/components/ui/tabs';

import { successToast } from '@/components/ui/toast';


import { useTranslations } from '@/i18n/use-translations';


import { cn } from '@/lib/utils';
import { type App, type AppDeployment } from '@kortix/sdk';
import { useAppAccess, useAppDeployments, useProjectApps } from '@kortix/sdk/react';
import { ArrowClockwiseIcon, ArrowSquareOutIcon, ClockCounterClockwiseIcon, DotsThreeIcon, LightningIcon, LockKeyIcon, PauseIcon, PlayIcon, PlugsConnectedIcon, TrashIcon, XIcon } from '@phosphor-icons/react';

import { useCallback, useState } from 'react';

import { AppPreview } from './app-preview';
import { frameKey, reloadFrame } from './app-preview-pool';
import { AppAccessModal } from './app-access';
import { AppConnectDialog } from './app-connect';
import { AppReleasesPanel } from './app-releases';
import { AppMachinesPanel, AppVolumesPanel } from './app-fleet';
import { localizedAppCopy, appCan, appCommand, appHost, appStatus, appTabLabel, childApps, deployNotice } from './app-shared';

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
  // The deployment whose log the header's failure badge asked to unfold. The
  // list owns the unfolded row itself, so a click there re-renders the list,
  // not this modal and the live App frame under it.
  const [logFocusId, setLogFocusId] = useState<string | null>(null);
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

  const rollback = deployments.rollback.mutateAsync;
  const onRollback = useCallback(
    async (deployment: AppDeployment) => {
      try {
        await rollback(deployment.deployment_id);
        successToast(tI18nComplete('text94c0f4d10610', { value0: deployment.version }));
      } catch {
        // Failure is already toasted by the query client's global mutations.onError.
      }
    },
    [rollback, tI18nComplete],
  );

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
                    setLogFocusId(latest.deployment_id);
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
                      variant="secondary"
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
                {appCan(viewed, 'preview') && (viewed.active_deployment_id || viewed.external_url) ? (
                  <Hint label={tI18nComplete.raw('text5b529abadacc')} side="bottom">
                    <Button
                      size="icon"
                      variant="secondary"
                      disabled={refreshing}
                      aria-label={tI18nComplete.raw('text5b529abadacc')}
                      onClick={() => void refresh()}
                      data-testid="app-preview-refresh"
                    >
                      {refreshing ? <Loading className="size-4 shrink-0" /> : <ArrowClockwiseIcon className="size-4 shrink-0" />}
                    </Button>
                  </Hint>
                ) : null}
                {appCan(viewed, 'preview') || viewed.external_url ? (
                  <Hint
                    label={tI18nComplete('text06ce842278f6', { value0: appHost(viewed.url) })}
                    side="bottom"
                  >
                    <Button asChild size="icon" variant="secondary">
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
                      variant="secondary"
                      aria-label={tI18nComplete.raw('textf8d46c2570e7')}
                    >
                      <DotsThreeIcon className="size-4 shrink-0" />
                    </Button>
                  </DropdownMenuTrigger>
                  {/* What you look at, then what you change, then what you
                      cannot undo. Every row leads with its glyph so the labels
                      share one left edge. */}
                  <DropdownMenuContent align="end" className="w-60">
                    {/* An external App has no versions: Kortix never deploys it. */}
                    {app.external_url ? null : (
                      <DropdownMenuItem onClick={() => setVersionsOpen((value) => !value)}>
                        <ClockCounterClockwiseIcon className="size-3.5 shrink-0" />
                        {versionsOpen
                          ? tI18nComplete.raw('text26b1a7703eac')
                          : tI18nComplete.raw('text401dc1a55cb9')}
                      </DropdownMenuItem>
                    )}
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
                        <DropdownMenuItem onClick={() => setOverlay('access')}>
                          <LockKeyIcon className="size-3.5 shrink-0" />
                          {tI18nComplete.raw('text407951d1c2e0')}
                          {/* The current value, on the row that changes it. */}
                          <span className="text-muted-foreground ml-auto pl-3 text-xs">
                            {appCopy.access[app.access_mode].label}
                          </span>
                        </DropdownMenuItem>
                        {canSleep ? (
                          <DropdownMenuCheckboxItem
                            reverse
                            checked={app.always_on === true}
                            disabled={apps.update.isPending}
                            title={tI18nComplete.raw('text853696d5a64d')}
                            onCheckedChange={(on) =>
                              apps.update.mutate({ appId: app.app_id, input: { always_on: on } })
                            }
                          >
                            <LightningIcon className="size-3.5 shrink-0" />
                            {tI18nComplete.raw('text044ba8a9ae43')}
                          </DropdownMenuCheckboxItem>
                        ) : null}
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

          {/* Earlier versions take a column beside the App instead of a
              drawer under it: the App narrows and stays live, and the list
              gets the full height to scroll. */}
          <SplitSheet
            open={versionsOpen}
            onOpenChange={setVersionsOpen}
            size="lg"
            className="h-auto min-h-0 flex-1"
          >
            <SplitSheetMain className="relative overflow-hidden">
            {viewedChild ? (
              <AppPreview
                key={viewedChild.app_id}
                app={viewedChild}
                url={childAccess.session.data?.url ?? null}
                accessError={viewedChild.viewer_can_access === false || childAccess.session.isError}
                interactive
                className="absolute inset-0 size-full"
              />
            ) : preview || app.external_url ? (
              <AppPreview
                key={app.active_deployment_id ?? app.app_id}
                app={app}
                url={access.session.data?.url ?? null}
                accessError={!canAccess || access.session.isError}
                interactive
                className="absolute inset-0 size-full"
              />
            ) : null}
            </SplitSheetMain>
            <SplitSheetContent>
              <SplitSheetHeader closeLabel={tI18nComplete.raw('text7d9eb7acb13e')}>
                <SplitSheetTitle>{tI18nComplete.raw('text401dc1a55cb9')}</SplitSheetTitle>
                {/* How this App runs and how much history it keeps: the facts
                    that explain what the list below can and cannot roll back to. */}
                <SplitSheetDescription>
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
                </SplitSheetDescription>
              </SplitSheetHeader>
              <SplitSheetBody className="flex flex-col gap-5 pt-3">
                {appCan(app, 'machines') || appCan(app, 'volumes') ? (
                  <Tabs value={panelTab} onValueChange={(value) => setPanelTab(value as typeof panelTab)}>
                    <TabsList>
                      <TabsTrigger value="releases">{tI18nComplete.raw('text1a6f7cae06cc')}</TabsTrigger>
                      {appCan(app, 'machines') ? <TabsTrigger value="machines">{tI18nComplete.raw('textc061da196eae')}</TabsTrigger> : null}
                      {appCan(app, 'volumes') ? <TabsTrigger value="volumes">{tI18nComplete.raw('text53a480e304c0')}</TabsTrigger> : null}
                    </TabsList>
                  </Tabs>
                ) : null}
                {panelTab === 'machines' && appCan(app, 'machines') ? (
                  <AppMachinesPanel projectId={projectId} app={app} canDeploy={canDeploy} />
                ) : panelTab === 'volumes' && appCan(app, 'volumes') ? (
                  <AppVolumesPanel projectId={projectId} app={app} canDeploy={canDeploy} canAdmin={canAdmin} />
                ) : deployments.isLoading ? (
                  <Loading className="text-muted-foreground" />
                ) : (
                  <AppReleasesPanel
                    key={logFocusId ?? 'list'}
                    projectId={projectId}
                    app={app}
                    deployments={deployments.data ?? []}
                    serving={status.live}
                    initialExpandedId={logFocusId}
                    canRollback={canDeploy && appCan(app, 'rollback')}
                    rollbackPending={deployments.rollback.isPending}
                    onRollback={onRollback}
                  />
                )}
              </SplitSheetBody>
              {/* The only way a new version gets here: one quiet line at the
                  foot of the sheet, not a box competing with the list. */}
              <SplitSheetFooter className="flex-nowrap justify-start gap-2 py-2">
                <span className="text-muted-foreground/70 shrink-0 text-xs">{tI18nComplete.raw('textb1a7e40c2d0b')}</span>
                <code className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">{appCommand(app)}</code>
                <CopyButton code={appCommand(app)} size="sm" className="shrink-0" />
              </SplitSheetFooter>
            </SplitSheetContent>
          </SplitSheet>
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
