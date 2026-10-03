'use client';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import Hint from '@/components/ui/hint';

import Loading from '@/components/ui/loading';
import { Modal, ModalContent } from '@/components/ui/modal';

import { successToast } from '@/components/ui/toast';


import { useTranslations } from '@/i18n/use-translations';

import { relativeTime } from '@/lib/relative-time';

import { cn } from '@/lib/utils';
import { type App, type AppDeployment } from '@kortix/sdk';
import { useAppAccess, useAppDeployments, useProjectApps } from '@kortix/sdk/react';
import { ArrowSquareOutIcon, ClockCounterClockwiseIcon, DotsThreeIcon, LockKeyIcon, PauseIcon, PlayIcon, TrashIcon, XIcon } from '@phosphor-icons/react';

import { useState } from 'react';

import { AppPreview } from './app-preview';
import { AppAccessModal } from './app-access';
import { localizedAppCopy, appCommand, appHost, appStatus, deployNotice, DeployCommand } from './app-shared';

/**
 * The App, full screen, with its controls above it.
 *
 * Opening an App used to mean a new browser tab, which left Kortix behind and
 * lost every control the moment you arrived. The App now runs in place and the
 * actions that used to crowd the card sit in one bar over the top of it.
 */
export function AppDetailModal({
  projectId,
  app,
  canWrite,
  canDeploy,
  open,
  onOpenChange,
}: {
  projectId: string;
  app: App;
  canWrite: boolean;
  canDeploy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const appCopy = localizedAppCopy(tI18nComplete);
  const apps = useProjectApps(projectId);
  const deployments = useAppDeployments(projectId, app.app_id);
  const canAccess = app.viewer_can_access !== false;
  const access = useAppAccess(projectId, app.app_id, { policy: canWrite, session: canAccess });
  const [versionsOpen, setVersionsOpen] = useState(false);
  const [overlay, setOverlay] = useState<'access' | 'delete' | null>(null);
  const latest = deployments.data?.[0];
  const status = appStatus(app, tI18nComplete);
  const notice = deployNotice(latest, tI18nComplete);
  const running = app.desired_state === 'running';
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
              {/* One announcement, either way. The dot is `aria-hidden`, so the
                  running case needs a screen-reader-only label — but rendering
                  it unconditionally alongside the visible one made every
                  non-running state read its status out twice. */}
              {status.live ? (
                <span className="sr-only">{status.label}</span>
              ) : (
                <span className="text-muted-foreground shrink-0 text-xs">{status.label}</span>
              )}
              {notice ? (
                <Badge size="xs" variant={notice.tone} className="shrink-0">
                  {notice.label}
                </Badge>
              ) : null}
            </div>

            {/* Two registers, and the gap is what separates them: the App's own
                actions on the left, the window's Close on the right. Close was
                the fifth button inside the group, which made "stop this App"
                and "shut this panel" look like peers of each other. It is
                `ghost` for the same reason — chrome, not an action. */}
            <div className="flex shrink-0 items-center gap-2">
              <ButtonGroup>
                {canDeploy ? (
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
                    <DropdownMenuItem onClick={() => setVersionsOpen((value) => !value)}>
                      <ClockCounterClockwiseIcon className="size-3.5 shrink-0" />
                      {versionsOpen
                        ? tI18nComplete.raw('text26b1a7703eac')
                        : tI18nComplete.raw('text401dc1a55cb9')}
                    </DropdownMenuItem>
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
            <AppPreview
              key={app.active_deployment_id ?? app.app_id}
              app={app}
              url={access.session.data?.url ?? null}
              accessError={!canAccess || access.session.isError}
              interactive
              className="absolute inset-0 size-full"
            />
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
              <div className="mb-2 flex items-center gap-3">
                <DeployCommand code={appCommand(app)} className="min-w-0" />
              </div>
              {deployments.isLoading ? (
                <Loading className="text-muted-foreground" />
              ) : deployments.data?.length ? (
                <div className="space-y-1">
                  {deployments.data.map((deployment) => (
                    <DeploymentRow
                      key={deployment.deployment_id}
                      deployment={deployment}
                      active={deployment.deployment_id === app.active_deployment_id}
                      canDeploy={canDeploy}
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
  deployment,
  active,
  canDeploy,
  rollbackPending,
  onRollback,
}: {
  deployment: AppDeployment;
  active: boolean;
  canDeploy: boolean;
  rollbackPending: boolean;
  onRollback: () => void;
}) {
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const appCopy = localizedAppCopy(tI18nComplete);
  return (
    <div className="hover:bg-muted/40 flex items-center gap-3 rounded-md px-2 py-1.5">
      <span className="text-foreground w-8 shrink-0 font-mono text-xs tabular-nums">
        v{deployment.version}
      </span>
      {/* "Live" is the state of THIS version, so the active one says so and the
          rest report their own build outcome. Showing both — a `ready` badge
          and a separate "Live" word on the same row — said one thing twice. */}
      <Badge size="xs" variant={active ? 'success' : appCopy.deployment[deployment.status].tone}>
        {active ? appCopy.deployment.ready.label : appCopy.deployment[deployment.status].label}
      </Badge>
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
  );
}
