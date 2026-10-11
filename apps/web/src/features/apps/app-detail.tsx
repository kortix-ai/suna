'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';
import { Input } from '@/components/ui/input';

import Loading from '@/components/ui/loading';
import { Modal, ModalContent } from '@/components/ui/modal';

import { errorToast, successToast } from '@/components/ui/toast';


import { useTranslations } from '@/i18n/use-translations';

import { relativeTime } from '@/lib/relative-time';

import { cn } from '@/lib/utils';
import { type App, type AppDeployment } from '@kortix/sdk';
import { useAppAccess, useAppDeployment, useAppDeployments, useProjectApps } from '@kortix/sdk/react';
import { ArrowSquareOutIcon, ArrowsOutSimpleIcon, CaretDownIcon, CaretRightIcon, ClockCounterClockwiseIcon, CurrencyDollarIcon, DotsThreeIcon, KeyIcon, LockKeyIcon, PauseIcon, PlayIcon, PlugsConnectedIcon, ArchiveIcon, TrashIcon, XIcon } from '@phosphor-icons/react';

import { useState } from 'react';

import { AppPreview } from './app-preview';
import { AppAccessModal } from './app-access';
import { AppBudgetModal } from './app-budget';
import { AppConnectDialog } from './app-connect';
import { AppDashboard } from './app-dashboard';
import { AppSnapshotsDialog, ResizeAppDialog, instanceOperationError } from './app-instance-dialogs';
import { localizedAppCopy, appCan, appCommand, appCostLabel, appHasBudget, appHost, appKindLabel, appSizeLabel, appStatus, deployNotice, DeployCommand } from './app-shared';

/**
 * The App, full screen, with its controls above it.
 *
 * Opening an App used to mean a new browser tab, which left Kortix behind and
 * lost every control the moment you arrived. The App now runs in place and the
 * actions that used to crowd the card sit in one bar over the top of it.
 *
 * Every kind shares this modal. The body and the capability items of the menu
 * follow `app.capabilities`: `preview` frames the App itself, `dashboard`
 * frames its admin dashboard, and Connect, Backups and Rotate admin key show
 * only for the Apps that offer them.
 */
export function AppDetailModal({
  projectId,
  app,
  canWrite,
  canDeploy,
  canAdmin,
  onOpenLinked,
  open,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  canWrite: boolean;
  canDeploy: boolean;
  /** `project.app.admin`: credentials, restore, rotation, and the delete of an App that holds data. */
  canAdmin: boolean;
  /** Open another App of the project by slug: the uses / used-by links in the header. */
  onOpenLinked: (slug: string) => void;
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
  // The deployment whose events and build log are unfolded in the version drawer.
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [overlay, setOverlay] = useState<
    'access' | 'delete' | 'budget' | 'resize' | 'snapshots' | 'connect' | 'rotate' | null
  >(null);
  // An App with snapshots holds data: its delete needs project.app.admin and
  // the slug typed back (the API answers 400 `confirmation_required` without it).
  const holdsData = appCan(app, 'snapshots');
  const [typedSlug, setTypedSlug] = useState('');
  const kind = appKindLabel(app, tI18nComplete);
  const instance = app.instance ?? null;
  // Size, snapshot and rotation need a running machine with no other operation in flight.
  const instanceIdle = instance?.status === 'running' && !instance.operation;
  const latest = deployments.data?.[0];
  const status = appStatus(app, tI18nComplete);
  const notice = deployNotice(latest, tI18nComplete);
  const running = app.desired_state === 'running';
  // A static App is served from storage: no runtime to start, stop or keep on.
  // `hosting_type` on the App is the source; the history covers an older server.
  const isStatic =
    app.hosting_type === 'static' ||
    deployments.data?.find((row) => row.deployment_id === app.active_deployment_id)?.hosting_type === 'static';
  // A web App with a runtime. An App with its own machine (`instance`) is always on and has no runtime to sleep.
  const isServer = status.deployed && !isStatic && !app.instance;
  const canSleep = appCan(app, 'sleep');
  const busy = apps.start.isPending || apps.stop.isPending || apps.remove.isPending;
  const liveUrl = access.session.data?.url ?? app.url;

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
        className="border-border bg-background! inset-0! h-dvh! max-h-none! min-h-dvh! w-auto! max-w-none! translate-x-0! translate-y-0! gap-0! space-y-0! overflow-hidden! rounded-none! border-0! focus:outline-none focus-visible:outline-none md:inset-4! md:h-auto! md:min-h-0! md:rounded-md! md:border!"
        aria-label={`${app.name} App`}
      >
        <div className="flex h-full min-h-0 flex-col">
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
              {kind ? (
                <Badge variant="outline" className="shrink-0">
                  {kind}
                </Badge>
              ) : null}
              {/* One announcement, either way. The dot is `aria-hidden`, so the
                  running case needs a screen-reader-only label — but rendering
                  it unconditionally alongside the visible one made every
                  non-running state read its status out twice. */}
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
              {/* How this App connects to the others: the Apps it uses (its
                  code mints their sign-in tokens and binds them) and the Apps
                  that use it. Each slug opens that App. */}
              <AppLinks label={tI18nComplete.raw('text9e6151acb057')} slugs={app.uses} onOpen={onOpenLinked} />
              <AppLinks label={tI18nComplete.raw('text681bf81aba87')} slugs={app.used_by} onOpen={onOpenLinked} />
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
                {preview ? (
                  <Hint
                    label={tI18nComplete('text06ce842278f6', { value0: appHost(app.url) })}
                    side="bottom"
                  >
                    <Button asChild size="icon" variant="outline">
                      <a
                        href={liveUrl}
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
                    {canWrite && instance ? (
                      <DropdownMenuItem disabled={!instanceIdle} onClick={() => setOverlay('resize')}>
                        <ArrowsOutSimpleIcon className="size-3.5 shrink-0" />
                        {tI18nComplete.raw('text5ad9ba3657f2')}
                        <span className="text-muted-foreground ml-auto pl-3 text-xs tabular-nums">
                          {[appCostLabel(app, tI18nComplete), appSizeLabel(app, tI18nComplete)].filter(Boolean).join(' · ')}
                        </span>
                      </DropdownMenuItem>
                    ) : null}
                    {canWrite && appHasBudget(app) ? (
                      <DropdownMenuItem onClick={() => setOverlay('budget')}>
                        <CurrencyDollarIcon className="size-3.5 shrink-0" />
                        {tI18nComplete.raw('textc247593b2c0f')}
                        <span className="text-muted-foreground ml-auto pl-3 text-xs tabular-nums">
                          ${app.monthly_budget_usd}
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
                          <span className="text-muted-foreground text-xs">{tI18nComplete.raw('textb2fceee88a51')}</span>
                        </span>
                        {isServer && app.estimated_monthly_usd ? (
                          <span className="text-muted-foreground ml-auto pl-3 text-xs tabular-nums">
                            {tI18nComplete('texte15cb9ffae7f', { value0: Math.round(app.estimated_monthly_usd) })}
                          </span>
                        ) : null}
                      </DropdownMenuCheckboxItem>
                    ) : null}
                    <DropdownMenuItem onClick={() => setVersionsOpen((value) => !value)}>
                      <ClockCounterClockwiseIcon className="size-3.5 shrink-0" />
                      {versionsOpen
                        ? tI18nComplete.raw('text26b1a7703eac')
                        : tI18nComplete.raw('text401dc1a55cb9')}
                    </DropdownMenuItem>
                    {/* Capability items: only the Apps that offer them list them. */}
                    {appCan(app, 'admin_credentials') ? (
                      <DropdownMenuItem
                        disabled={instance?.status !== 'running'}
                        onClick={() => setOverlay('connect')}
                      >
                        <PlugsConnectedIcon className="size-3.5 shrink-0" />
                        {tI18nComplete.raw('textc0e20f6d5a3a')}
                      </DropdownMenuItem>
                    ) : null}
                    {holdsData ? (
                      <DropdownMenuItem
                        disabled={instance?.status !== 'running'}
                        onClick={() => setOverlay('snapshots')}
                      >
                        <ArchiveIcon className="size-3.5 shrink-0" />
                        {tI18nComplete.raw('textf0e800ed571e')}
                      </DropdownMenuItem>
                    ) : null}
                    {canAdmin && appCan(app, 'admin_credentials') ? (
                      <DropdownMenuItem disabled={!instanceIdle} onClick={() => setOverlay('rotate')}>
                        <KeyIcon className="size-3.5 shrink-0" />
                        {tI18nComplete.raw('text0aeabb927ead')}
                      </DropdownMenuItem>
                    ) : null}
                    {(holdsData ? canAdmin : canWrite) ? (
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
            {preview ? (
              <AppPreview
                key={app.active_deployment_id ?? app.app_id}
                app={app}
                url={access.session.data?.url ?? null}
                accessError={!canAccess || access.session.isError}
                interactive
                className="absolute inset-0 size-full"
              />
            ) : appCan(app, 'dashboard') ? (
              <AppDashboard projectId={projectId} app={app} canAdmin={canAdmin} />
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
                      : instance
                        ? tI18nComplete.raw('text044ba8a9ae43')
                        : null,
                    appHasBudget(app) ? tI18nComplete('text89ea53a8d7ac', { value0: app.monthly_budget_usd }) : appCostLabel(app, tI18nComplete),
                    instance ? appSizeLabel(app, tI18nComplete) : null,
                    appCan(app, 'rollback') && app.retained_deployments !== undefined
                      ? tI18nComplete('text04957fa46a70', { value0: app.retained_deployments })
                      : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </div>
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
            </div>
          ) : null}
        </div>
      </ModalContent>

      <ConfirmDialog
        open={overlay === 'delete'}
        onOpenChange={(next) => {
          setOverlay(next ? 'delete' : null);
          setTypedSlug('');
        }}
        title={tI18nComplete.raw('textd1b0a6e3985a')}
        description={
          holdsData ? (
            <div className="space-y-3">
              <p>{tI18nComplete('textd115556499fb', { value0: app.name, value1: app.slug })}</p>
              <Input
                value={typedSlug}
                onChange={(event) => setTypedSlug(event.target.value)}
                placeholder={app.slug}
                aria-label={tI18nComplete.raw('textd15387ecc6c5')}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          ) : (
            tI18nComplete('textb7ddab3f7df8', { value0: app.name })
          )
        }
        confirmLabel={tI18nComplete.raw('texte2d0a54968ea')}
        confirmVariant="destructive"
        confirmDisabled={holdsData && typedSlug !== app.slug}
        isPending={apps.remove.isPending}
        onConfirm={async () => {
          try {
            await apps.remove.mutateAsync(holdsData ? { appId: app.app_id, confirm: typedSlug } : app.app_id);
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
      <ConfirmDialog
        open={overlay === 'rotate'}
        onOpenChange={(next) => !apps.rotateCredentials.isPending && setOverlay(next ? 'rotate' : null)}
        title={tI18nComplete.raw('text8c62d9c111ea')}
        description={tI18nComplete.raw('text90ea74fd007b')}
        confirmLabel={tI18nComplete.raw('text0aeabb927ead')}
        isPending={apps.rotateCredentials.isPending}
        onConfirm={async () => {
          try {
            await apps.rotateCredentials.mutateAsync(app.app_id);
            successToast(tI18nComplete.raw('text3f2bcc63b01e'));
          } catch (error) {
            errorToast(instanceOperationError(error, tI18nComplete.raw('text6dab22ece77e'), tI18nComplete));
          }
          setOverlay(null);
        }}
      />
      {overlay === 'resize' ? (
        <ResizeAppDialog projectId={projectId} app={app} onOpenChange={(next) => setOverlay(next ? 'resize' : null)} />
      ) : null}
      {overlay === 'snapshots' ? (
        <AppSnapshotsDialog
          projectId={projectId}
          app={app}
          canWrite={canWrite}
          canRestore={canAdmin && appCan(app, 'restore')}
          onOpenChange={(next) => setOverlay(next ? 'snapshots' : null)}
        />
      ) : null}
      {overlay === 'connect' ? (
        <AppConnectDialog
          projectId={projectId}
          app={app}
          canAdmin={canAdmin}
          onOpenChange={(next) => setOverlay(next ? 'connect' : null)}
        />
      ) : null}
      {overlay === 'budget' ? (
        <AppBudgetModal
          projectId={projectId}
          app={app}
          open
          onOpenChange={(next) => setOverlay(next ? 'budget' : null)}
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

/** "Uses db, auth": the linked Apps by slug, each one a button that opens it. Nothing when there are none. */
function AppLinks({ label, slugs, onOpen }: { label: string; slugs?: string[]; onOpen: (slug: string) => void }) {
  if (!slugs?.length) return null;
  return (
    <span className="text-muted-foreground hidden shrink-0 items-center gap-1 text-xs md:flex">
      {label}
      {slugs.map((slug) => (
        <Button key={slug} size="xs" variant="ghost" onClick={() => onOpen(slug)}>
          {slug}
        </Button>
      ))}
    </span>
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
