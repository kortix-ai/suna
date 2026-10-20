'use client';

import { Badge } from '@kortix/ui/badge';
import { Button } from '@kortix/ui/button';
import { ConfirmDialog } from '@kortix/ui/confirm-dialog';
import { CopyButton } from '@kortix/ui/markdown';
import Hint from '@kortix/ui/hint';

import Loading from '@kortix/ui/loading';
import { Modal, ModalBody, ModalContent, ModalDescription, ModalHeader, ModalTitle } from '@kortix/ui/modal';
import { SettingsRow, SettingsRowGroup } from '@kortix/ui/settings-row';
import {
  SplitSheet,
  SplitSheetBody,
  SplitSheetContent,
  SplitSheetDescription,
  SplitSheetFooter,
  SplitSheetHeader,
  SplitSheetMain,
  SplitSheetTitle,
} from '@kortix/ui/split-sheet';
import { Tabs, TabsList, TabsListCompact, TabsTrigger, TabsTriggerCompact } from '@kortix/ui/tabs';

import { Switch } from '@kortix/ui/switch';
import { successToast } from '@kortix/ui/toast';


import { useTranslations } from '@/i18n/use-translations';


import { cn } from '@kortix/ui';
import { type App, type AppDeployment } from '@kortix/sdk';
import { useAppAccess, useAppDeployments, useProjectApps } from '@kortix/sdk/react';
import { ArrowClockwiseIcon, ArrowSquareOutIcon, GearSixIcon, PauseIcon, PlayIcon, TrashIcon, XIcon } from '@phosphor-icons/react';

import { useCallback, useState } from 'react';

import {
  AppPreview,
  frameKey,
  reloadFrame,
  localizedAppCopy,
  appCan,
  appCommand,
  appHost,
  appStatus,
  appTabLabel,
  childApps,
  deployNotice,
} from '@kortix/ui/apps';
import { AppAccessModal } from './app-access';
import { AppConnectDialog } from './app-connect';
import { AppReleasesPanel } from './app-releases';
import { AppMachinesPanel, AppVolumesPanel } from './app-fleet';

/**
 * The App, full screen, with its controls above it.
 *
 * Opening an App used to mean a new browser tab, which left Kortix behind and
 * lost every control the moment you arrived. The App now runs in place under
 * a minimal bar: Refresh, Open, Settings, Close. Everything else sits in the
 * settings modal.
 *
 * The body and the capability rows of the settings follow `app.capabilities`:
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
  // Releases, logs, machines and volumes are operations data: the API answers
  // them only with `deploy`. No id, no request for anyone else.
  const deployments = useAppDeployments(projectId, canDeploy ? app.app_id : null);
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
  const [overlay, setOverlay] = useState<'settings' | 'access' | 'delete' | 'connect' | null>(null);
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
  const hasSettings = canWrite || (canDeploy && !app.external_url) || appCan(app, 'member_tokens');
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
    // Not modal: the view covers the whole window, so a scroll lock guards
    // nothing — and Radix's lock (react-remove-scroll) is known to swallow
    // wheel events over framed third-party content (radix-ui/primitives#1159).
    // The App would not scroll until a click put focus in it.
    <Modal modal={false} open={open} onOpenChange={onOpenChange}>
      <ModalContent
        side="fullscreen"
        animation="none"
        showCloseButton={false}
        // Nothing sits outside a full-screen view except toasts and the
        // settings dialogs; a click on one of those must not close the App.
        onInteractOutside={(event) => event.preventDefault()}
        // Focus the App itself, so it scrolls and takes keys at once. Radix
        // would focus the first action in the bar, and a focused icon button
        // shows its Hint over the controls. No frame yet: focus the dialog;
        // the frame focuses itself when it arrives (`PooledFrame`).
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          const content = event.currentTarget as HTMLElement | null;
          (content?.querySelector<HTMLElement>('iframe[data-testid="app-live-preview"]') ?? content)?.focus({ preventScroll: true });
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

            {/* Only what you reach for while using the App: Refresh, Open,
                Settings, Close. Sleep, versions, access, Connect and Delete
                are configuration, not navigation, so they live in the
                settings modal instead of crowding the bar over the App. */}
            <div className="flex shrink-0 items-center gap-0.5">
              {appCan(viewed, 'preview') && (viewed.active_deployment_id || viewed.external_url) ? (
                <Hint label={tI18nComplete.raw('text5b529abadacc')} side="bottom">
                  <Button
                    size="icon"
                    variant="ghost"
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
                  <Button asChild size="icon" variant="ghost">
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
              {hasSettings ? (
                <Hint label={tI18nComplete.raw('text74a883a037bc')} side="bottom">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={tI18nComplete.raw('text74a883a037bc')}
                    onClick={() => setOverlay('settings')}
                    data-testid="app-settings"
                  >
                    <GearSixIcon className="size-4 shrink-0" />
                  </Button>
                </Hint>
              ) : null}
              <span aria-hidden className="bg-border mx-1.5 h-4 w-px" />
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
            open={versionsOpen && canDeploy}
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
                <span className="text-muted-foreground shrink-0 text-xs">{tI18nComplete.raw('textb1a7e40c2d0b')}</span>
                <code className="text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs">{appCommand(app)}</code>
                <CopyButton code={appCommand(app)} size="sm" className="shrink-0" />
              </SplitSheetFooter>
            </SplitSheetContent>
          </SplitSheet>
        </div>
      </ModalContent>

      {/* Everything that configures the App rather than uses it. A row
          that opens another dialog hands the overlay over, so only one sits
          on top of the App at a time. */}
      <Modal open={overlay === 'settings'} onOpenChange={(next) => setOverlay(next ? 'settings' : null)}>
        <ModalContent className="lg:max-w-md" data-testid="app-settings-modal">
          <ModalHeader>
            <ModalTitle>{tI18nComplete.raw('text74a883a037bc')}</ModalTitle>
            <ModalDescription>{app.name}</ModalDescription>
          </ModalHeader>
          <ModalBody className="flex flex-col gap-4">
            <SettingsRowGroup>
              {canDeploy && canSleep ? (
                <SettingsRow label={tI18nComplete.raw('text920e413c7d41')} description={status.label}>
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={busy || !status.deployed}
                    onClick={() => lifecycle(running ? 'stop' : 'start')}
                  >
                    {busy ? (
                      <Loading className="size-3.5 shrink-0" />
                    ) : running ? (
                      <PauseIcon weight="fill" className="size-3.5 shrink-0" />
                    ) : (
                      <PlayIcon className="size-3.5 shrink-0" />
                    )}
                    {running ? tI18nComplete.raw('text6f50fb1f4f46') : tI18nComplete.raw('text971ed7129524')}
                  </Button>
                </SettingsRow>
              ) : null}
              {canWrite && canSleep ? (
                <SettingsRow label={tI18nComplete.raw('text044ba8a9ae43')} description={tI18nComplete.raw('text853696d5a64d')}>
                  <Switch
                    checked={app.always_on === true}
                    disabled={apps.update.isPending}
                    aria-label={tI18nComplete.raw('text044ba8a9ae43')}
                    onCheckedChange={(on) => apps.update.mutate({ appId: app.app_id, input: { always_on: on } })}
                  />
                </SettingsRow>
              ) : null}
              {canWrite ? (
                <SettingsRow label={tI18nComplete.raw('text407951d1c2e0')} description={appCopy.access[app.access_mode].label}>
                  <Button size="sm" variant="secondary" onClick={() => setOverlay('access')}>
                    {tI18nComplete.raw('text5a23444828db')}
                  </Button>
                </SettingsRow>
              ) : null}
              {/* An external App has no versions: Kortix never deploys it. */}
              {app.external_url || !canDeploy ? null : (
                <SettingsRow label={tI18nComplete.raw('text401dc1a55cb9')}>
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setOverlay(null);
                      setVersionsOpen(true);
                    }}
                  >
                    {tI18nComplete.raw('textdcc839a4015c')}
                  </Button>
                </SettingsRow>
              )}
              {/* Capability rows: only the Apps that offer them list them. */}
              {appCan(app, 'member_tokens') ? (
                <SettingsRow label={tI18nComplete.raw('text1a2303ede074')}>
                  <Button size="sm" variant="secondary" onClick={() => setOverlay('connect')}>
                    {tI18nComplete.raw('text0df6f1cad36c')}
                  </Button>
                </SettingsRow>
              ) : null}
            </SettingsRowGroup>
            {canWrite ? (
              <SettingsRowGroup>
                <SettingsRow label={tI18nComplete.raw('textd1b0a6e3985a')}>
                  <Button size="sm" variant="destructive" onClick={() => setOverlay('delete')}>
                    <TrashIcon className="size-3.5 shrink-0" />
                    {tI18nComplete.raw('texte2d0a54968ea')}
                  </Button>
                </SettingsRow>
              </SettingsRowGroup>
            ) : null}
          </ModalBody>
        </ModalContent>
      </Modal>
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
